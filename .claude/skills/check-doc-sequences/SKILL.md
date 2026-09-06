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

## A number can be present, booked — and still wrong

A gap is not the only way a day drifts. PlusMinus **re-issues a document under the same number**
when it is corrected, and the corrected PDF lands in the day folder over the old one. That
document is neither missing nor duplicated, so the sequence check passes; what is booked simply no
longer matches what the document says.

`stokrazp_3000016311` (2026-08-28) is the worked example: its last two line items were re-keyed
from `ПОП-НИТ 4х20` / `4х16` to the `- Ш.ПЕР.` variants. The re-upload was stored as **v2** — and
then read as a plain duplicate, because "already imported?" was answered from the idempotency
marker alone. The marker says *a document with this number is booked*; it says nothing about
whether the content still matches. 8000 units sat on the wrong two products for four days, showing
up in the availability compare as `-5000 / -3000 / +1000`.

**Two rules follow.**

1. **A re-upload that changes the bytes is an UPDATE, not a duplicate.** Skip only when the
   checksum is identical. `DocFile.committedChecksum` records which bytes were booked; when it
   differs from `currentChecksum`, the booking is stale (`staleBooking` on the list rows and on the
   analyze result). Rows booked before that field existed fall back to `version > committedVersion`.
2. **Never re-commit a stale document — reconcile it.** Committing books the whole document a
   second time; the original movement is still there. `POST /files/:id/reconcile` diffs the new
   intended net-per-product against what the marker says is booked and writes ONE compensating
   movement per direction. It is a **dry run** unless `?execute=true`, and it verifies every
   product lands on `booked_before + delta` before returning.

In the UI both surfaces show a **`needs reconcile`** chip (Files → Upload results, and
Documents → both the flat and by-date tables) with a Reconcile action beside it, single or batch.

**Auditing for stale bookings** — the compare's "LGR higher/lower" rows are the symptom; this is
the check that names the cause:

```js
// docs whose booked bytes are not the bytes on disk
DocFile.find({ orgId, committedIds: { $ne: [] } })
  .select('docType docNumber docDate version committedChecksum currentChecksum committedVersion')
  .lean()
  .then(ds => ds.filter(d => d.committedChecksum
    ? d.committedChecksum !== d.currentChecksum
    : (d.version || 1) > (d.committedVersion || 1)))
```

Anything it returns is a correction that was uploaded and never applied.

### Three things the 2026-09-04 pass added

**A re-issued document can have a partner — find it before concluding anything.**
`stokrazp 3000016311` (receipt) was re-issued with its last two lines re-keyed to the
`ПОП-НИТ - 4Х20/4Х16 - Ш.ПЕР.` articles: +5000 / +3000. Reading that document alone, the ERP's own
stock looked *inconsistent with its own paperwork* — it showed +0 and +1000. It was not: the
matching `sklrazp 0000012708` (transfer) had been re-issued too, taking −5000 / −2000 back out.
The pair nets to exactly what the snapshot shows. **Booking one half and reconciling to the
snapshot for the other is how you end up with the right totals for the wrong reason** — and it
breaks the moment the partner arrives. When a re-issued document appears, look for every other
document of that day (and the days either side) touching the same products.

**The document's DATE comes from the document, not the folder it was uploaded into.**
`assignDateAfterOcr` moves a DocFile to the `Дата` printed inside it. A day folder named
`2026-09-03` on disk held 29 documents that all say 02.09.2026, and LGR re-dated them to
2026-09-02 the moment they were analysed. Always confirm a day by `docDate` in LGR, never by the
folder name — otherwise "process 09-03" silently processes a different day, or finds nothing.

**Changed BYTES are not the same as changed CONTENT.** A PlusMinus PDF embeds a creation
timestamp, so re-exporting the same document produces a different checksum with identical lines.
Re-filing a day does the same. `staleBooking` keys on the checksum because that is all it can know
cheaply — so treat it as *"worth checking"*, not *"known wrong"*. Running the reconcile is what
settles it: an executed reconcile that finds **no deltas** books nothing and stamps
`committedChecksum`, and the flag clears for good.

### "The day's documents disappeared" — they were almost certainly re-dated

Symptom: a day looks empty in the Documents view, and re-uploading its folder reports every file as
a **duplicate**.

That combination is not loss, it is proof of the opposite: a duplicate means the bytes are already
stored. What moved is the DATE. `assignDateAfterOcr` files a document under the `Дата` printed
inside it, so a folder named for the day it was EXPORTED, holding the PREVIOUS day's paperwork,
lands one day earlier in LGR. On 2026-09-06 all 29 files in `_docs/2026-09-03/` printed
`02.09.2026`, and all 26 of its invoices were sitting under `docDate 2026-09-02`, committed and
booked — with zero delete audit entries, zero `isActive:false` rows, and an empty trash.

**The real question is whether the day was ever exported at all, and numbering answers it.** Run the
continuity check per family over the surrounding days: a day that was never exported leaves a gap
sitting exactly between the previous day's last number and the next day's first.

```
invoicem  2026-09-02  [3000100907–3000100932]
                      [3000100933–3000100944]  <-- 12 missing = 2026-09-03
          2026-09-04  [3000100945–3000100959]
stokrazp  gap 3000016343–3000016353 (11)   sklrazp gap 12716 (1)
```

Those 24 documents were on no disk anywhere — PV, local folders, versions or trash. They had to be
re-exported; nothing in LGR could recover them, and nothing needed "reprocessing".

**Check the day by `docDate` in LGR before concluding anything, and always confirm against a
storeAvailability snapshot for the day** — a missing trading day shows up there as a large block of
products where PlusMinus moved and LGR did not.
