---
name: whitelist-ip
description: Whitelist a public IP for SSH on the cluster hosts (mars / zeus / jupiter) in BOTH layers, fail2ban and the nftables ssh_guard rate-limiter, both saved to disk and applied live, and lift any ban already in force. Use when SSH to a host times out from one network but works from another, after a laptop's IP changes (new ISP lease, VPN, hotel/office network), or when onboarding a teammate's IP. Also documents the headless jump-host route via jupiter/zeus for when you are locked out of the target host entirely.
allowed-tools: Bash(ssh:*), Bash(ssh-keygen:*), Bash(scp:*)
---

# Whitelist an IP for SSH on the cluster hosts

Every host (mars, zeus, jupiter) runs **two** independent SSH defenses. An IP counts as
whitelisted only when it is exempt from both:

| Layer | What it blocks | Saved in | Applied live with |
|---|---|---|---|
| **fail2ban** `sshd` jail | a source with 3 auth failures in 10 min, blocked for 1 h | `/etc/fail2ban/jail.d/zz-ignoreip.conf` | `fail2ban-client set sshd addignoreip` |
| **nftables `ssh_guard`** table | an untrusted IPv4 source opening more than 6 new `:22` connections/min (burst 8) | `/etc/ssh-guard.nft`, loaded at boot by `ssh-guard.service` | `nft add element inet ssh_guard trusted_v4` |

Each layer needs both columns. Nothing reads the file until the next restart or reboot,
and the live change is gone after it.

All three hosts were verified identical on 2026-09-30: fail2ban 1.0.2, `sshd` the only
jail, no `jail.local`, no `ufw`. The jail's settings come from `00-sshd.local`, which the
`host-hardening` role in `k8s-cluster-multi` writes. Everything else here was installed by
hand on 2026-07-20 and is in no repo, so the host holds the only copy: `zz-ignoreip.conf`,
`ssh-guard.nft`, `ssh-guard.service` and the `roomler-whitelist-ip` helper.

Everything below runs as root. `gjovanov` has passwordless sudo on all three hosts, so put
the steps in a file and run it with `ssh … 'sudo bash -s' < steps.sh`.

## ⚠ Three ways to make it worse

1. **Never `fail2ban-client reload` (or restart) to apply a whitelist.** In 1.0.2 a reload
   calls `clearAllParams()` → `delIgnoreIP()`, which deletes every entry that was only added
   live, then loads back only what the files hold. Check the file with `fail2ban-client -t`
   and add the IP live instead.
2. **Never put `ignoreip` in a new file** (`jail.local`, another `jail.d/*.conf`). fail2ban
   reads `jail.conf` → `jail.d/*.conf` → `jail.local` → `jail.d/*.local`, and a later
   `ignoreip` **replaces** the earlier one. That silently drops mars, jupiter and zeus from
   the list, and the jump-host route below depends on them. Append to the single line in
   `zz-ignoreip.conf`.
3. **Never use `/usr/local/sbin/roomler-whitelist-ip` for a permanent entry.** It manages
   the operator's *roaming* slot. It **overwrites** `/etc/ssh-guard-roam.nft` with one IP,
   so the previous roaming IP drops out of the boot set, and it adds the IP to fail2ban
   live only. Use it for "the laptop I'm on right now" and nothing else.

## 0. Diagnose: is it a block at all?

Both layers work by dropping packets, so a block shows up as
`connect to host … port 22: Connection timed out` while `ping` and `:443` still answer.
**`Permission denied (publickey)` never means a ban.** It means the connection got through
and authentication failed: a wrong user, a wrong key, or a missing `authorized_keys`
entry. Whitelisting won't fix it.

```bash
fail2ban-client status sshd | grep -wF "$IP"             # banned by fail2ban?
grep -F "$IP" /var/log/fail2ban.log | tail               # its Found/Ban history
nft list set inet ssh_guard trusted_v4 | grep -wF "$IP"  # exempt from the rate-limiter?
```

## 1. fail2ban

