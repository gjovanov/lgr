# Google Drive backups on production — what to set, and what actually happens

Audience: whoever is turning the off-site backup on. Written to be read once, top to bottom,
before touching the cluster. Spec: FR-13.48–13.59 (issue #24).

---

## 1. The mental model, in one paragraph

LGR backs up in **two independent layers**. *Layer 1* runs on **mars**, outside the cluster: it
dumps the whole MongoDB with `mongodump`, rotates it, and pushes it off-site with `rclone` — no
app code involved, configured in the `lgr-deploy` repo. *Layer 2* runs **inside the app**: once
a night, for each org that has opted in, it exports that org's own rows into a compressed
bundle, verifies the bundle against its own manifest, **seals it**, and uploads it to Google
Drive. **This document is about Layer 2** — the one configured with environment variables.

The two layers answer different questions. Layer 1 answers *"the cluster is gone, can we
rebuild it?"* Layer 2 answers *"this one organisation's data is wrong, can we get it back
without touching anyone else's?"* Neither replaces the other.

---

## 2. The three credentials, and why they are three

This is the part that confuses people, so it is worth being explicit. Drive needs **three
separate things**, and they are separate because they answer three different questions.

| | What it is | Question it answers | Can it read your backups? |
|---|---|---|---|
| **OAuth client** (id + secret) | Identifies *the application* to Google | "What software is asking?" | No |
| **Refresh token** | Identifies *the Google account* and its consent | "Whose Drive, and did they agree?" | No — but it can **delete** what is there |
| **Seal key pair** | Encrypts the bundle | "Who may read the contents?" | The **private half** can. It is not on the cluster. |

Three consequences follow, and each one has bitten somebody:

- **A refresh token is bound to the client that issued it.** Sealing the token without its
  matching client id/secret means the app refreshes with the *wrong* client and dies on
  `invalid_client` at the first nightly run. They travel together, always.
- **The cluster can seal and cannot open.** The key is asymmetric on purpose: anything that
  reaches the cluster gets the *public* half, which encrypts and cannot decrypt. Losing the
  private half means losing every uploaded backup — see §7.
- **There is no API-key version of this.** A Google API key authenticates anonymous access to
  *public* data and cannot write to a private Drive at all. A service account is not a shortcut
  either: service accounts have no storage quota and cannot own files, so uploading to their own
  empty My Drive fails `403 storageQuotaExceeded`. OAuth with a long-lived refresh token is the
  only shape Google permits.

---

## 3. The environment variables

### Required — nothing uploads without these

| Variable | Lives in | What it is |
|---|---|---|
| `BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN` | `lgr-backup-secret` | The long-lived token from the consent flow. **Without it: destination reported as `skipped`, no upload, ever.** |
| `BACKUP_GOOGLE_DRIVE_CLIENT_ID` | `lgr-config` (ConfigMap) | The dedicated Drive OAuth client. A client id is not a credential, so it is not sealed. |
| `BACKUP_GOOGLE_DRIVE_CLIENT_SECRET` | `lgr-backup-secret` | Its secret. Must be the client the refresh token was issued to. |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | `lgr-config` (ConfigMap) | Public half of the seal pair, `lgrseal1:…`. **Without it the upload is refused rather than sent in the clear** — a bundle carries every collection in the org, including password hashes and contact tax IDs. |

⚠ If either the refresh token or the seal key is missing, the nightly run still **succeeds** —
the bundle is built, verified and on the volume. What you get is a recorded gap: the digest says
this backup exists **only on the cluster volume**, which is the same disk as the live database.

### Optional — sane defaults, change only with a reason

| Variable | Default | Why you might change it |
|---|---|---|
| `BACKUP_GOOGLE_DRIVE_FOLDER` | `LGR` | The **single** folder name this app owns in that Drive. ⚠ Must be one name — empty, `/`, or anything containing `/` is **refused**, because it would resolve to My Drive root and scatter sealed bundles across the account. |
| `BACKUP_GOOGLE_DRIVE_KEEP` | `14` | Generations kept **on Drive**, per org and per kind. Counted, never aged — a run of failed nights can never delete the last good copy. |
| `BACKUP_GOOGLE_DRIVE_MIN_FREE_BYTES` | `536870912` (512 MB) | Headroom demanded before starting a transfer. `0` disables the pre-flight, which is what you want on a Drive whose quota this process cannot read. |
| `BACKUP_CHECK_INTERVAL_MS` | `600000` (10 min) | How often the scheduler asks "is it any org's backup hour yet?". **`0` disables the whole thing** (tests set this). |
| `BACKUP_HOUR` | `3` | Org-local hour the nightly run targets. `0` means midnight and is a real value. |
| `BACKUP_KEEP_PER_ORG` | `14` | Generations kept on the **cluster volume**, separately from Drive. |
| `BACKUP_EMAIL_ATTACH_BUNDLE` | `false` | Whether the daily mail carries the bundle. What it attaches is the **sealed** artifact — there is no setting that mails a plaintext one. The manifest is mailed either way. |

### Not a variable: the per-org switch

The scheduler is **opt-in per organisation**, and no environment variable turns it on. 73 of the
80 orgs in production are `e2e-*` test tenants; bundling them all nightly would fill the uploads
volume with artifacts nobody will ever read.

```bash
bun --env-file=.env scripts/configure-backup.ts --list
bun --env-file=.env scripts/configure-backup.ts --org regal-pz --execute
```

⚠ This gates the **scheduler** only. An org admin can always take a manual backup of their own
org through the Backups screen, enabled or not.

---

## 4. Where these live on production, and what is already set

Production splits them across two objects, deliberately:

- **`lgr-config`** (ConfigMap, in git at `lgr-deploy/k8s/base/configmap-lgr-config.yaml`) — the
  non-secrets: client **id**, the **public** seal key, the sys-admin allow-list.
- **`lgr-backup-secret`** (Secret, **created by hand on the cluster, not in git**) — the client
  **secret** and the **refresh token**.

⚠ Why a separate Secret rather than adding two keys to `lgr-secret`: `lgr-secret` is reconciled
by the SealedSecret controller from `sealed/sealed-lgr-secret.yaml`. A key written into it by
hand works until the next reconcile and is then **silently reverted** — the worst failure shape
there is, because it works when you test it.

**Already set in production today:**

- ✅ `BACKUP_GOOGLE_DRIVE_CLIENT_ID` — the dedicated client on project `440993915654`
- ✅ `BACKUP_ENCRYPTION_PUBLIC_KEY` — `lgrseal1:MCowBQYDK2Vu…`
- ✅ `BACKUP_SYS_ADMINS` — the four operator addresses
- ✅ Everything optional runs on its default (scheduler on, 10-minute tick, 03:00 local)

**Not set / not working today:**

- ❌ `lgr-backup-secret` — **the refresh token is dead** (`reconsent_required`, HTTP 400). Needs
  §5.
- ❌ No organisation has the nightly scheduler enabled, so nothing is being bundled at all.
- ⚠ **The private half of the seal key is unaccounted for.** Read §7 before uploading anything.
- ⚠ `LGR_IMAGE_TAG` is `latest`, so the version recorded in each bundle is not a real tag and
  the restore-side version check can only warn.

---

## 5. Turning it on, step by step

### 5.1 Get a refresh token — on a machine with a browser

Run this on your **laptop**, not on mars. The consent flow listens on `127.0.0.1` for exactly
one redirect, because Google **removed** the out-of-band "here is a code, paste it back" flow in
2023; a loopback redirect is the supported replacement (it is what `rclone authorize` uses too).
The token it produces is portable — being portable is the entire point of a refresh token.

```bash
# In the lgr checkout, as the DEDICATED Google account (never a personal one)
bun --env-file=.env scripts/google-drive-consent.ts --append-env .env
```

`--append-env` writes the token into the file instead of printing it. Prefer that: a credential
printed once lives on in scrollback, shell history, and whatever recorded the session.

⚠ Use a **dedicated** Google account. This credential can delete the off-site copy, and it must
be revocable without taking anything else down with it.

### 5.2 Prove it against the real Drive, before deploying anything

```bash
bun --env-file=.env scripts/backup-drive-smoke.ts
bun --env-file=.env scripts/backup-drive-smoke.ts --identity-file ./lgr-seal.key   # also unseals
```

This talks to the real Google with the real credential and touches nothing else, so a failure
has exactly one possible cause. It refreshes the token, reads the quota, creates the folder,
seals a payload, uploads it resumably, **downloads it back and re-hashes it**, and deletes it.
Until you have run it once with `--identity-file`, you have proven you can *write* a backup, not
read one.

### 5.3 Put the two secrets on the cluster

```bash
kubectl create secret generic lgr-backup-secret -n lgr \
  --from-literal=BACKUP_GOOGLE_DRIVE_CLIENT_SECRET='…' \
  --from-literal=BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN='…'

kubectl -n lgr rollout restart deploy/lgr
```

### 5.4 Enable an organisation, then watch

```bash
bun --env-file=.env scripts/configure-backup.ts --org regal-pz --execute
# and make the result visible to a human every morning:
bun --env-file=.env scripts/configure-daily-digest.ts --org regal-pz --backups on --execute
```

The next morning the digest's Backups section names the destination the bundle reached. If it
reached nowhere, that renders as a **failure banner**, not a quiet line.

---

## 6. What actually happens each night

```
  scheduler tick (every 10 min)
        │  is it 03:00 in this org's own timezone, and is the org opted in?
        ▼
  claim the day  ──── the unique {orgId, kind, date} index IS the lock.
        │             First writer wins; everyone else walks away.
        ▼
  build the bundle ── every tenant-scoped collection, one JSON document per
        │             line, zstd-compressed. Manifest with a SHA-256 per section.
        ▼
  verify it ───────── re-read the artifact, re-hash every section, re-count every
        │             document. A bundle that cannot reproduce its own manifest is
        │             not a backup, and finding that out at restore time is the
        │             whole failure this feature exists to prevent.
        ▼
  ── off-site, and only now ──────────────────────────────────────────────
        │
        ├─ 1. refresh the access token ── always. Access tokens last about an
        │      hour, so a nightly job ALWAYS starts with an expired one. This is
        │      the normal path, not an error branch.
        │
        ├─ 2. SEAL ─────────────── X25519 → HKDF → AES-256-GCM to the public key.
        │      Nothing leaves the cluster readable. The bundle contains `orgs`,
        │      which is where a Drive credential would live — an unsealed upload
        │      would ship the key to the backup inside the backup.
        │
        ├─ 3. quota pre-flight ─── a free Google account is 15 GB shared with
        │      Gmail and Photos. Refuse up front rather than fail mid-transfer.
        │      An unreadable quota is a warning, not a refusal: a missing number
        │      must not become a missing backup.
        │
        ├─ 4. ensure the folder ── LGR/Backups/<org>/<kind>/ …  (archives go to
        │      LGR/Archive/<org>/<year>/ — different rules, different subtree)
        │
        ├─ 5. upload ──────────── resumable only, never simple upload. Simple
        │      upload caps at 5 MB; today's bundle is 3.2 MiB, so a naive
        │      implementation works right up until it silently stops in year 1.
        │      A partial upload THROWS — it is never recorded as a copy.
        │
        ├─ 6. read it back ────── on Mondays: download the artifact and re-hash
        │      it. "The API returned 200" is not "the bytes are there". The
        │      house cautionary tale is a backup job that reported success
        │      nightly while storing nothing, for months.
        │
        └─ 7. prune ───────────── keep the newest N generations. Counted, never
               aged, and LAST — a night that fails to produce a new copy must
               never have removed an old one.
        │
        ▼
  mail the manifest ─ a few KB of counts and checksums. Proves what SHOULD exist
        │             even when the payload itself cannot be sent. Email is a
        │             courier of last resort and never counts as one of the copies.
        ▼
  record it ───────── BackupRun.destinations[] carries successes AND failures,
                      and the FR-11 digest renders a bundle that reached nowhere
                      as a failure — a healthy Layer 1 must not launder it.
```

---

## 7. ⚠ Before you upload anything: the seal key

`BACKUP_ENCRYPTION_PUBLIC_KEY` is set in production. **The private half is unaccounted for.**

If that is still true when the first bundle uploads, you will be accumulating off-site backups
that **nobody can ever read** — which is worse than having none, because it looks like having
some. Resolve it first, one of two ways:

1. **Find it.** It was generated off-cluster; check the password manager. Prove it with
   `scripts/backup-drive-smoke.ts --identity-file <path>` — that unseals, so success is proof.
2. **Rotate it.** Generate a new pair *off the cluster*, put the public half in the ConfigMap and
   the private half in the password manager:
   ```bash
   bun scripts/backup-crypto.ts keygen --out ./lgr-seal.key   # run this OFF the cluster
   ```
   `--out` writes the private half to a file instead of printing it — same reason
   `--append-env` exists for the refresh token.
   ⚠ Rotating does not re-encrypt anything already uploaded. Old artifacts stay readable only by
   the old private key — which is a thing to keep, not replace.

**Never put the private half on a cluster node.** The pod that writes the bundles is exactly
what an attacker who reached the cluster already controls; a symmetric key, or the private half
in `lgr-secret`, would mean reaching the cluster equals reading every backup ever taken.

---

## 8. When it goes wrong, what it looks like

| Digest / `BackupRun.destinations` says | What happened | What to do |
|---|---|---|
| `skipped — google drive is not connected` | No refresh token configured | §5.1 |
| `skipped — no backup encryption recipient` | No seal key; the upload was **refused** rather than sent in the clear | Set `BACKUP_ENCRYPTION_PUBLIC_KEY` |
| **`reconsent_required`** | The refresh token is dead — revoked, password changed, or ~6 months idle | Re-run §5.1. ⚠ This is the one failure that **never** fixes itself on a retry: it will fail identically every night until a human acts. |
| `failed — invalid_client` | Token and client id/secret are from **different** OAuth clients | Re-consent with the client you actually deploy |
| `failed — … MB free but this upload needs …` | Quota pre-flight refused before transferring | Free space, or move to the object-storage tier |
| `failed — BACKUP_GOOGLE_DRIVE_FOLDER is …` | Folder name empty, `/`, or containing `/` | One folder name, nothing else |
| `failed — read back … does not match` | Drive stored something other than what was sent | Investigate; the bad remote copy is deliberately **not** deleted — it is evidence |
| Section says **"this backup exists only on the cluster volume"** | The bundle is fine, it just went nowhere | One of the rows above will say why |

---

## 9. Getting data back out

Download the `.sealed` artifact from the Drive — the folder is `LGR/Backups/<org>/<kind>/`, and
the file name carries the org, the kind and the date, so a listing alone tells you what you are
about to open and how old it is. Then, **on a machine that is not the cluster**:

```bash
# What is this, and which key opens it? No private key needed — the header is plaintext
# on purpose, so an operator holding an artifact can identify it.
bun scripts/backup-crypto.ts inspect lgr-regal-pz-full-2026-09-15.ndjson.zst.sealed

# Open it, with the PRIVATE half
bun scripts/backup-crypto.ts decrypt lgr-regal-pz-full-2026-09-15.ndjson.zst.sealed \
  bundle.ndjson.zst --identity-file ./lgr-seal.key

# Read it with no tooling of ours at all — that is why the format is line-oriented
zstd -dc bundle.ndjson.zst | head -1 | jq .manifest
```

To restore it *into* the product, use the sys-admin Backups screen (`/admin/backup`): **Inspect
first** — it writes nothing and produces the per-collection diff — then Merge or Replace. That
screen is gated on `BACKUP_SYS_ADMINS`, which is already set in production.

---

## 10. What Drive does **not** give you

Drive has **no object-lock and no write-once retention**: the same credential that writes can
delete. A leaked token, a buggy rotation, or a person tidying up the Drive removes the off-site
copy. For last night's bundle that is an acceptable risk — there are fourteen of them and a
Layer 1 copy on mars besides.

For the **ten-year archive** it is not (ЗСч чл. 12 requires ten years; payroll fifty). That is
what the S3-compatible tier is for: a bucket with versioning and Object Lock refuses the delete
to the writing key and to the account root alike. It is configured separately —
`BACKUP_S3_*`, see `.env.example` — and defaults to carrying the **archive only**.

⚠ Object Lock must be enabled **when the bucket is created**. Most providers cannot add it
afterwards, and it is the only property that makes that tier different from this one.

---

## 11. One-page checklist

- [ ] Dedicated Google account created (not a personal one)
- [ ] Seal key pair: private half **located or rotated**, and proven by an unseal (§7)
- [ ] `bun scripts/google-drive-consent.ts --append-env .env` on a machine with a browser
- [ ] `bun scripts/backup-drive-smoke.ts --identity-file …` passes end to end
- [ ] `kubectl create secret generic lgr-backup-secret …` with **both** values
- [ ] `kubectl -n lgr rollout restart deploy/lgr`
- [ ] `scripts/configure-backup.ts --org <slug> --execute`
- [ ] `scripts/configure-daily-digest.ts --org <slug> --backups on --execute`
- [ ] Next morning: the digest names a destination that was **reached**
- [ ] Monday after: the same line says **read back and verified**
