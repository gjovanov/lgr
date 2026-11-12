---
name: daily-import-verify
description: Step 5 of the daily import - prove the booking. PlusMinus stood still while the day was booked, LGR's stock equals the snapshot (a true-up only for residuals that were named before), the products the import created are tagged, every price change is named by a receipt line, dry reruns book nothing, and the audit leaves nothing out. Use right after booking.
allowed-tools: Bash(bun:*), Bash(bash:*)
---

# Verify

`D` is `bun .claude/skills/daily-import/daily.ts`. Each phase per org.

## 1. After

```bash
D after --org regal-pz
D after --org regal-sf --base-url https://127.0.0.1:17041
```

It pulls the day again, compares it byte for byte with the first pull, and compares LGR's stock with the new
snapshot.

- **"PlusMinus MOVED"** (`STOP`): a document appeared or changed while the day was being booked. What was booked is
  the first pull. Book what is new by number (step 4), then run `after` again.
- **Quantity differences left**: a residual that was named in steps 2 and 3 is absorbed now, and only that:

  ```bash
  bun run scripts/true-up-stock-api.ts --org <org> --snapshot <evidence>/after/api/storeAvailability_<date>.json --date <day>              # preview
  bun run scripts/true-up-stock-api.ts --org <org> --snapshot <evidence>/after/api/storeAvailability_<date>.json --date <day> --execute
  D after --org <org>          # must say 0 now
  ```

  Read the preview: its lines must be exactly the named residuals. A difference with no name is a line that was
  not booked, or booked twice: find its document (`doc.ts find`, the run logs) and fix that.
- **"a different-looking name, with a different quantity"**: a line did not land on its product (step 4,
  corrected copy).

## 2. Tags

```bash
bash .claude/skills/daily-import/tags.sh regal-pz regal-sf                # dry: how many products need tags
bash .claude/skills/daily-import/tags.sh --execute regal-pz regal-sf      # only when an org needs any; it ends on a dry run that must need 0
```

## 3. Prices

```bash
D prices --org <org>
```

Every price that changed since the snapshot of step 3 must be named by a receipt line of this run
(`out/price-list.tsv` lists them for the report).

- **A purchase price or a cost tier changed** (`STOP`): an import never writes those on a product that existed.
  Something else wrote it; find out what before the next run.
- **Unexplained changes** (`ACT`): someone edited prices in LGR during the run, or a log is missing from `out/`.
  Name each one.

## 4. Reruns and the audit

```bash
D rerun --org <org>        # every importer, dry: receipts and outgoing halves "already booked", nothing new anywhere
D audit --org <org>        # nothing dated after the baseline may be left out, except a held document
```

An `ACT` in `rerun` is a document that is not in LGR: back to step 4 for it. For the contacts family it reads "contacts are
NOT settled": something is still to be created or filled, so read `out/rerun-contacts.txt`. The audit's notes on invoices that
differ beyond rounding are standing when the previous report lists the same ones.

## 5. Production, once more

Look at the deploy repository's head again (`daily-import-preflight`, section 3). If production was deployed during
the run, read that change too, and say in the report which commit each part of the run met.

**Done when** `after` says PlusMinus stood still and 0 differences for every org, `prices` shows nothing
unexplained, `rerun` and `audit` show no `ACT` beyond held documents, and the tags run needs 0.
