---
name: pull-plusminus-docs
description: Export a business day's documents out of the legacy PlusMinus POS on the regal-pz store PC (Regal-Elena-PZ) — sales invoices, stock receipts, transfer notes, write-offs, the till report and the stock snapshot — into the `_docs/regal-pz/<YYYY-MM-DD>/` day folder the import skills read, byte-verified, then optionally email them. Use when a day's PlusMinus files have to be fetched from the store PC, re-pulled, or exported there over Roomler remote desktop.
---

# pull-plusminus-docs

PlusMinus writes each exported document as a PDF into `C:\plusminusPOS 1\exports\docs\РЕГАЛ   ООД\`
(three spaces) and each report as an xlsx into `C:\plusminusPOS 1\exports\` on the store PC. This
skill brings one business day's set into the day folder, byte for byte, for the skills that book it.

**A direct API route now exists and is proven** — see the sibling skill
[`pull-plusminus-api`](../pull-plusminus-api/SKILL.md). The "missing third argument" this doc used
to describe was never real: reading the vendor's own embedded client JS (not disassembly) showed
`document`'s real key is `date\num` from a `documents()` listing entry, and `documents()` itself
silently reorders/pads to 6 wire arguments — both found and live-verified 2026-10-27 (see
[`plusminus-mobile-api-reference.md`](plusminus-mobile-api-reference.md)'s "Binary-level
follow-up" section for the full, corrected record, including the earlier wrong conclusion). The
API route is proven **for regal-pz only** — each org needs its own server/credentials verified
before trusting it (see `pull-plusminus-api/orgs.ts`); **this GUI procedure remains the only
proven route for regal-sf**, whose server is not yet on file at all (see `export-gui.md`'s
regal-sf section).

Device `Regal-Elena-PZ` (regal-pz) = agent **`6a61228270bf9a4044cd615c`** (Grox org). Device
`Regal-Dechko-SO` (regal-sf) = agent **`6a687648c8141b25961ebde6`** (`regal_ssh.txt`). Commands
carry the hex id: `roomler exec Regal-Elena-PZ` answers "no device named…", because the CLI does
not resolve a display name.

Two transports, two jobs:
- **remote desktop** (Roomler viewer in Chrome) to drive PlusMinus, the export's only interface;
- **`roomler ssh` / `roomler exec`** to read the files, no GUI involved.

## 1. List what is already exported

```bash
bash .claude/skills/pull-plusminus-docs/pull.sh --day 2026-10-26 --list
```

Shows every export written in the day's window (00:00 → next day 06:00, Sofia time) with size,
SHA-256 prefix and time. The window selects by **last write**, i.e. when a file was exported, not
its document date. Staff usually export the day themselves in the evening (17:30–22:30).

Done when you know, per document type, what the PC holds for the day.

## 2. Export what is missing

Follow [`export-gui.md`](export-gui.md). Read the day's journal first: its `-ФЕ`/`СТ`/`СР`/`СИ`
numbers are what must exist. Export only what `--list` lacks, plus the till report and, last, the
stock snapshot when those are missing or predate the day's last document.

Leave PDFs that are already there alone. A re-export rewrites the same document with new bytes,
and the LGR Files app files changed bytes as a new version of a document it may already have
booked (the re-upload trap, see memory `lgr-reupload-vs-duplicate`).

Done when every journal number of an exported type has its PDF in `--list`, and the day has one
`salesAnalysis_*` and one `storeAvailability_*` taken after its last document.

## 3. Pull

```bash
bash .claude/skills/pull-plusminus-docs/pull.sh --day 2026-10-26
```

Batches the files through `roomler ssh` as base64, ≤ 600 KB per call, because that channel mangles
non-UTF-8 bytes and older CLIs cut it at 1 MiB. It checks every file's size and SHA-256 against the
PC's own listing before writing to `//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/regal-pz/<day>/`.
Then it prints one line per file (`new` / `same` / `REPLACED`), per-family counts and number ranges
with any `GAPS`, and leaves `pull-manifest.txt` (name, size, sha256, export time) in the folder.
Only the newest export of each report is taken; `--all-xlsx` takes them all. Re-running is safe
(identical files are left alone). Use `--since/--until` (PC time) for an export made outside the
default window, e.g. the next morning.

