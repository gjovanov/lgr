---
name: daily-import-preflight
description: Step 1 of the daily import - the go/no-go before anything is pulled or written. The day's word from the owner, the start time, whether each store's PC and PlusMinus answer, the import checkout proven to carry the importers production was built with (and the server's change since the last run read), and a throwaway admin whose session is proven to read everything. Use at the start of a daily import run.
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

## 3. The checkout against the deployed commit

The importers call production's API, so the importers that run are the ones production was built with.

1. The deployed commit: on the build host, the deploy repository's newest `bump lgr to <tag> (<sha>)` subject names
   it (`deploy-prod` skill).
2. In the import checkout: fetch, `git checkout --detach origin/master`, `bun install --frozen-lockfile`, then

   ```bash
   bun .claude/skills/daily-import/daily.ts checkout --deployed <deployed sha>
   ```

   It follows the imports of every importer and the puller, and compares those files with the deployed commit's.
   `ok`: they are identical, and the run goes on from this checkout. `STOP` lists the files that differ: read the
   difference, then give the importers their own checkout at the deployed commit, and name it on every command of
   the run:

   ```bash
   git worktree add --detach <importers checkout> <deployed sha>     # once; on later days: git -C <it> checkout --detach <deployed sha>
   (cd <importers checkout> && bun install --frozen-lockfile)
   bun .claude/skills/daily-import/daily.ts checkout --deployed <deployed sha> --importers <importers checkout>     # ok now
   ```

   This skill's tools stay on master; the importers and the puller run from the other checkout. `--importers` then
   goes on every `daily.ts` phase (a shell variable does not outlive one command here; `LGR_IMPORTERS_ROOT` is the
   same thing for a shell that keeps it).
3. Read what changed on the server since the previous run's commit (its report names it):

   ```bash
   git diff --stat <previous sha> <deployed sha> -- 'packages/*-api/src' packages/services/src packages/db packages/config packages/migrations
   ```

   Read every change that touches a route the importers call: `/invoices`, `/doc-import/*`, `/warehouse/movement`,
   `/warehouse/product`, `/warehouse/stock-level`, `/invoicing/contact`, sign-in. A change in what a role may read
   or write is the one that matters most (section 4 is its live check).

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

**Done when** `plan` shows no `STOP`, each store is either reachable or declared skipped, `checkout` is `ok` with
the server's change read, and `grant` is `ok` for every org of the run.
