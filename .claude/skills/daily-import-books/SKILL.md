---
name: daily-import-books
description: Step 6 of the daily import - the accounting books check that goes with a store import. One by-hand run of the nightly books import, what each of the day's imports brought, and the list of filings on the books PC that are not here yet. It never pulls or imports VAT or payroll files. Use when the user asks for the accounting docs together with the stores', or after the stores are booked.
allowed-tools: Bash(bun:*), Bash(powershell:*)
---

# The books check

The books (one ledger for the whole company, in its own org) are imported unattended by a scheduled task on the
operator's PC: every two hours while he is signed in, from the archive the accountant's PlusMinus writes at each
session close (`pull-plusminus-books` skill). That lane has its own owner. This step looks, starts one run by hand,
and lists. Everything else there is left alone.

## 1. One run by hand

Any minute except the first five of an odd hour, when the scheduled run starts:

```bash
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'LGR books nightly'"
# wait for the task to return to Ready (under two minutes), then:
tail "$ACC_DOCS_ROOT/books/nightly.log"; cat "$ACC_DOCS_ROOT/books/nightly-state.json"
```

- **"<archive> is imported already"**: the books PC answered and its newest archive is the one in LGR. Current.
- **"<archive>: N change(s)"**: this run imported a newer archive and mailed its list.
- **"the books PC did not answer"**: that PC is off. A session-close archive, if one was written, is imported by the
  first scheduled run after it is back on. Say so; there is nothing to retry.

## 2. What the day brought

Each import leaves `books/<day>/changes-<sha12>.txt`: dates, document types and numbers, no names or amounts. Read
the ones written since the previous report and give the report their counts: how many new, changed, moved, gone,
and which stores' documents. A `gone` and a `new` on the same date are one document renumbered. Sales invoices of a
store reach the accountant's database a day or two after the store issues them, so a day the stores just booked is
often absent here: that is the lane's rhythm.

## 3. The books PC and the filings

From the checkout the scheduled task runs from (`pull-plusminus-books`, "the pin"), with the stores' env sourced:

```bash
bun .claude/skills/pull-plusminus-books/fetch-archive.ts --list      # the newest archives, and whether PlusMinus is open there
bun .claude/skills/pull-plusminus-books/pull-filings.ts --list       # per folder: how many files on the PC, how many not here
```

- PlusMinus open on the books PC means the accountant is working: a newer archive will follow at session close.
- **"n not here"** in a filings folder is news for the owner, and the report says which folder and how many.
  Three new files under the VAT folder are a month's return; a return can change until it is filed, and VAT and
  payroll files are pulled and imported by hand, on the owner's word, in the books lane.

**Done when** the by-hand run's line is read, the day's change lists are counted, and anything new on the books PC
is in the report as a count with its folder.
