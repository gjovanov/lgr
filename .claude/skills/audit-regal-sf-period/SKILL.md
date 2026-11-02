---
name: audit-regal-sf-period
description: Full-history audit for regal-sf — pull every PlusMinus doc type for a date range (invoices, stock receipts, cash-register/till, the stock snapshot), confirm each is imported into LGR, reconcile LGR's stock against the snapshot, and true up any residual quantity gap. Use whenever the user wants to check regal-sf's docs/diffs for a period, re-verify the daily cadence kept up, or close out a backlog of quantity drift.
allowed-tools: Bash(bun:*), Bash(roomler:*)
---

# Audit regal-sf for a period

> regal-pz is **not** this cycle with another slug (no tunnel, no till in the API, annulments, a quantity
> baseline, hand-entered invoices): see `audit-regal-pz-period`. Its read-only audit tool,
> `scripts/audit-coverage-api.ts`, was written against regal-pz and has not been run on regal-sf yet.

Backed by `.claude/skills/pull-plusminus-api/pull-api.ts` (pull) +
`scripts/import-sales-invoices-api.ts` / `scripts/import-cash-register-sales-api.ts` /
`scripts/receive-stock-api.ts` (import, all already-proven, all idempotent) +
`scripts/compare-stock-api.ts` / `scripts/true-up-stock-api.ts` (reconcile — new, see below).

Runs the same five-step cycle the daily regal-sf cadence already does, but over an
arbitrary date RANGE in one pass instead of day-by-day, so it can also answer "is
everything since day one actually in LGR?" Proven 2026-10-31 on the full month
(2026-10-01 .. 2026-10-31, 1100 invoices / 233 receipts / 957 till transactions / 26.7k
snapshot rows) — everything was already imported; the only real finding was 50 residual
quantity diffs on already-matched products, trued up in one pass.

## 0. Credentials

Needs `LGR_USERNAME`/`LGR_PASSWORD` (or `LGR_TOKEN`) for the target org, and PlusMinus
credentials for the pull. If `.secrets/lgr-session.env` has no live account, create a
throwaway one — see memory `lgr-temp-service-account` — and drop it when done:

```bash
# on mars, via the usual seed-user recipe (regal-sf org)
bun run scripts/seed-user.ts --org regal-sf --email jamesbond007@lgr.internal --username jamesbond \
  --password "$(openssl rand -hex 16)" --first James --last Bond --role admin --execute
```

```bash
set -a && source .secrets/lgr-session.env && set +a   # before every step below
```

## 1. Pull everything for the range

