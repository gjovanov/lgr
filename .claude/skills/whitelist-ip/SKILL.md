---
name: whitelist-ip
description: Whitelist a public IP in fail2ban on a cluster host (mars / zeus / jupiter) so it stops being banned for SSH, and lift any ban already in force. Use when SSH to a host suddenly fails with "Permission denied (publickey)" or times out from one network but works from another, after a laptop's IP changes (new ISP lease, VPN, hotel/office network), or when onboarding a teammate's IP. Also documents the jump-host (ProxyJump) route via jupiter/zeus for when you are locked out of the target host entirely.
allowed-tools: Bash(ssh:*), Bash(ssh-keygen:*), Bash(scp:*)
---

# Whitelist an IP in fail2ban (and the jump-host fallback)

Cluster hosts run **fail2ban**, which bans source IPs after repeated failed SSH auth.
A ban looks like a hard failure from the banned network while the same key works
fine from elsewhere. Whitelisting is two independent steps — do **both**:

| Step | Effect | Survives restart? |
|---|---|---|
| `ignoreip` in `jail.local` | permanent policy | ✅ yes |
| `fail2ban-client set … addignoreip` | takes effect now | ❌ no |

The runtime command alone is lost on the next `fail2ban` restart. The config alone
does **not** lift a ban already in force. That's why both are needed.

All commands require **root** (prefix `sudo` if not root).

## 0. Confirm it's actually fail2ban

Don't whitelist blind — a wrong username or a missing `authorized_keys` entry
produces the identical `Permission denied (publickey)` error.

```bash
fail2ban-client status                     # which jails exist
fail2ban-client status sshd                # currently banned IPs
grep -E "Ban|Found" /var/log/fail2ban.log | tail -20
```

If the IP is **not** in the "Banned IP list", the problem is authentication, not
fail2ban — check `ssh -v <user>@<host>` output and the target's `authorized_keys`.

## 1. Persistent — `ignoreip` in `jail.local`

Edit `[DEFAULT]` in `/etc/fail2ban/jail.local` (never `jail.conf` — it's replaced
on package upgrade). Append to the existing `ignoreip`, keeping the loopback entries:

```ini
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 <existing…> 46.217.16.233
```

Idempotent one-liner — appends only if the IP isn't already listed:

```bash
IP=46.217.16.233
F=/etc/fail2ban/jail.local
cp -a "$F" "$F.bak.$(date +%F-%H%M%S)"          # always keep a rollback
if grep -qE '^[[:space:]]*ignoreip' "$F"; then
  grep -qF "$IP" "$F" || sed -i -E "s|^([[:space:]]*ignoreip[[:space:]]*=.*)$|\1 $IP|" "$F"
else
  sed -i "0,/^\[DEFAULT\]/s|^\[DEFAULT\]|[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 $IP|" "$F"
fi
grep -E '^[[:space:]]*ignoreip' "$F"            # verify before reloading
```

Then reload. Use **`reload`**, not `restart` — restart drops all jail state:

```bash
fail2ban-client reload        # or: systemctl reload fail2ban
```

## 2. Runtime — apply now and clear the current ban

```bash
IP=46.217.16.233
fail2ban-client set sshd addignoreip "$IP"
fail2ban-client set sshd unbanip "$IP"
```

`unbanip` prints an error if the IP isn't currently banned — harmless, ignore it.

Repeat for every jail that matters (`fail2ban-client status` lists them);
`sshd` is the usual one, but `recidive` re-bans repeat offenders for much longer
and is easy to miss:

```bash
fail2ban-client set recidive addignoreip "$IP"
fail2ban-client set recidive unbanip "$IP"
```

## 3. Verify

```bash
fail2ban-client get sshd ignoreip          # IP present
fail2ban-client status sshd                # IP gone from "Banned IP list"
```

Then reconnect from the whitelisted machine.

## Locked out of the target host? Go through a jump host

The three cluster zones are **mars**, **zeus**, and **jupiter** (`CLAUDE.md` →
"K8s deployment placement"). A ban is **per host**, so a host that hasn't banned
you is a working way in — log into jupiter or zeus and run the steps above on the
banned host from there.

### One-off, no config

```bash
ssh -J <user>@<jupiter-ip> <user>@<mars-address>
```

`-J` tunnels through jupiter. Your key authenticates **from your laptop at both
hops** — the private key is never copied onto the jump host, which is why this is
preferred over `ForwardAgent yes`.

To fix fail2ban on mars without holding an interactive session open:

```bash
ssh -J <user>@<jupiter-ip> <user>@<mars-address> \
  'sudo fail2ban-client set sshd unbanip 46.217.16.233'
```

### Permanent — `~/.ssh/config`

```
Host jupiter
  HostName <jupiter-public-ip>
  User <user>
  IdentityFile ~/.ssh/mars
  IdentitiesOnly yes

Host zeus
  HostName <zeus-public-ip>
  User <user>
  IdentityFile ~/.ssh/mars
  IdentitiesOnly yes

Host mars
  HostName <mars-address-as-seen-from-jupiter>
  User <user>
  IdentityFile ~/.ssh/mars
  IdentitiesOnly yes
  ProxyJump jupiter          # swap to zeus if jupiter is unreachable
```

After this, plain `ssh mars`, `scp`, and `ssh mars kubectl -n lgr get secrets`
all route through the jump automatically.

**`HostName` for mars may be a private address** (e.g. a `10.x` WireGuard IP)
reachable only from inside the cluster network — that is normal, and it's why
mars often has no working public DNS name. Ask a teammate which address to use
from the jump host.

## Troubleshooting

- **`Permission denied (publickey)` as the wrong user** — `ssh <host>` uses your
  *local* username. On a host where you're `root`, `ssh 94.130.141.98` tries
  `root@…`. Always name the user: `ssh gjovanov@94.130.141.98`.
- **Which key is being offered** —
  `ssh -v <user>@<host> 2>&1 | grep -Ei 'Offering|Authentications that can continue|no such identity'`.
  No `Offering` line means that machine has no private key to present.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`** — the host key differs from
  `known_hosts`. Usually a rebuilt server, but it is also what a MITM looks like.
  **Verify the fingerprint out-of-band first**, then `ssh-keygen -R <host>`.
- **Re-banned immediately** — a client retrying with a bad key (an editor, a
  sync tool, a mounted drive) trips the jail again. Check
  `grep Found /var/log/fail2ban.log | tail` for the source.
- **Dynamic IP** — a home ISP lease changes and the whitelist goes stale. Prefer
  whitelisting the provider's CIDR, or use the jump host as the durable route.

## Scope note

fail2ban is only one layer. If the whitelist doesn't restore access, the block
may be a **host firewall** (`ufw status`, `iptables -S`), a **Hetzner Cloud
Firewall** (web console / `hcloud firewall`), or `sshd` itself
(`AllowUsers`/`AllowGroups` in `/etc/ssh/sshd_config`). Those live in the
`k8s-cluster-multi` / `lgr-deploy` repos, not in this one.
