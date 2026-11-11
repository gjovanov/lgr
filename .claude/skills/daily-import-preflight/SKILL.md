---
name: daily-import-preflight
description: Step 1 of the daily import - the go/no-go before anything is pulled or written. The day's word from the owner, the start time, whether each store's PC and PlusMinus answer, the import checkout moved to the commit production runs (with the change since the last run read), and a throwaway admin whose session is proven to read everything. Use at the start of a daily import run.
allowed-tools: Bash(bun:*), Bash(bash:*), Bash(roomler:*), Bash(git:*), Bash(ssh:*), Bash(curl:*)
---

# Preflight

Nothing here writes to LGR or PlusMinus except creating the temp admin, which the last step of the run drops.

## 1. The word and the clock

The owner asked for this day (`daily-import`, "Rules"). Then, from the import checkout:

```bash
bun .claude/skills/daily-import/daily.ts plan            # --day YYYY-MM-DD for a past day; --from for a missed range
```

It prints the day, each store's day folder and evidence folder, the previous run it will compare against, and the
last document numbers of that run. `STOP` before 17:15 UTC: wait. An `ACT` "no previous evidence folder" means
`--prev` has to name one. Read the previous day's report now (`daily-import`, "Where things are").

## 2. The stores

```bash
set -a && source <main checkout>/.secrets/plusminus-stores.env && set +a
roomler devices -q "$PZ_STORE_PC" --json | grep -o -E '"(presence|last_seen_at)"[^,}]*'
curl -sk -o /dev/null -w '%{http_code}\n' --connect-timeout 8 "$PZ_PM_BASE_URL/"      # 200
roomler devices -q "$SF_STORE_PC" --json | grep -o -E '"(presence|last_seen_at)"[^,}]*'
```

regal-pz's PlusMinus server runs on its store PC: that PC offline means no pull, and each attempt takes 40 seconds
to time out. regal-sf's server is behind its store PC and is reached through a forward that step 2 opens. A store
that is off is skipped (`daily-import`, last section).

## 3. The checkout at the deployed commit

The importers call production's API, so they run from the commit production runs.

1. The deployed commit: on the build host, the deploy repository's newest `bump lgr to <tag> (<sha>)` subject names
   it (`deploy-prod` skill).
2. In the import checkout, fetch, then read what changed since the previous run's commit (its report names it):

   ```bash
   git diff --stat <previous sha> <deployed sha> -- 'scripts/*-api.ts' scripts/receive-new-products.ts scripts/lib/ \
     .claude/skills/pull-plusminus-api/ .claude/skills/daily-import/ packages/services/src/biz/doc-import/
   git diff --stat <previous sha> <deployed sha> -- 'packages/*-api/src' packages/services/src packages/db packages/config packages/migrations
   ```

   Read every change that touches an importer or a route the importers call: `/invoices`, `/doc-import/*`,
   `/warehouse/movement`, `/warehouse/product`, `/warehouse/stock-level`, `/invoicing/contact`, sign-in. A change
   in what a role may read or write is the one that matters most (section 4 is its live check).
3. `git checkout --detach <deployed sha>`, and `bun install --frozen-lockfile` when `bun.lock` changed.

Production can be deployed again while the run is going. Look at the deploy repository's head once more after
booking (`daily-import-verify`), and read any new change the same way.

## 4. The temp admin, and what its session reads

```bash
bash .claude/skills/temp-admin/temp-admin.sh create <tag> regal-pz regal-sf      # tag: imp<ddmm of tomorrow>, the default daily.ts looks for
bun .claude/skills/daily-import/daily.ts grant --org regal-pz
bun .claude/skills/daily-import/daily.ts grant --org regal-sf
```

`grant` signs in and looks at a product and a stock level. It must say the session reads the purchase price, the
selling price, each tier's margin, the cost tier and the average cost. A `STOP` here ends the run: a session that is
shown less (a role without cost figures or some price levels) would compare, snapshot and write wrong figures while
every call succeeds.

**Done when** `plan` shows no `STOP`, each store is either reachable or declared skipped, the checkout is at the
deployed commit with its change read, and `grant` is `ok` for every org of the run.