```bash
IP=46.217.16.233
F=/etc/fail2ban/jail.d/zz-ignoreip.conf
cp -a "$F" "$F.bak.$(date +%F-%H%M%S)"                   # always keep a rollback
grep -qwF "$IP" "$F" || sed -i -E "s|^([[:space:]]*ignoreip[[:space:]]*=.*[^[:space:]])[[:space:]]*$|\1 $IP|" "$F"
fail2ban-client -t                                       # the config still parses
fail2ban-client -d | grep -F "'sshd', 'addignoreip'"     # what the next restart loads
fail2ban-client set sshd addignoreip "$IP"               # live, now
fail2ban-client set sshd unbanip "$IP"                   # lift a ban already in force
```

Whitelisting does not lift an existing ban, which is why `unbanip` is there. It prints an
error if the IP isn't banned; that's harmless. If `fail2ban-client status` ever lists
another jail (e.g. `recidive`), repeat the last two lines for it. `-t` and `-d` print
`WARNING 'allowipv6' not defined` on every host. That comes from the stock filter, not
from your edit.

## 2. ssh_guard

Append an `add element` line, the same way `95.180.164.247` was added. Before touching the
live set, load the file into a throwaway network namespace exactly as `ssh-guard.service`
would at boot. That test is the only evidence the boot path works: the unit shows
`inactive` on all three hosts because each was last booted before it was installed, so it
has never actually run.

```bash
IP=46.217.16.233
F=/etc/ssh-guard.nft
cp -a "$F" "$F.bak.$(date +%F-%H%M%S)"
grep -qwF "$IP" "$F" || printf 'add element inet ssh_guard trusted_v4 { %s }\n' "$IP" >> "$F"
unshare -n sh -c 'nft -f /etc/ssh-guard.nft && { [ ! -f /etc/ssh-guard-roam.nft ] || nft -f /etc/ssh-guard-roam.nft; } && nft list set inet ssh_guard trusted_v4'
nft add element inet ssh_guard trusted_v4 "{ $IP }"      # live, now
```

The `unshare -n` line has to print a set that contains `$IP`. If it errors, restore the
backup. **Never run `nft -f /etc/ssh-guard.nft` on the live host.** The file declares the
table's rules, so loading it again adds a second copy of every rule to the running chain.

## 3. Verify, then check what a restart would lose

```bash
fail2ban-client get sshd ignoreip                        # IP listed
fail2ban-client status sshd                              # IP not in "Banned IP list"
nft list set inet ssh_guard trusted_v4                   # IP listed
```

An entry that was only added live disappears at the next fail2ban restart or the next
reboot. Package upgrades restart fail2ban: on 2026-09-30, unattended-upgrades updated
openssl on jupiter at 06:55:04, and fail2ban restarted a second later. Anything the
commands below print is someone's earlier whitelist that won't survive. Either save it to
the file or let it go on purpose.

```bash
# fail2ban: live entries missing from the file (127.0.0.0/8 is only 127.0.0.1/8 normalised)
comm -23 <(fail2ban-client get sshd ignoreip | sed -n 's/^[|`]- //p' | sort) \
         <(fail2ban-client -d | grep -F "'sshd', 'addignoreip'" | tr -d "[]'," | tr ' ' '\n' | sed '1,3d' | sort)
# ssh_guard: live elements missing from the boot files
elems() { sed -n '/elements/,/}/p' | tr -d '{}=,\t' | sed 's/elements//' | tr -s ' \n' '\n' | sed '/^$/d' | sort; }
comm -23 <(nft list set inet ssh_guard trusted_v4 | elems) \
         <(unshare -n sh -c 'nft -f /etc/ssh-guard.nft && { [ ! -f /etc/ssh-guard-roam.nft ] || nft -f /etc/ssh-guard-roam.nft; } && nft list set inet ssh_guard trusted_v4' | elems)
