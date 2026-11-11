---
name: daily-import-close
description: Step 7 of the daily import - close the run. Drop the throwaway admin and prove it is gone, close the tunnel, collect the day's figures from the evidence, write the report in the shape of the previous one, record what the next run needs, and ask the owner about the next day. Use when the stores are verified and the books are checked, or when a run is abandoned and has to be left clean.
allowed-tools: Bash(bun:*), Bash(bash:*), Bash(roomler:*)
---

# Close

A run that stops early is closed the same way: sections 1 and 2 always, the report saying how far it got.

## 1. The temp admin

```bash
bash .claude/skills/temp-admin/temp-admin.sh drop <tag> regal-pz regal-sf
```

It deletes the account in every org, then proves it: no row left, sign-in refused in each org and its test copy
and by username and e-mail alone, and the sessions it held answer 401 two minutes later. It must end on
`DROPPED and proven`. "users deleted" above the number of orgs is the test-org sync having copied the account
while it existed; the drop removed the copies too. `NOT PROVEN` is not closed: read its lines and run it again.

## 2. The tunnel and the build host

```bash
roomler kill fl-N         # the forward of step 2
roomler flows             # nothing on its local port; other flows are other people's
```

`temp-admin.sh` and `tags.sh` clean the build host themselves and say so ("build host clean").

## 3. The figures

```bash
bun .claude/skills/daily-import/daily.ts facts --org regal-pz
bun .claude/skills/daily-import/daily.ts facts --org regal-sf
```

`out/facts.md` gathers what the evidence says: what was pulled, the history diff, differences before and after,
each run log's movements and documents, prices, the audit, and the last numbers. The report is written from it and
from the logs, never from memory.

## 4. The report

`_reports/<day>/import-report-<ddmm>.md`, beside the stores' document roots, in the shape of the previous day's.
The reader is the owner, who was not watching. First paragraph: when it was booked and on whose word. Then:

1. **Result**: per store, what is in LGR now, and the stock differences before → after against what was predicted.
   Anything held, in one line.
2. **Per org and family**: what PlusMinus had, what was booked, LGR's document and movement numbers, totals; the
   till's booked total against what it took.
3. **PlusMinus edits and back-dated documents**: what the history diff found, with each document.
4. **Stock**: the comparison, the named residuals, whether PlusMinus stood still.
5. **New products, contacts and tags.**
6. **Decisions and notes**: every `ACT` of the run and how it was resolved; what the owner has to decide.
7. **After-audit and reruns.**
8. **Books.**
9. **Cleanup**: the temp admin's drop, with its proof lines.
10. **Next run**: the last numbers, the evidence folder to compare against, the deployed commit, and the list of
    documents that are never corrected again.

Say plainly what is not done: a held document, a store that was off, a filing that is waiting.

## 5. What the next run reads

- The report's last section is the hand-over. A session that keeps notes updates them with the same facts.
- Ask the owner about the next day, in one line. His answer is that day's word.

**Done when** the drop says `DROPPED and proven`, no forward of this run is left, the report is in place, and the
owner has the result in a few lines with the question for the next day.
