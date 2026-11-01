---
name: audit-regal-pz-period
description: Full-history audit for regal-pz — pull every PlusMinus document family over its /mobile API (invoices incl. annulments, receipts, transfers-out, write-offs, the stock snapshot), prove which are in LGR and which are not, book what is genuinely missing without double-counting, repair invoices whose content drifted, and true LGR's stock up to the snapshot. Use whenever the user wants to check regal-pz's documents or stock differences for a period, re-verify the daily cadence, or close out accumulated drift. The regal-pz counterpart of audit-regal-sf-period.
allowed-tools: Bash(bun:*)
---

# Audit regal-pz for a period

Same five-step cycle as `audit-regal-sf-period` (pull → audit → import → reconcile → true up), but regal-pz
is not regal-sf with a different slug. Read the differences first; most of this skill is about them.

| | regal-sf | **regal-pz** |
|---|---|---|
| Reach PlusMinus | through a tunnel | directly (a plain `curl -sk` of the server answers; if not, check the VPN) |
| Till (cash register) | `storeOperations` documents in the API | **not in the API** — only the `salesAnalysis` report from the GUI |
| Invoice families | `-ФЕ` | `-ФЕ` **and `-ФЕА`** (an annulment: same number, negative sum) |
| Other families | none | receipts `СТ`, transfers-out `СР`, write-offs `СИ` |
| Baseline | opened 2026-09-30 | **quantities were re-baselined on 2026-07-30**: documents dated on/before it are already inside LGR's numbers |
| Staff also type in LGR | no | yes — hand-entered invoices exist under `INV-2026-<PlusMinus number>` |
| Trading days | Mon–Sat | Mon–Fri |

Backed by `.claude/skills/pull-plusminus-api/pull-api.ts` (pull), `scripts/audit-coverage-api.ts` (audit),
`scripts/receive-stock-api.ts` / `transfer-stock-api.ts` / `adjust-stock-api.ts` /
`import-sales-invoices-api.ts` / `repair-invoices-from-plusminus.ts` (book and repair),
`scripts/compare-stock-api.ts` / `true-up-stock-api.ts` (reconcile).

## 0. Credentials

LGR: `LGR_USERNAME`/`LGR_PASSWORD` (or `LGR_TOKEN`) for regal-pz. With no live account, create a throwaway
one and drop it at the end — memory `lgr-temp-service-account` (and see its 2026-11-01 note on ssh/bun).
PlusMinus: the credentials file named in `pull-plusminus-api/orgs.ts`; the puller **never evicts** the store's
own session — exit code 3 means someone is logged in, ask, do not retry in a loop.

```bash
set -a && source .secrets/lgr-session.env && set +a   # before every step below
export MSYS_NO_PATHCONV=1                              # Git Bash rewrites an argument that starts with /
```

## 1. Pull — in monthly chunks, the snapshot last

A whole history is ~40 seconds of API time, but a failure restarts a chunk, so go month by month. The
snapshot comes from the LAST chunk (or its own folder), so it is the freshest thing you hold.

```bash
P=.claude/skills/pull-plusminus-api/pull-api.ts
bun $P --org regal-pz --from 2026-07-21 --to 2026-08-31 --no-snapshot
bun $P --org regal-pz --from 2026-09-01 --to 2026-09-30 --no-snapshot
bun $P --org regal-pz --from 2026-10-01 --to <today>                # + storeAvailability_<date>.json
```

Read the console: a `GAPS:` suffix is a hole in PlusMinus's own numbering (investigate); the line
`+ N secondary-type doc(s), written as <prefix>_<N>.<tag>.json` lists the `-ФЕА` annulments.

⚠ **`-ФЕА` shares its invoice's number.** A `pull-api.ts` that writes both to `invoicem_<N>.json` silently
overwrites the invoice with its own annulment (manifest state `REPLACED`, fewer files than documents). The
current puller writes the annulment as `invoicem_<N>.fea.json`, which the invoice importer's strict
`^invoicem_(\d+)\.json$` never matches. If your copy predates that, fix it before trusting a pull.

