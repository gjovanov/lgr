# Self-hosted CI runners for lgr's Linux jobs (mars and jupiter)

## Why

> **Since 2026-11-12 there is a third runner, and it is not on mars.** Two runners were a
> queue: over the first 25 green pull-request runs after #654 a run's own work took 7 minutes, and
> its wall clock 10.7 at the median and 22.8 at the 90th percentile, all of the difference waiting
> for a runner (#653). The same runs replayed on three runners gave 7.5 and 13. Mars has no room
> for a third (two runners of 8 CPUs are all 16 of its cores), so the third runs on jupiter, in a
> guest of its own: "The runner on jupiter", below. There the suite takes 3 min 10 s where mars
> takes 6 min 37 s, for the same 8,142 tests (2026-11-12).
>
> **It is in service since 2026-11-12T10:54Z, at its second try.** It first ran for 98 minutes that
> morning and was taken out again. Twice as fast, it lost a race in the product that the mars
> runners win: one test (`cash-invoice-receipts.flow`, "two payments at once") failed in 2 of its 9
> whole suite runs and in none of about 300 on mars, while every other test passed every time. The
> race was the product's (#699: of two payments at once, the one refused was told its receipt
> cannot be printed). #700 fixed it, fourteen whole suite runs on this runner were green with the
> fix, and the variable below went back to `lgr-linux`.
>
> ⚠ A runner that is faster is a runner whose timing nothing was tuned on. A test that goes red
> here and stays green on mars is a race to find, not a flake to rerun, and `lgr-mars` takes the
> runner out of service for as long as the finding takes.

> **Since 2026-10-30 the reason is the QUEUE, not money.** lgr went public, so GitHub-hosted
> minutes cost it nothing, but hosted runners are shared with roomler-ai's CI under one account,
> 20 jobs at a time. Tried that day: a run waited 37 of its 47 minutes behind 153 of roomler-ai's
> jobs, while the same work takes ~5 minutes here. So master and this repository's own branches run
> on mars, and **pull requests from forks run hosted** (`ci.yml` routes them there whatever the
> variable says): code from outside never runs on mars. Fork pull requests from any outside
> contributor also need approval before they run (`all_external_contributors`). An organization of
> lgr's own would give it its own 20 hosted jobs; then the variable can say hosted for everything.

