---
name: daily-import
description: The hub for the daily PlusMinus → LGR import of the stores (regal-pz, regal-sf) and the books check that goes with it - the order of the steps, the rules, the gate between each step and the next, and which step skill does what. Use when the user asks to import a day's or today's store documents, to run or continue the daily import, or to import store and accounting docs.
allowed-tools: Bash(bun:*), Bash(bash:*), Bash(roomler:*)
---

# The daily import

Every evening the stores' PlusMinus holds a day of documents LGR does not have yet: invoices, receipts, transfers,
write-offs and the till. This run books them into production and proves, document by document and article by
article, that LGR then equals PlusMinus. It is seven steps, each its own skill, each ending on a gate.

**The gate.** Every step runs phases of [`daily.ts`](daily.ts) (`bun .claude/skills/daily-import/daily.ts --help`).
A phase keeps the tools' full output in the day's evidence folder and ends on findings:

| | |
|---|---|
| `ok` | checked and fine |
| `note` | goes into the report |
| `ACT` | a person decides or does something before the run goes on; the step skill says what |
| `STOP` | the run does not go on |

A step is done when its phases show no `STOP` and every `ACT` is either resolved or written down as a **named
residual** (a document edited or deleted in PlusMinus, a back-dated one, one that is held). The checks themselves are
`scripts/lib/daily-import.ts`, with tests.

## The steps

| # | Skill | Phases | Done when |
|---|---|---|---|
| 1 | `daily-import-preflight` | `plan`, `grant` | the day has the owner's word, it is past 17:15 UTC, the stores answer, the checkout is at the deployed commit, the temp admin's session reads everything |
| 2 | `daily-import-pull` | `pull`, `history`, `scan` | the day is pulled; everything edited, deleted, back-dated or stock-less is named |
| 3 | `daily-import-predict` | `predict` | the prediction says 0, or every residual is named |
| 4 | `daily-import-book` | `dry`, `book` | every family of the day is booked, each without `ACT` |
| 5 | `daily-import-verify` | `after`, `prices`, `rerun`, `audit` | PlusMinus stood still, stock differences are 0, reruns book nothing |
| 6 | `daily-import-books` | (the books' own tools) | the books are current, and what is new on the books PC is listed |
| 7 | `daily-import-close` | `facts` | the temp admin is dropped and proven gone, the report is written |

Run one org at a time through steps 2 to 5 phase by phase (pull both, then predict both, and so on): the same temp
identity signed in twice at once has answered 401.

## Rules

- **The owner's word, per day.** Booking writes money, stock and prices into production. A day is imported when the
  owner asked for that day; his asking for "today" is the word for today. Nothing schedules this run.
- **After the stores close: 17:15 UTC or later.** A store has entered receipts 45 minutes after closing.
- **Read before writing.** `book` writes only with `--execute`, and only after its own dry run of the same selection
  came back clean. A dry run with an `ACT` is resolved, never forced.
- **PlusMinus is the arbiter.** LGR is made to equal the snapshot. A difference is explained by a document, and a
  true-up only absorbs what was named before it.
- **One PlusMinus session per account.** The pulls sign in as each store's own `lgr-api` account. Exit code 3 means
  that account is in use: find out whose session it is, and leave it alone. Store PCs are left as they are.
- **The temp admin is created, used, dropped and proven gone** in the same run (`temp-admin` skill).
- **Books are another lane.** Step 6 looks and lists. VAT and payroll files stay where they are.
- **This repository is public.** Customer and supplier names, real document numbers and the stores' machines stay in
  the evidence folder and the report, which are private.

## Where things are

- **The import checkout:** a worktree of this repository at the commit production runs, outside any temp directory
  (a cleaner that removes empty files also removes every `node_modules` link). Step 1 moves it; every command of a
  run starts there.
- **The stores' identifiers:** `.secrets/plusminus-stores.env`, read by name (`pull-plusminus-api`, "Store
  identifiers"). `<PREFIX>_DOCS_ROOT` is a store's private document root.
- **A day folder:** `<docs root>/<day>/api/`, or `<from>_<day>/api/` when the range starts earlier.
- **An evidence folder:** `<docs root>/_audit-<day>-eve/`: the history pull in monthly chunks, `after/api/`, and
  `out/` with every phase's output. A second run on the same day takes `--suffix late`. The previous evidence folder
  is what `history` compares against; `plan` names it.
- **The report:** `_reports/<day>/import-report-<ddmm>.md`, beside the stores' document roots. The previous day's
  report is the one to read first: its last section says what is standing (known gaps, known differences, documents
  that are never corrected again).

## A store that is off, a day that was missed

A store whose PC is off is skipped and said so; the other store's run goes on. Its next run takes
`--from <first day not booked>`: the range lands in one day folder, so the prediction sees every unbooked document
at once.
