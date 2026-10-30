# Self-hosted CI runner for lgr's Linux jobs (mars)

## Why

> **Since 2026-10-30 these runners are the FALLBACK.** lgr went public, GitHub-hosted minutes cost
> a public repository nothing, and the Linux jobs run hosted again (`LGR_LINUX_RUNNER` =
> `"ubuntu-24.04"`), the suite split across three runners. Flip back to mars when GitHub's queue
> is the slow part: hosted runners are shared with roomler-ai's CI under one account, 20 jobs at a
> time, and a burst there has kept lgr's jobs waiting 3-5 minutes. Fork pull requests from any
> outside contributor need approval before they run (`all_external_contributors`), which matters
> most while these runners take jobs: one runs on mars.

Until then the reason was money. lgr was a **private** repository, so every GitHub-hosted minute
came out of the account's monthly allowance (2,000 included; Windows minutes count 2x and macOS
10x). In October 2026 it ran out on the 7th. About $20 of overage followed, and then GitHub
refused every job for the rest of the month, the Linux gate included. #125 moved the macOS and
Windows work to on-demand and tag-time, and the Linux jobs, the bulk of what remained (about 1,300
minutes a week at October's pace), moved onto mars, where they cost nothing.

## Kill switch: one repository variable

The Linux jobs read their runner from the repository variable `LGR_LINUX_RUNNER`:

| Value | Where the Linux jobs run |
|---|---|
| `"ubuntu-24.04"`, or unset | GitHub-hosted (the default since 2026-10-30) |
| `["self-hosted","lgr-mars"]` | mars, the fallback |

```bash
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '["self-hosted","lgr-mars"]'   # mars
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '"ubuntu-24.04"'               # hosted
```

⚠ `ubuntu-24.04`, not `ubuntu-latest`: that label began moving to Ubuntu 26 on 2026-10-19, and
the image is what the tests, the apt package names and mongodb-memory-server's mongod depend on.

⚠ While the variable points at mars, a job with no online runner **queues** instead of failing.
If CI sits at "Waiting for a runner", check the containers below, or flip the variable.

## What runs where

- `Dockerfile` + `entrypoint.sh`: the official `actions/runner` release, SHA-256 checked, on
  `ubuntu:24.04`. That is the same OS as GitHub's `ubuntu-latest`, so `apt-get` package names
  and the `mongod` that `mongodb-memory-server` downloads behave the same.
- Jobs run **inside** the container as the unprivileged user `runner`. Its `sudo` is local to
  the container, so a workflow's `sudo apt-get install` never changes mars.
- No Docker socket is mounted. A job cannot reach the host's Docker, and so cannot reach root on
  mars.
- Two containers, `gh-runner-lgr-1` and `gh-runner-lgr-2`, so two Linux jobs go in parallel.
  Each is capped (`--cpus`, `--memory`) so CI cannot take the whole host from the k8s VMs that
  share it. ⚠ 8 CPUs each since 2026-10-30 (was 4, raised live with `docker update --cpus 8`):
  as the fallback they rarely run, and the suite takes 231 s on 8 instead of 352 s on 4. Both busy
  at once can now use all 16 of mars's cores, so a fallback period overlapping an image build is
  slower for both.

## Setup (on mars, as a `docker`-group user)

```bash
cd /home/gjovanov/gh-runner-lgr        # holds this Dockerfile + entrypoint.sh
docker build -t gh-runner-lgr:2.338.0 .

# The runner's identity (its credentials) lives in a NAMED volume, under the root-only
# /var/lib/docker, never in a bind-mounted host directory. `runner` is UID 10001 in the image,
# chosen because no account on mars has it. The image's first draft used useradd's default 1001,
# which on mars is a person's login, and that handed them the state dir.
#
# A registration token (valid 1 h) from a machine with repo-admin `gh`:
#   gh api -X POST repos/gjovanov/lgr/actions/runners/registration-token --jq .token
read -rs T                             # paste the token; nothing is echoed or kept in history
for i in 1 2; do
  docker volume create gh-runner-lgr-$i-state
  printf '%s' "$T" | docker run --rm -i --user root --entrypoint sh \
    -v gh-runner-lgr-$i-state:/s gh-runner-lgr:2.338.0 \
    -c 'umask 077; cat > /s/registration-token; chown -R 10001:10001 /s; chmod 700 /s'
done
unset T
# The entrypoint uses the token once and deletes it.

# --tmpfs /tmp: mongodb-memory-server puts every test file's mongod data dir in /tmp, and on the
# container's overlay filesystem (mars: RAID1) each one took ~10 s to start, so per-file setup
# alone ran the test job into its 30-minute timeout (2026-10-10; the tests themselves took 257 s).
# In RAM it starts the way it does on a hosted runner. It counts against --memory.
for i in 1 2; do
  docker run -d --name gh-runner-lgr-$i --restart unless-stopped \
    --cpus 8 --memory 8g --pids-limit 8192 \
    --tmpfs /tmp:rw,exec,nosuid,size=3g \
    -e REPO_URL=https://github.com/gjovanov/lgr \
    -e RUNNER_NAME=mars-lgr-$i \
    -e RUNNER_LABELS=lgr-mars \
    -v gh-runner-lgr-$i-state:/runner-state \
    gh-runner-lgr:2.338.0
done
```

Check: `gh api repos/gjovanov/lgr/actions/runners --jq '.runners[] | "\(.name) \(.status)"'`
shows both as `online`.

## Operations

- **Logs:** `docker logs -f gh-runner-lgr-1`
- **Restart:** `docker restart gh-runner-lgr-1`. The identity comes back from the
  `gh-runner-lgr-1-state` volume, so no new token is needed.
- **Upgrade the runner:** it updates itself in place when GitHub releases a new version, which
  GitHub requires within 30 days. A rebuilt image starts at its own version and updates again.
  To move the baseline, bump `RUNNER_VERSION` and `RUNNER_SHA256` (both from the release notes)
  and rebuild.
- **Remove:** `docker rm -f gh-runner-lgr-1 && docker volume rm gh-runner-lgr-1-state`, then delete the runner in
  *Settings → Actions → Runners* (or `gh api -X DELETE repos/gjovanov/lgr/actions/runners/<id>`).
- **`/tmp` fills up when runs are interrupted.** A cancelled or killed job never stops its test
  `mongod`, so its data dir (up to ~300 MB of preallocated journal) stays in the 3 GB tmpfs. Once it
  is full, every job fails with `ENOSPC` somewhere unrelated, a rustup download or a temp file in a
  test (2026-10-25: 456 such dirs on `gh-runner-lgr-2`). Every Linux job in `ci.yml` that runs tests starts by
  clearing every `/tmp/mongo-mem-*` no live `mongod` holds. To check by hand:
  `docker exec gh-runner-lgr-2 df -h /tmp`.
- **Disk:** each job's checkout lives in the container's `_work`, which the next job's checkout
  cleans. Since 2026-10-30 cargo's target does NOT: `ci.yml` keeps it in the runner's home,
  `~/.cache/lgr-cargo-target`, so a run builds on the last one's artifacts instead of restoring
  ~1 GB from GitHub's cache. Over 6,000 MB the job drops it whole (never file by file: cargo's
  fingerprints outlive deleted outputs). (The per-file test durations that split the suite into
  shards live in the Actions cache, not here: hosted runners keep nothing.) `docker system df`
  shows the total. `docker system prune` does not touch running containers.