Before that the reason was money. lgr was a **private** repository, so every GitHub-hosted minute
came out of the account's monthly allowance (2,000 included; Windows minutes count 2x and macOS
10x). In October 2026 it ran out on the 7th. About $20 of overage followed, and then GitHub
refused every job for the rest of the month, the Linux gate included. #125 moved the macOS and
Windows work to on-demand and tag-time, and the Linux jobs, the bulk of what remained (about 1,300
minutes a week at October's pace), moved onto mars, where they cost nothing.

## Kill switch: one repository variable

The Linux jobs (all but a fork's) read their runner from the repository variable `LGR_LINUX_RUNNER`:

| Value | Where the Linux jobs run |
|---|---|
| `["self-hosted","lgr-linux"]` | all three runners, two on mars and one on jupiter (the default since 2026-11-12): the suite in one job on 8 CPUs |
| `["self-hosted","lgr-mars"]` | the two mars runners only (the default from 2026-10-30 to 2026-11-12). It takes the jupiter runner out of service without touching it |
| `"ubuntu-24.04"`, or unset | GitHub-hosted: the suite in three shards of 4 CPUs |

```bash
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '["self-hosted","lgr-linux"]'  # all three
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '["self-hosted","lgr-mars"]'   # mars only
gh variable set LGR_LINUX_RUNNER -R gjovanov/lgr --body '"ubuntu-24.04"'               # hosted
```

A job goes to a runner that carries every label it asks for. The labels are kept by GitHub, not by
the container: `RUNNER_LABELS` is read once, when a runner registers. The two mars runners
registered as `lgr-mars` and were given `lgr-linux` afterwards
(`gh api -X POST repos/gjovanov/lgr/actions/runners/<id>/labels -f 'labels[]=lgr-linux'`), and the
jupiter runner registered as `lgr-linux,lgr-jupiter`. A runner that registers again gets what its
`RUNNER_LABELS` says, which is why the commands below name both labels. `lgr-jupiter` and `lgr-mars`
also let a branch pin a run to one host (a scratch branch whose `runs-on` names the label, started
with `gh workflow run ci.yml --ref <branch>`): that is how the jupiter runner ran the whole suite
before any real job could reach it.

A job that is already waiting keeps the labels it asked for: the variable is read when a run starts.

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
- On jupiter the same image runs as one container inside a guest of its own, never on the host:
  "The runner on jupiter", below.
- On mars, two containers, `gh-runner-lgr-1` and `gh-runner-lgr-2`, so two Linux jobs go in parallel.
  Each is capped (`--cpus`, `--memory`) so CI cannot take the whole host from the k8s VMs that
  share it. ⚠ 8 CPUs each since 2026-10-30 (was 4, raised live with `docker update --cpus 8`): the
  suite takes 231 s on 8 instead of 352 s on 4. Both busy at once can use all 16 of mars's cores,
  so a CI run overlapping an image build (deploy-prod builds on mars) is slower for both; mars's
  load is ~1 otherwise. Back to 4: `docker update --cpus 4 gh-runner-lgr-1 gh-runner-lgr-2`.

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
    -e RUNNER_LABELS=lgr-linux,lgr-mars \
    -v gh-runner-lgr-$i-state:/runner-state \
    gh-runner-lgr:2.338.0
done
```

Check: `gh api repos/gjovanov/lgr/actions/runners --jq '.runners[] | "\(.name) \(.status) \([.labels[].name] | join(","))"'`
shows `mars-lgr-1`, `mars-lgr-2` and `jupiter-lgr-1` as `online`, each with `lgr-linux`.

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
  ~1 GB from GitHub's cache. Over 4,500 MB the job drops it whole (never file by file: cargo's
  fingerprints outlive deleted outputs). (The per-file test durations that split the suite into
  shards live in the Actions cache, not here: hosted runners keep nothing.) `docker system df`
  shows the total. `docker system prune` does not touch running containers.

## The runner on jupiter

### What it is

A guest of its own on jupiter, `lgr-ci-runner-1`: 8 vCPUs, 10 GiB, a 60 GB disk, Ubuntu 24.04 with
the distribution's Docker. Inside it runs one container from this directory's image, as on mars:
`gh-runner-lgr-1`, runner name `jupiter-lgr-1`, the same caps and the same 3 GB tmpfs for `/tmp`.

Jupiter has no Docker and should not get one. It carries cluster guests, and here a job's code has
a hypervisor between itself and them.

### What it costs the host

- **Memory is counted as allocated, never as free.** A guest's page cache fills its whole
  allocation sooner or later, which is what took a cluster guest down on zeus on 2026-10-31. The
  cluster guests' 104 GiB and this guest's 10 make 114 of 125. ⚠ That leaves no room for a second
  such guest or a bigger one while `k8s-worker-3` is 96 GiB.
- **If the host does run out, the kernel takes this guest first.** `lgr-ci-runner-up` gives its
  QEMU process `oom_score_adj` 1000 at every start.
- **CPU weight 10, against the cluster guests' 100**, so they win whenever the host is short.
  ⚠ On this host libvirt writes `cpu_shares` straight into the cgroup's `cpu.weight`: the 128 this
  guest had for its first minutes put it ABOVE the cluster guests. Read
  `/sys/fs/cgroup/machine.slice/machine-qemu*.scope/cpu.weight`, do not trust the number you set.
- Measured while it ran the suite: 6 to 7 of the host's 32 threads, and the cluster worker's own
  use did not move.

### What it can reach: the public internet, and nothing else

Two layers, each enough without the other.

| Layer | Where | What it closes |
|---|---|---|
| `vm/lgr-ci-guard.nft`, table `inet lgr_ci_guard` | on jupiter, loaded by `lgr-ci-guard.service` before libvirt starts | From the guest's bridge: every private range, the fleet hosts' own public addresses but for their public web (ports 80 and 443), all IPv6, and every service of jupiter itself. Into the guest's network: any new connection |
| `lgr-ci-container-guard` (in `vm/user-data.tmpl`) | in the guest, started with Docker | From a container: the same destinations, and the guest itself |

- **Closed means refused, at once.** A connection to a closed address is reset in 2 to 3 ms, never
  left to time out. ⚠ The first form of the guard dropped silently, and it closed the fleet hosts'
  public web as well. The portal's page carries a script from one of those addresses (the analytics
  tag the global node adds, `portal-api/src/spa-fallback.ts`), so each Playwright page waited for
  it until the test's 30 s were over, and failed three times; on mars and on a hosted runner the
  script simply loads. The pattern to remember: a page that names an address which neither answers
  nor refuses never finishes loading.
- **Why the fleet hosts' public addresses are closed at all.** The guest's traffic leaves with
  jupiter's address, and another host must not take it for jupiter (the mesh between the hosts,
  ssh). What those hosts serve to everybody stays open, so a test sees our public sites as any
  runner outside does.
- The guest asks the host for nothing. Its address is static and its resolvers are public, so its
  network has no DHCP and no DNS (`vm/ci-net.xml`).
- The host's layer is a table of its own, like `ssh_guard`. No other tool writes to it, it names
  the bridge instead of pointing at it (so it holds before the bridge exists), and a refusal in it
  is final whatever the host's other tables accept.
- The guest's way out is named too. The host forwards only what it has a rule for, so without the
  chain `LGR_CI_FWD` that `lgr-ci-runner-up` makes, the guest has no internet. That is the
  fail-safe: no guard, no way out, and a runner that cannot reach GitHub takes no job.
- ⚠ **The guest is not set to autostart in libvirt, on purpose.** `lgr-ci-runner.service` is the
  one path that starts it at boot, and it refuses when the guard table is not loaded.
- A job cannot change the layer inside the guest: its `sudo` is the container's.
- CI needs none of what is closed. Two whole CI runs on this runner left both layers' counters
  where the probes below had put them, and a whole Playwright run added only the public web of one
  fleet host (that script).

### Files (`vm/`)

| File | Goes to | What it is |
|---|---|---|
| `ci-net.xml` | libvirt on jupiter | the guest's network: NAT, `virbr-ci`, 10.10.130.0/24 |
| `lgr-ci-guard.nft` | `/etc/lgr-ci-guard.nft` | the host's layer. `@@FLEET_V4@@` is the fleet hosts' public addresses, which are not in this repository |
| `lgr-ci-guard.service` | `/etc/systemd/system/` | loads it, before `libvirtd.service` |
| `lgr-ci-runner-up` | `/usr/local/sbin/` | checks the guard, opens the way out, starts the network and the guest, marks the guest for the OOM killer. Running it again changes nothing |
| `lgr-ci-runner.service` | `/etc/systemd/system/` | runs it at boot; `Requires=lgr-ci-guard.service` |
| `user-data.tmpl`, `meta-data`, `network-config` | the guest's cloud-init seed | Docker, the layer inside the guest, the static address. `@@OPS_KEY@@` is the public half of the key jupiter reaches the guest with, `@@FLEET_V4_LINES@@` the same addresses, one a line, indented six spaces |
| `register.sh` | the guest | the commands of "Setup" above for this one runner; the registration token arrives on stdin |
| `guard-check.sh` | the guest, and a container in it | what can this place reach? |

`packages/tests/src/unit/ci-runner-vm.test.ts` keeps these files agreeing with each other: one
bridge name, one subnet, the same closed ranges in every layer, the guard checked before the guest
is started. A guard that names a bridge nobody uses closes nothing, and says nothing.

### Setup (on jupiter, as a user with `sudo`)

In a directory that holds `vm/`. A file that came from a Windows checkout made before
`.gitattributes` named this directory may carry carriage returns: `tr -d '\r'`.

```bash
# 1. The guard, before anything else exists.
fleet='<the fleet hosts' public addresses, separated by ", ">'
sed "s/@@FLEET_V4@@/$fleet/" vm/lgr-ci-guard.nft > lgr-ci-guard.nft
sudo nft -c -f lgr-ci-guard.nft                       # a dry run: syntax only
sudo install -m 0644 lgr-ci-guard.nft /etc/lgr-ci-guard.nft
sudo install -m 0644 vm/lgr-ci-guard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lgr-ci-guard.service
sudo nft list table inet lgr_ci_guard

# 2. The network.
sudo virsh net-define vm/ci-net.xml && sudo virsh net-autostart ci-net && sudo virsh net-start ci-net

# 3. The image, its signature and its checksum.
base=https://cloud-images.ubuntu.com/noble/current
curl -fsSLO $base/SHA256SUMS && curl -fsSLO $base/SHA256SUMS.gpg
gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg SHA256SUMS.gpg SHA256SUMS
curl -fSLO $base/noble-server-cloudimg-amd64.img
grep ' \*noble-server-cloudimg-amd64.img$' SHA256SUMS | sha256sum -c -

# 4. The disk (a copy of its own, no backing file) and the cloud-init seed.
sudo qemu-img convert -f qcow2 -O qcow2 noble-server-cloudimg-amd64.img /var/lib/libvirt/images/lgr-ci-runner-1.qcow2
sudo qemu-img resize /var/lib/libvirt/images/lgr-ci-runner-1.qcow2 60G
ssh-keygen -t ed25519 -N '' -C lgr-ci-runner@jupiter -f ~/.ssh/lgr_ci_runner_ed25519
#    user-data = vm/user-data.tmpl with its two placeholders filled in (see "Files")
sudo install -d /var/lib/libvirt/cloud-init/lgr-ci-runner-1
sudo install -m 0644 user-data vm/meta-data vm/network-config /var/lib/libvirt/cloud-init/lgr-ci-runner-1/
( cd /var/lib/libvirt/cloud-init/lgr-ci-runner-1 && sudo cloud-localds -N network-config cidata.iso user-data meta-data )

# 5. The definition. Nothing starts here, and it is never set to autostart.
sudo virt-install --name lgr-ci-runner-1 --memory 10240 --vcpus 8 --cpu host-passthrough --machine q35 \
  --osinfo detect=on,require=off --import \
  --disk path=/var/lib/libvirt/images/lgr-ci-runner-1.qcow2,format=qcow2,bus=virtio,discard=unmap \
  --disk path=/var/lib/libvirt/cloud-init/lgr-ci-runner-1/cidata.iso,device=cdrom,bus=sata \
  --network network=ci-net,model=virtio,mac=52:54:00:0a:82:0a \
  --graphics none --console pty,target_type=serial --rng /dev/urandom --memballoon virtio \
  --noautoconsole --print-xml > domain.xml
sudo virsh define domain.xml
sudo virsh schedinfo lgr-ci-runner-1 --config --set cpu_shares=10

# 6. Start it the way a boot does.
sudo install -m 0755 vm/lgr-ci-runner-up /usr/local/sbin/
sudo install -m 0644 vm/lgr-ci-runner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lgr-ci-runner.service
#    The first boot installs Docker and restarts once (85 s on 2026-11-12). Then:
ssh -i ~/.ssh/lgr_ci_runner_ed25519 ops@10.10.130.10 cloud-init status        # status: done

# 7. The runner. Copy this directory's Dockerfile and entrypoint.sh and vm/register.sh to the
#    guest's ~/gh-runner-lgr, build the image there, and register with a token on stdin, sent from
#    a machine with repo-admin `gh`:
ssh -i ~/.ssh/lgr_ci_runner_ed25519 ops@10.10.130.10 'cd ~/gh-runner-lgr && sudo docker build -t gh-runner-lgr:2.338.0 .'
gh api -X POST repos/gjovanov/lgr/actions/runners/registration-token --jq .token \
  | ssh jupiter 'ssh -i ~/.ssh/lgr_ci_runner_ed25519 ops@10.10.130.10 "bash ~/gh-runner-lgr/register.sh"'
```

⚠ A script sent to `ssh host 'bash -s'` on stdin stops silently at the first inner `ssh` that has no
`-n`: that `ssh` reads the rest of the script as its own input.

### Checks

```bash
# In the guest, and again in a container on it
# (sudo docker run --rm -v ~/guard-check.sh:/c.sh:ro --entrypoint bash ubuntu:24.04 /c.sh open ...):
./guard-check.sh open github.com:443 open 1.1.1.1:53 open <another fleet host's public address>:443 \
  closed 10.10.130.1:22 closed <a cluster node>:6443 closed <another host over WireGuard>:22 \
  closed <a fleet host's public address>:22 closed 169.254.169.254:80

sudo nft list table inet lgr_ci_guard                                  # on jupiter: what it refused
sudo iptables -nvL LGR_CI_GUARD; sudo iptables -nvL LGR_CI_GUARD_IN    # in the guest: the same
```

On 2026-11-12, 43 of 43 probes came out as expected (21 from the guest, 22 from a container). Every
closed one answered in 2 to 3 ms, each refusal was counted by the layer it belongs to, and the same
cluster ports answered from jupiter itself. ⚠ jupiter's own public address on port 443 is
rewritten to a cluster guest before the guard sees it, and is refused there as a private
destination: the guard sits after that rewrite. The other hosts' port 443 is open.

Then the runner itself, before any real job can reach it: a scratch branch whose three `runs-on`
lines in `ci.yml`, and the one in `e2e-nightly.yml`, name `["self-hosted","lgr-jupiter"]`, started
with `gh workflow run`. ⚠ Run both: the unit suite passed twice here while the Playwright run could
not load a single page (above). The branch and its runs are deleted afterwards.

### Operations

- **Start:** `sudo systemctl start lgr-ci-runner` (after a shutdown: `restart`). ⚠ Not `virsh
  start`: the guest would run without its mark for the OOM killer.
- **Stop:** `sudo virsh shutdown lgr-ci-runner-1` (9 s). The runner goes offline and waiting jobs
  go to the other runners.
- **Out of service without touching the host:** the variable back to `["self-hosted","lgr-mars"]`.
- **Into the guest:** from jupiter, `ssh -i ~/.ssh/lgr_ci_runner_ed25519 ops@10.10.130.10`.
  Nothing else reaches it.
- **The container:** everything under "Operations" above, inside the guest.
- **Updates:** the guest installs security updates by itself. Docker's `live-restore` keeps a
  running job across an update of the daemon. A new kernel waits for a restart of the guest, when
  no job runs: `sudo virsh reboot lgr-ci-runner-1`. The container, the layer inside the guest and
  the runner come back by themselves, in about a minute (a stop and a start through the unit,
  2026-11-12).
- **After a change to the host's firewall:** `sudo systemctl restart lgr-ci-runner` puts
  `LGR_CI_FWD` back and does not restart a running guest. The guard table is not iptables' and is
  not touched by a rewrite of those rules; `sudo nft list table inet lgr_ci_guard` says whether it
  is there.
- **A test that is red here and green on mars:** take the runner out (`lgr-mars`), then measure on
  it alone. A scratch branch whose `runs-on` lines name `["self-hosted","lgr-jupiter"]` and whose
  `Test` step runs the suite in a loop (with the job's `timeout-minutes` raised), started with
  `gh workflow run ci.yml --ref <branch>`, gives the rate: 2 of 9 for #699, then 14 of 14 with the
  fix. ⚠ Whole suite runs, one after another. Copies of one test file side by side collide with
  each other and measure nothing. ⚠ A cancelled job leaves its processes running in the runner's
  container: one such job held a mars runner at its memory cap for 45 minutes on 2026-11-12. Look
  with `docker exec <runner> ps -eo pid,ppid,etimes,args` and end the tree under the orphaned
  `_temp/*.sh` shell, parents first.
- **Remove it all:**
  ```bash
  sudo systemctl disable lgr-ci-runner.service
  sudo virsh destroy lgr-ci-runner-1; sudo virsh undefine lgr-ci-runner-1
  sudo rm /var/lib/libvirt/images/lgr-ci-runner-1.qcow2
  sudo rm -r /var/lib/libvirt/cloud-init/lgr-ci-runner-1
  sudo virsh net-destroy ci-net; sudo virsh net-undefine ci-net
  sudo iptables -D FORWARD -i virbr-ci -j LGR_CI_FWD; sudo iptables -F LGR_CI_FWD; sudo iptables -X LGR_CI_FWD
  sudo systemctl disable lgr-ci-guard.service; sudo nft delete table inet lgr_ci_guard
  sudo rm /etc/lgr-ci-guard.nft /etc/systemd/system/lgr-ci-guard.service \
          /etc/systemd/system/lgr-ci-runner.service /usr/local/sbin/lgr-ci-runner-up
  gh api -X DELETE repos/gjovanov/lgr/actions/runners/<id>      # and the variable back to lgr-mars
  ```