⚠ **Never select documents by date alone.** PlusMinus accepts documents entered today with a date weeks back
(receipts numbered 626–633 were dated 11-01 and 10-23/24). A day-by-day pull of 10-23 made on 10-23 cannot
contain them. Audit by NUMBER, over the whole range.

## 2. Audit (read-only)

```bash
R=<_docs/regal-pz>   # the folders step 1 wrote
bun run scripts/audit-coverage-api.ts --org regal-pz --dir "$R/<chunk1>/api,$R/<chunk2>/api,$R/<chunk3>/api" \
  --baseline 2026-07-30 --snapshot "$R/<last>/api/storeAvailability_<date>.json" --lines
```

| Section | What to do with it |
|---|---|
| 1 INVOICES `not under that number` → `hand-entered` | Expected (staff type in LGR too). They carry `INV-2026-<same number>` and **no reference**. Leave them. The invoice importer now recognises that shape and skips them (`entered by hand in LGR as … — skip`); an older importer saw all 64 as NEW and a whole-folder run would have dispatched them twice. Never force with `--include-hand-entered`. |
| …→ `DRAFT` | An unissued draft of a PlusMinus number (a blocked Files/OCR import). Fix its blocker, then issue it — §4c. |
| …→ `MISSING` | Really absent. `import-sales-invoices-api.ts --only <n> --convert`. |
| `DIFF` | Total or line count differs from the document — §4d. Sub-3-cent rounding and the credit-note sign are counted separately and are fine. |
| `annulments … STILL LIVE` | Report. A `paid` invoice cannot be voided through the API (see §6). |
| 2 `post-baseline` unbooked | Book them, §4a–b. |
| 2 `pre-baseline` unbooked | **Do not book with stock.** Section 4 must show them `ALREADY`; any other class there is worth a look. |
| 2 `price-only/empty` | Price restatements with no quantity — nothing to book for stock. (Prices are not audited here.) |
| 3 TILL DAYS | Trading days with no cash-sale document: needs the GUI export, §5. |
| 4 GUARD | For each unbooked document line: `EXACT`/`PARTIAL` book it; `ALREADY` booking would create drift; `CONTRA` the document is real but something else is off on that product too (the true-up settles it). |
| 5 DRIFT | PlusMinus lets staff edit a booked document in place; LGR keeps the original. Expect dozens of lines. The true-up absorbs them. |

## 3. Why a late-found document can double-count — the one rule

LGR's quantities were SET to PlusMinus's snapshot on 2026-07-30 and have been kept by documents since. A
document dated on/before that day is already inside the numbers; booking it again removes or adds its goods a
second time. Likewise anything a later true-up absorbed. **Book a document only when section 4 says the
product is currently off in the direction the document would move it.**

## 4. Book and repair — dry-run each, read every line, then `--execute`

**a. Receipts** — `receive-stock-api.ts --dir <chunk> --only <numbers>`. A receipt also REPRICES its products,
so book in date-then-number order, and if an older receipt shares a product with a newer one that is already
in, re-run the newer one afterwards (its quantity is skipped by marker; only its prices re-apply). Do not
re-run a booked document whose products a still-newer document also touched.

**b. Transfers / write-offs** — `transfer-stock-api.ts` and `adjust-stock-api.ts`, both with `--only`.
⚠ Their "already booked" check reads the document NUMBER out of the movement notes (`lib/doc-marker.ts`):
the PDF-era flow wrote `sklrazp:0000012705`, the API flow writes `sklrazp:12705`. Before 2026-11-01 a
substring check missed the padded form, and the dry-run said "book 56" for a month in which 3 were missing.
**Always read the dry-run's `Would book:` count against the audit's list before `--execute`.**

