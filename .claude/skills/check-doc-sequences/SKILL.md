---
name: check-doc-sequences
description: Detect missing or duplicate PlusMinus document numbers (invoicem / stokrazp / sklrazp / sklisk) across one or many day-export folders, and optionally verify each present doc actually landed in LGR. Use after importing a day, or to audit the whole migration for skipped/unexported documents that would silently drift stock.
allowed-tools: Bash(bun:*)
---

# check-doc-sequences

PlusMinus exports one PDF per document, named `<type>_<number>.pdf`. The numbers run in a
single per-type sequence, so a **missing number = a document that was never exported** (or a
void in the source ERP). If that document carried stock (a receipt, correction, or transfer),
LGR silently drifts from reality. This skill finds those gaps — and duplicates — deterministically.

## What one run does

1. **Scans folders** — either every `2026-MM-DD` folder under a `_docs` root (global cross-day
   sequence) or a single day folder — collecting the numeric id of every `invoicem`,
   `invoiceProf`, `stokrazp`, `sklrazp`, `sklisk` file.
2. **Finds gaps** per type in O(n) over the sorted present numbers (jumps between consecutive
   docs — it never enumerates `min..max`, so unrelated number spaces don't blow up). Reports
   each missing run with the **day boundary** it falls between.
3. **Finds duplicates** (same number exported in >1 folder — benign, dedup-guarded, but worth
   knowing; e.g. a daily export that re-includes yesterday's tail).
4. **(optional) Verifies against LGR** (`--org`): scrapes movement-notes markers
   (`stokrazp:`/`corr:`/`sklrazp:`/`sklisk:`) + issued invoice numbers, then reports (a) folder
   docs with **no LGR record** ("not imported") and (b) gaps in LGR's own sequence just below
   the scanned range (catches a cross-day gap even when scanning a single day).

`invoicem` and `invoiceProf` are treated as **separate number spaces** (proforma is 7xxx, sales
is 3000100xxx) — never combined, or the span would be enormous and every proforma would read as
a false sales gap.

## Usage

```bash
# whole migration — all day folders under the _docs root:
bun run scripts/check-doc-sequences.ts --root //wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs

# a single day (intra-day gaps only, unless you add --org for cross-day + import verify):
bun run scripts/check-doc-sequences.ts --folder <_docs>/2026-08-18 --org regal-pz

# machine-readable / persisted:
bun run scripts/check-doc-sequences.ts --root <_docs> --json
bun run scripts/check-doc-sequences.ts --root <_docs> --out gaps.csv
```

Creds for `--org`: env `LGR_TOKEN`, or `LGR_USERNAME` + `LGR_PASSWORD`. `--quiet` hides the
`✓ contiguous` lines (show only problems). **Exit code 1** if anything is missing/not-imported
(0 otherwise) — usable as a CI/gate check.

## Interpreting the output

- `⚠ MISSING 3000016228 — between 2026-08-17 and 2026-08-17` → an intra-day skip; the export
  jumped a number. Confirm it's not in another folder, then obtain it from PlusMinus.
- `⚠ MISSING vs prior LGR 12678/12679 — before 2026-08-14` → the day's first number doesn't
  continue from the last one LGR knows → a cross-day gap.
- `⚠ NOT imported 3000100590` → the PDF is on disk but never made it into LGR (failed/partial
  import) — re-import it.
- Duplicates are informational: the daily export sometimes re-emits the previous day's last few
  docs; the import scripts dedup by marker so no double-booking occurs.

## Materiality gotchas

- Gaps **before the last full `storeAvailability` re-baseline** are usually immaterial — the
  re-baseline set quantities directly from the snapshot, absorbing any earlier receipt/correction.
  Only post-baseline gaps cause live drift.
- A missing **sales** number may simply be a **voided** invoice (no stock effect). Cross-check the
  `docJournalReport` -ФЕ register: if the number is in the register it was a real issued sale
  (→ obtain & import); if absent, it was voided (→ ignore).
- The LGR marker scan depends on the import scripts writing `stokrazp:`/`corr:`/`sklrazp:`/
  `sklisk:` in movement notes and preserving the original number in issued invoice numbers — the
  convention the other migration skills follow.