```

Then reconnect from the whitelisted machine.

## Locked out of the target host? Go through a jump host

A block applies to one host only, and every host's lists include the other two. So a host
that hasn't blocked you is a way in: connect *through* jupiter or zeus, and the target sees
the jump host's whitelisted address instead of yours. The hosts' addresses are in your
`~/.ssh/config`.

```bash
ssh -J gjovanov@<jupiter-ip> gjovanov@<mars-ip>          # interactive
```

`-J` authenticates **from your laptop at both hops**, so no key is ever copied to the jump
host; that's why it beats `ForwardAgent yes`. But `-J` passes only `-l`, `-p`, `-F` and `-v`
to the first hop, never `-i` or `-o`, so that hop uses whatever key `~/.ssh/config` names
for it. If that key has a passphrase and no ssh-agent holds it, a run with no terminal
(`BatchMode=yes`, or Claude running the command) fails with
`Permission denied (publickey)`. Spell out both hops instead:

```bash
K=~/.ssh/id_ed25519      # a fleet-authorized key with no passphrase
ssh -F /dev/null -i $K -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ProxyCommand="ssh -F /dev/null -i $K -o IdentitiesOnly=yes -o BatchMode=yes -W %h:%p gjovanov@<jupiter-ip>" \
    gjovanov@<mars-ip> 'sudo bash -s' < steps.sh
```

`-F /dev/null` ignores `~/.ssh/config`, so ssh offers only `$K`. Every extra key it offers
and gets refused counts against fail2ban's 3-failure limit. Piping a file to `bash -s`
avoids quoting through two hops. This form was verified from the operator's dev box on
2026-09-30: jupiter and zeus directly, mars through jupiter.

On that box, `$K` gets in only through its **certificate**. The hosts refuse the bare key
and accept `~/.ssh/id_ed25519-cert.pub`, which `-i` picks up automatically. The cert is
signed by the fleet user CA and valid for 90 days; this one expires on **2026-10-20**.
After that, the same command fails with `Permission denied (publickey)`. Check it with
`ssh-keygen -L -f ~/.ssh/id_ed25519-cert.pub | grep Valid`. To re-sign, see the roomler-ai
memory `reference_ssh_ca_mesh`.

### Permanent: `~/.ssh/config`

```
Host jupiter
  HostName <jupiter-public-ip>
  User gjovanov
  IdentityFile ~/.ssh/<fleet-key>
  IdentitiesOnly yes

Host zeus
  HostName <zeus-public-ip>
  User gjovanov
  IdentityFile ~/.ssh/<fleet-key>
  IdentitiesOnly yes

Host mars
  HostName <mars-public-ip>
  User gjovanov
  IdentityFile ~/.ssh/<fleet-key>
  IdentitiesOnly yes
  ProxyJump jupiter          # swap to zeus if jupiter is unreachable
```

After this, plain `ssh mars`, `scp`, and `ssh mars kubectl -n lgr get secrets` all route
through the jump automatically.

## Troubleshooting

- **`Permission denied (publickey)` as the wrong user.** `ssh <host>` uses your *local*
  username, so on a host where you're `root`, `ssh 94.130.141.98` tries `root@…`. Always
  name the user: `ssh gjovanov@94.130.141.98`.
- **Which key is being offered.**
  `ssh -v <user>@<host> 2>&1 | grep -Ei 'Offering|Authentications that can continue|no such identity'`.
  No `Offering` line means that machine has no private key to present. Under
  `BatchMode=yes` it can also mean the key needs a passphrase that ssh isn't allowed to ask for.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`.** The host key differs from `known_hosts`.
  That usually means a rebuilt server, but it's also what a MITM looks like. **Verify the
  fingerprint out-of-band first**, then run `ssh-keygen -R <host>`.
- **Re-banned immediately.** A client retrying with a bad key (an editor, a sync tool, a
  mounted drive) trips the jail again. `grep Found /var/log/fail2ban.log | tail` names the source.
- **Timeouts during reconnect churn, with no ban.** A flapping session or a loop of short
  `ssh` calls from an untrusted IP can go over ssh_guard's 6 new connections per minute,
  and the extra packets are silently dropped. Whitelisting the IP in ssh_guard fixes it,
  and so does waiting a minute.
- **Dynamic IP.** A permanent entry trusts that address for good, including after the ISP
  hands the lease to someone else. Keep permanent entries for stable addresses. A roaming
  laptop belongs in the roaming slot (`roomler-whitelist-ip <ip>` on each host), or use the
  jump host as the reliable route.

## Scope note

If both layers are clean and SSH still fails, look at `sshd` itself: with
`MaxStartups 10:30:100` it randomly drops new unauthenticated connections while bots flood
`:22`. Also check for a Hetzner Cloud Firewall (web console or `hcloud firewall`).
`nft list ruleset` shows every table on the host.