Done when the script exits 0 and the counts and ranges equal the journal's.

## 4. Verify

```bash
bun .claude/skills/pull-plusminus-docs/check-snapshot.ts "<day folder>/storeAvailability_<stamp>.xlsx"
bun run scripts/check-doc-sequences.ts --folder "<day folder>" --org regal-pz   # needs LGR creds, see its skill
```

`check-snapshot.ts` demands that the rows add up to the file's own `Всичко` and that zero-quantity
products are present (a `PARTIAL` verdict means the zero-quantity tick was missed: export it
again). `check-doc-sequences` finds a day that does not continue from the last number LGR knows.

Done when both pass, or every finding is explained.

## 5. Email (when asked)

```bash
bun .claude/skills/pull-plusminus-docs/mail.ts --dir "<day folder>"     # dry run: recipients, subject, attachments
KEY=$(roomler ssh mars -- "grep -m1 '^EMAIL_API_KEY=' /home/gjovanov/roomler-ai-deploy/.env | cut -d= -f2- | tr -d '\"\r'" | tr -d '\r\n')
SENDGRID_API_KEY="$KEY" bun .claude/skills/pull-plusminus-docs/mail.ts --dir "<day folder>" --send; unset KEY
```

Recipients live in `.secrets/plusminus-mail.json` (gitignored: this repo is public). The key is the
SendGrid key LGR's own mail uses, kept on mars (memory `lgr-sendgrid-email-ops`); keep it in the
environment of the one command and never print it. Reach mars with `roomler ssh mars`, which needs
no key passphrase. Each recipient gets their own copy of one plain-text message with the
day's files attached, from `noreply@lgrai.app`.

**TODO (requested 2026-10-27, not yet built): a daily, automated email of regal-sf's invoices to
`rdodova@gmail.com`.** `mail.ts` as it stands doesn't fit unmodified — it's regal-pz-specific
(hardcoded subject "РЕГАЛ ООД, СКЛАД - 1 (Пазарджик)", recipients from the single shared
`.secrets/plusminus-mail.json`, and it emails the WHOLE day folder, not one document family).
Needed: an org parameter, an `invoicem`-only filter, a fixed single recipient (not the shared
list), and a recurring trigger (`schedule`/`CronCreate` — a cloud routine, not a session-bound
loop) rather than a one-off manual run. Scope it before building: what time/timezone, what a
zero-invoice day sends (nothing, or an empty confirmation), and whether it should wait on
`pull-plusminus-api`'s own pull succeeding first rather than racing it.

Done when SendGrid answers `202` and its activity feed shows every recipient `delivered`:
`GET https://api.sendgrid.com/v3/messages?limit=10&query=from_email%3D%22noreply%40lgrai.app%22`
(header `Authorization: Bearer <key>`, passed from a file with `curl -H @file`).

## 6. Hand off

| file | booked by |
|---|---|
| `invoicem_*.pdf` | `import-sales-invoices` |
| `salesAnalysis_*.xlsx` | `import-cash-register-sales` |
| `stokrazp_*.pdf` | Inventory → Stock Movements → Import, or `receive-new-products` for new articles |
| `sklrazp_*.pdf` | `transfer-stock` |
| `sklisk_*.pdf` | `adjust-stock` |
| `storeAvailability_*.xlsx` | `compare-products` (the day's arbiter) |

This table is regal-pz's. **For regal-sf, `stokrazp_*.pdf`/`storeAvailability_*.xlsx` mean the
same thing and book the same way — but there is no `sklrazp`/`sklisk`/`salesAnalysis` for that
store at all.** Its till register is `storeOperations_*.xlsx` (Операция: Продажби — cash-register
sales, the same real-world document as `salesAnalysis`, different layout and source screen) and
books like `import-cash-register-sales` conceptually, though that skill as written expects the
`salesAnalysis` layout specifically — verify the column shapes actually match before trusting it
unmodified. See `export-gui.md`'s regal-sf section for the full type-code story before assuming
anything else carries over.

The LGR Files app takes the whole folder in one upload (regal-pz; not yet run for regal-sf) and
analyzes and commits it as a batch. Staff upload there too: check what the app already holds for
the day before uploading, since the same document from a second export is the re-upload trap
again.
