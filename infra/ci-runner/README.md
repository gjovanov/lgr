# Self-hosted CI runner for lgr's Linux jobs (mars)

## Why

lgr is a **private** repository, so every GitHub-hosted minute comes out of the account's monthly
allowance (2,000 included; Windows minutes count 2x and macOS 10x). In October 2026 it ran out
on the 7th. About $20 of overage followed, and then GitHub refused every job for the rest of the
month, the Linux gate included. #125 moved the macOS and Windows work to on-demand and tag-time.
This moves the Linux jobs, the bulk of what remains (about 1,300 minutes a week at October's
pace), onto mars, where they cost nothing. Self-hosted jobs are not billed, so they keep running
even when the allowance is gone.

## Kill switch: one repository variable

The Linux jobs read their runner from the repository variable `LGR_LINUX_RUNNER`:

| Value | Where the Linux jobs run |
|---|---|
| `["self-hosted","lgr-mars"]` | mars (free) |
| unset, or `"ubuntu-latest"` | GitHub-hosted (billed) |

```bash
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '["self-hosted","lgr-mars"]'   # mars
gh variable delete LGR_LINUX_RUNNER -R gjovanov/lgr                                 # hosted
```

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
- Two containers, `gh-runner-lgr-1` and `gh-runner-lgr-2`, so the two Linux jobs of a run go in
  parallel. Each is capped (`--cpus`, `--memory`) so CI cannot starve the k8s VMs that share the
  host.

## Setup (on mars, as root)

```bash
cd /home/gjovanov/gh-runner-lgr        # holds this Dockerfile + entrypoint.sh
docker build -t gh-runner-lgr:2.338.0 .

# State dirs: the runner's identity lives here across restarts. UID 1001 = `runner` in the image.
for i in 1 2; do mkdir -p state-$i && chown 1001:1001 state-$i && chmod 700 state-$i; done

# A registration token (valid 1 h) from a machine with repo-admin `gh`:
#   gh api -X POST repos/gjovanov/lgr/actions/runners/registration-token --jq .token
# Write it to each state dir WITHOUT echoing it (read -s), as `registration-token`.
# The entrypoint uses it once and deletes it.

for i in 1 2; do
  docker run -d --name gh-runner-lgr-$i --restart unless-stopped \
    --cpus 4 --memory 8g --pids-limit 8192 \
    -e REPO_URL=https://github.com/gjovanov/lgr \
    -e RUNNER_NAME=mars-lgr-$i \
    -e RUNNER_LABELS=lgr-mars \
    -v /home/gjovanov/gh-runner-lgr/state-$i:/runner-state \
    gh-runner-lgr:2.338.0
done
```

Check: `gh api repos/gjovanov/lgr/actions/runners --jq '.runners[] | "\(.name) \(.status)"'`
shows both as `online`.

## Operations

- **Logs:** `docker logs -f gh-runner-lgr-1`
- **Restart:** `docker restart gh-runner-lgr-1`. The identity comes back from `state-1`, so no
  new token is needed.
- **Upgrade the runner:** it updates itself in place when GitHub releases a new version, which
  GitHub requires within 30 days. A rebuilt image starts at its own version and updates again.
  To move the baseline, bump `RUNNER_VERSION` and `RUNNER_SHA256` (both from the release notes)
  and rebuild.
- **Remove:** `docker rm -f gh-runner-lgr-1 && rm -rf state-1`, then delete the runner in
  *Settings → Actions → Runners* (or `gh api -X DELETE repos/gjovanov/lgr/actions/runners/<id>`).
- **Disk:** each job's checkout and cargo target live in the container's `_work`, which the next
  job's checkout cleans. `docker system df` shows the total. `docker system prune` does not touch
  running containers.