regal-sf's PlusMinus is only reachable through a tunnel to its till PC
(`Regal-Dechko-SO`), which **can drop mid-pull** on a long range (seen both on
2026-10-27 and again today, ECONNRESET) — if a family fails partway, just re-forward
and re-run with `--families <whatever didn't finish>`; already-written files are
skipped (content-addressed, see `pull-api.ts`'s manifest).

```bash
roomler forward --agent 6a687648c8141b25961ebde6 --local 17000 --remote 192.168.0.103:7000 --daemon
bun .claude/skills/pull-plusminus-api/pull-api.ts --org regal-sf --base-url https://127.0.0.1:17000 \
  --from <YYYY-MM-DD> --to <YYYY-MM-DD>
roomler kill fl-N   # fl-N from `roomler flows`, once done
```

Output lands at `_docs/regal-sf/<from>_<to>/api/` (see that skill's own SKILL.md for the
exact path). The console summary per family already tells you most of what you need:
a `GAPS:` suffix on the `invoicem`/`stokrazp`/`storeOperations` line means PlusMinus's
own numbering has a hole — investigate before importing, same as `check-doc-sequences`.
regal-sf has **no `sklrazp` family at all** (confirmed zero documents, ever — it is not
in `orgs.ts`'s family list for this org) — that's expected, not a gap.

## 2. Import — till BEFORE invoices, every time

All three importers are **idempotent**: an already-imported day/invoice/receipt is
reported and skipped, never double-booked. Running them against a range that's
mostly-already-imported is safe and cheap (a report, not a rewrite) — that's the whole
point of this skill.

```bash
DIR="<the api/ dir from step 1>"
# a) till/cash-register FIRST — invoice import's own till-overlap gate needs this already committed
bun run scripts/import-cash-register-sales-api.ts --dir "$DIR" --org regal-sf
# b) sales invoices
bun run scripts/import-sales-invoices-api.ts --dir "$DIR" --org regal-sf             # analyze-only first
bun run scripts/import-sales-invoices-api.ts --dir "$DIR" --org regal-sf --convert   # then commit what's eligible
# c) stock receipts (goods in) — dry-run first, prints what it WOULD book
bun run scripts/receive-stock-api.ts --dir "$DIR" --org regal-sf
bun run scripts/receive-stock-api.ts --dir "$DIR" --org regal-sf --execute
```

Read every line, not just the final count:
- `import-sales-invoices-api.ts` will flag `till-overlap` candidates (a фактура for a
  sale the till already rang) — **verify before** `--include-till-overlap`; see memory
  `lgr-regal-sf-org` / `lgr-till-overlap-backlog` for how that class was diagnosed before.
- `receive-stock-api.ts`'s "0 receipt line(s), 0 adjustment line(s)" is normal for a
  price-only разписка line (no `quantity` field at all in PlusMinus's JSON) — not a bug,
  nothing to book for it.

## 3. Reconcile against the snapshot

```bash
bun run scripts/compare-stock-api.ts --org regal-sf --dir "$DIR"
```

Read-only. Reports, in order:
1. **Qty diffs on matched products** — same product name in both systems, different
   quantity. This is the number worth acting on.
2. **Missing in LGR / LGR-only**, raw exact-name counts — ⚠ **don't trust these at face
   value.** The script's own second pass (always runs, printed right after) strips a
   `<label>:` prefix (`СТОКИ:`, `УСЛУГИ:`, or an arbitrary kit-component label PlusMinus
   puts before a colon) and literal `"`/`'` marks, and re-matches the two tails against
   each other. On regal-sf's first full-month run this reconciled 38 of 46+41 "gaps"
   down to the SAME product at the SAME quantity — a naming artifact, not a stock
   problem. Only the post-reconciliation "truly missing" / "truly LGR-only" counts (with
   nonzero quantity) are real findings worth looking at individually.

## 4. True up residual quantity diffs

Only for products that exist in BOTH systems (step 3's "qty diffs" list) — never for the
missing/LGR-only tails (creating a product from a bare snapshot row needs a cost/category
call this script doesn't make; do that by hand if it's ever worth it — see memory
`lgr-regal-sf-org`'s "16 products opening stock never seeded" for the kind of judgement
call involved).

```bash
bun run scripts/true-up-stock-api.ts --org regal-sf --snapshot "$DIR/storeAvailability_<pmTo>.json" --date <YYYY-MM-DD>   # preview
bun run scripts/true-up-stock-api.ts --org regal-sf --snapshot "$DIR/storeAvailability_<pmTo>.json" --date <YYYY-MM-DD> --execute
```

PlusMinus is the arbiter throughout this migration (every prior investigation that
could independently verify it — till-overlap, snapshot chains — confirmed PlusMinus's
own number is the one to trust). Once every document is confirmed imported (step 2
reports nothing outstanding), a residual gap on an EXISTING matched product has no
further document to find — it gets corrected directly via two tagged `adjustment`
movements (`snapshot-reconcile:<date>` in the notes), one increase batch (`toWarehouseId`)
and one decrease batch (`fromWarehouseId`), never invented as a fake document. Both are
fully reversible (search stock movements for the marker) if a later finding says
otherwise. Re-run step 3 afterwards — it should come back near-zero.

⚠ Lines on a product with no established cost (`avgCost`/`purchasePrice` both unset —
typically the "opening stock never seeded" class) book at **zero cost**, same precedent
as the standing opening-stock corrections elsewhere in this migration (memory
`lgr-regal-sf-org`'s retired `SM-2026-01050`). That is accepted here, not a bug.

## 5. Clean up

Drop the throwaway service account from step 0 if you created one (memory
`lgr-temp-service-account`), and `roomler kill` any forward left over from step 1.

## Known-clean baseline (2026-10-31)

Full month 2026-10-01..2026-10-31, regal-sf: 1100/1100 invoices, 27/27 till days,
233/233 stock receipts already imported (0 new to book) — the daily cadence had kept up
perfectly. Reconciliation found 50 qty diffs on matched products (trued up in one pass,
movements `SM-2026-01435`/`SM-2026-01436`) and, after the naming-artifact pass, **zero**
genuine missing/extra products with nonzero quantity. Re-running this skill on a later
period should look similar in shape (mostly a report of "already imported", a handful of
small qty diffs) unless something actually broke.
