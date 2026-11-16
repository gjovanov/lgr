---
name: daily-import-pull
description: Step 2 of the daily import - pull the day from each store's PlusMinus, re-pull the store's whole history and compare it with the previous run's to find documents edited, deleted or back-dated since, and scan the day for documents that moved no stock. Use after the preflight, before anything is predicted or booked.
allowed-tools: Bash(bun:*), Bash(roomler:*), Bash(curl:*)
---

# Pull

Read-only on both sides: PlusMinus is only read, LGR is not touched. `D` below is
`bun .claude/skills/daily-import/daily.ts`.

## 1. The day

```bash
D pull --org regal-pz
roomler forward --agent "$SF_ROOMLER_AGENT" --local 17041 --remote "$SF_PM_REMOTE" --daemon     # prints fl-N: step 7 kills it
D pull --org regal-sf --base-url https://127.0.0.1:17041
```

The pull writes one JSON file per document into the day folder, the stock snapshot, for regal-pz the POS
receipts, and the partner directory (`partners.json`: every customer and supplier PlusMinus keeps, with their ЕИК,
address and phone; the contacts family of step 4 reads it). What its findings mean:

- **`GAPS`**: a number missing inside the day's own range. The history phase says whether it was deleted.
- **"the day starts at N, the previous history ended at M"**: the numbers between were deleted or carry another
  date. The history phase names them.
- **"at or below the previous history's last number"**: this day was pulled before. The `rerun` phase of step 5
  says what of it is booked.
- **`STOP`, exit 3**: the store's `lgr-api` account is in use. Find out whose session it is (`pull-plusminus-api`,
  "A dedicated account per store"). The session stays.

## 2. The history

```bash
D history --org regal-pz
D history --org regal-sf --base-url https://127.0.0.1:17041      # several minutes: run it in the background
```

A history may run in the background, but its org's `predict` (step 3) waits for it to end: the audit reads the chunks.

PlusMinus lets staff edit a booked document in place, delete one, and enter a new one under an earlier date. A day
pull sees none of that, so the whole history is pulled again (monthly chunks, into the evidence folder) and compared
by file with the previous run's. `out/doc-edits.txt` holds every changed line. Each `ACT`:

- **EDITED** (a booked document changed): it is a **named residual**. Write down the document and the line. The
  prediction must then show exactly it, and after booking a true-up absorbs it. The document itself is left as
  booked, now and on every later run. A changed customer on an invoice (header only) goes to the owner.
- **DELETED**: if LGR booked it, the same as an edit. If it was held and never booked, nothing is owed. A document
  the store deleted and entered again arrives as a new number on its new date.
- **dated OUTSIDE the day** (back-dated): these are booked first in step 4, by number, from the history chunk that
  holds them.
- **already in the previous history**: a second pull of the day; see the `rerun` phase.

The note "numbers missing from the whole history" lists every deleted number; the ones the previous report lists
are known.

## 3. The scan

```bash
D scan --org regal-pz
D scan --org regal-sf
```

- **A receipt, transfer or write-off on `БЕЗСКЛАД`** moved no stock in PlusMinus, and the importer would book it as
  if it had. It is **held**: step 4 books the others with `--only`, and the owner is told. The prediction cannot
  see it, because it drops `БЕЗСКЛАД` lines on purpose.
- **A mixed invoice** (stock lines and `БЕЗСКЛАД` lines) is refused by the importer and goes to a person.
- Invoices wholly on `БЕЗСКЛАД` are till sales invoiced afterwards: the importer attaches them to their till day.
- A negative till line is a return or an exchange: the day's row carries the sign and puts the stock back.

To look at a document or to find what else moves an article:
`bun .claude/skills/daily-import/doc.ts lines <file>` and `… doc.ts find <day folder> "<part of the name>"`.

**Done when** every org's `pull`, `history` and `scan` show no `STOP`, and each `ACT` is written down as a named
residual, a back-dated document to book first, or a held document.
