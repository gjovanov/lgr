---
name: daily-import-predict
description: Step 3 of the daily import - before any write, audit which PlusMinus documents LGR lacks, compare LGR's stock with the snapshot, predict the difference that will be left once the day is booked, and take the price snapshot. The prediction must say 0, or every residual must have a name. Use after the pull step, before booking.
allowed-tools: Bash(bun:*)
---

# Predict

Read-only. It answers one question before anything is booked: will LGR equal PlusMinus afterwards?

```bash
bun .claude/skills/daily-import/daily.ts predict --org regal-pz
bun .claude/skills/daily-import/daily.ts predict --org regal-sf
```

Four tools run, each into `out/`: the audit (`audit.txt`), the comparison (`compare-before.txt`), the prediction
(`predict.txt`, `predict.tsv`) and the price snapshot (`prices-pre.json`, which step 5 needs: without it no price
change of the run can be proven).

**Only after `history` has ended, for that org.** The audit reads the history chunks in the evidence folder. While the
history is still being re-pulled (a run in the background) it reads a partial set, and answers "nothing of the pulled
range is left out of LGR: the day is booked already" for a day that is not booked at all. Nothing is written on that
answer, but it is wrong: when it appears for a day nobody booked, run `predict` again once `history` has finished.

## The prediction

It nets PlusMinus's own stock operations of the day's documents per article, and takes that from today's gap
between the snapshot and LGR. Booking the day should close the gap exactly.

- **`0 after booking`**: go on.
- **Residuals** (`RESID` lines; `predict.tsv` has them all): each must be one of the named residuals of step 2: a
  line PlusMinus edited or deleted in a booked document, a back-dated document that is not in the day folder, a
  held document. A residual with no name is a document nobody has found yet. Find it before writing:
  `doc.ts find` over the day folder and the history chunks, and the previous report's standing list.
  To prove that back-dated documents explain a residual, copy them next to the day's files in a scratch folder and
  run `predict.ts` on that: it must say 0.
- **An article that leaves stock and has no LGR product under that name** (`ACT`): the name differs between
  PlusMinus and LGR; it is no new product. The comparison's `ACT` "different-looking name" shows the LGR product
  beside it. Step 4 books that document from a corrected copy.
- **An article new to LGR** (`note`): a receipt of the day creates it. Check each against the catalogue: an existing
  product spelled differently (a missing separator, a Latin letter for a Cyrillic one, a trailing inch mark) would
  be created a second time.

## The rest

- **The comparison before** counts today's differences. Its `note` on articles "the snapshot does not list" is
  standing when the previous report has the same ones.
- **The audit's guard** judges each unbooked document alone. `ALREADY` means LGR agrees with the snapshot without
  it: either another document of the day undoes it, which the prediction nets to 0, or it moved no stock, which the
  scan of step 2 finds. With a clean scan and a prediction of 0 it needs nothing more.
- **"The day is booked already"** (`note`): nothing of the range is missing from LGR, so there is nothing to
  predict. This is a second run of the day; step 5's `rerun` is its proof.

**Done when** each org's prediction says 0 or every residual is written down with its document, and every name that
differs has its LGR product identified.