**c. An unissued draft of a PlusMinus number** — `POST /doc-import/convert {target:'sales_invoice', ids:[…]}`
issues it as `INV-<number>` and dispatches stock. It refuses, correctly, while a line has a quantity but no
product (an aliased line — see pitfalls); link that line with `PUT /invoices/:id {lines:[…]}`, then convert.

**d. Content drift** — `repair-invoices-from-plusminus.ts --dir <union of the pulls> --only <numbers>`
(dry-run default). It reuses the importer's own mapping and applies contact, lines and totals onto the
existing invoice. It moves **no stock and re-posts nothing**; the stock a wrong invoice dispatched is settled
by the true-up. It refuses `paid` invoices whose total would change.

## 5. The till

Not in the API. The daily path is the `salesAnalysis_*.xlsx` report (skill `import-cash-register-sales`,
exported with `pull-plusminus-docs`). The audit only tells you WHICH days are missing; their stock effect is
already handled by the true-up, their revenue is not. (`posDocuments` accepts the six-argument form that
`documents` uses but returns nothing for any option set tried; `posCashboxLastClosing` works and returns the
last cash-box closing. Neither is a till feed.)

## 6. Reconcile and true up

```bash
bun run scripts/compare-stock-api.ts --org regal-pz --dir "$R/<last>/api"                       # read-only
bun run scripts/true-up-stock-api.ts --org regal-pz --snapshot <file> --date <YYYY-MM-DD> --zero-lgr-only   # preview
bun run scripts/true-up-stock-api.ts … --execute
bun run scripts/compare-stock-api.ts …                                                          # must say 0
```

PlusMinus is the arbiter. Two kinds of movement, each tagged `snapshot-reconcile:<date>` and reversible by
that marker: the matched-product adjustments, and — with `--zero-lgr-only` — a separate `:lgr-only` batch for
products LGR still holds that PlusMinus **no longer has at all** (cleaned out of its item list, no document;
confirm against the GUI "Наличност" report, which showed none of them either). The flag refuses a snapshot under
80 % of LGR's product count, leaves alone an article that exists under another spelling and that no other LGR
product holds, and zeroes a duplicate fork (`Р` Cyrillic vs `P` Latin) whose twin is already matched.
Take a fresh snapshot just before; a true-up against a stale one books yesterday's truth.

⚠ A large decrease is usually one absurd opening balance. Read the cost column before executing.

An annulled **paid** invoice stays live in LGR (its stock is corrected by the true-up, its revenue is not).
That is a person's call: it needs the payment undone first.

## 7. Pitfalls this audit paid for

- **`name` is an alias, `item` is the article.** Stock-document mappers now take identity from `item`
  (`map-plusminus-line.ts`); an aliased INVOICE line is repaired by linking the product, never by renaming
  the printed text.
- A write-off line with no `sum` counts as zero value (PlusMinus's own header total omits it); a
  decimal-comma price is common.
- A movement names its document in both notes and reference — count it once.
- Homoglyphs (Latin `K`, `P`, `X` for Cyrillic) fork products; compare on folded names, never create from them.
- `ssh`/`bun`/path-conversion traps are in memory `lgr-temp-service-account`.

## 8. Clean up

Drop the throwaway LGR account and verify a login now answers 401. Nothing else was left running: regal-pz needs
no tunnel.

## Known baseline (2026-11-01, range 2026-07-21 … 2026-11-01)

1 347 invoices: 1 283 as `INV-<n>`, 64 hand-entered, 0 missing; 543 receipts, 174 transfers, 7 write-offs —
22 post-baseline documents had never been booked (several found only by number: backdated); all pre-baseline
ones correctly `ALREADY`. Stock: 485 matched-product differences → 298 after the documents → **0** after the
true-up, 129 products PlusMinus no longer carries zeroed. Open: 2 annulled-but-live invoices, 3 trading days
without a cash-sale document, one −0.005 float residue on a service item.
