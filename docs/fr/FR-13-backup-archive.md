# FR-13 — Backup (full + delta) and archiving (cold storage) of LGR data

**Goal:** LGR currently has **no backups at all**. This FR specifies the backup and archive
policy for the production deployment: a nightly **full** dump plus an hourly **delta**, both
compressed, written to at least three independent destinations (local disk, an off-site store —
object storage or **Google Drive**, §5.8 — and, where the size allows, email), verified by a
real restore rather than by a
file-exists check; and an **archive** policy that moves cold data off the hot volumes while
keeping it readable, because Bulgarian law requires the data to survive for 10 years (50 for
payroll) and Приложение 29 requires archived data to stay reachable **through the user
interface**.

Status: draft for implementation · Date: 2026-09-03 · Depends on: nothing (FR-11's scheduler
and email hardening are already on master and are the patterns reused here) · Feeds: nothing.

Driving input: goran's 2026-09-03 request — *"research and write a FR for backuping (full and
delta) and archiving (older than X cold storage) of LGR data. First analyze the growth rate
for regal-pz and predict the yearly data for that org. Then evaluate options and propose
backuping and archiving policies and strategies. Backup storage should also be either binary
format or compressed (e.g. brotli). Propose jobs that daily runs and storage destinations
e.g. disk, email (if size not too large), other options."*

**Every number in §§1–3 was measured against the live production cluster on 2026-09-03**, not
estimated. Appendix A gives the exact commands so any of it can be re-run.

---

## 1. Current state (production, verified 2026-09-03)

### 1.1 There are no backups

`~/lgr-deploy/scripts/` on mars contains nine scripts — `build-image.sh`,
`cleanup-e2e-data.sh`, `deploy.sh`, `run-e2e.sh`, `seed-db.sh`, `seed-via-api.sh`,
`setup-certs.sh`, `setup-cloudflare-dns.sh`, `setup-nginx.sh`. **None of them is a backup
script**, and mars's crontab has no LGR entry. The sibling projects do:

```
0  3 * * *  purestat-deploy/scripts/backup-mongodb.sh
0  3 * * *  roomler-deploy/scripts/backup-mongodb.sh
0  4 * * *  roomler-deploy/scripts/verify-backups.sh
30 3 * * *  ares-migration/scripts/backup-mongodb.sh
30 3 * * *  roomler-deploy/scripts/backup-uploads.sh
```

So the house pattern exists and is proven; LGR was simply never wired into it.

⚠ **And the house pattern has a live, silent failure worth learning from.** Running
`roomler-deploy/scripts/verify-backups.sh` today prints:

```
MongoDB backups:
  PASS Latest: roomlerdb-2026-09-03.archive.gz (52K, 10h ago)
  PASS Total backups: 8
Uploads backups:
  FAIL No 'latest' symlink in /home/gjovanov/roomler-deploy/backup/uploads
  PASS Total backup snapshots: 0
1 check(s) failed
```

roomler's **uploads backup has produced zero snapshots since it was installed**. The cron job
runs, the verify job detects it, and nobody reads either output. This is the single most
important design input to FR-13: *writing a backup script is not the same as having backups.*
Verification must restore, and its result must land somewhere a human already looks — which,
since FR-11, is the daily digest email.

### 1.2 Where the data lives, and why one copy is the whole story

| PV | hostPath | Node | Capacity | Reclaim |
|---|---|---|---|---|
| `lgr-mongodb-pv` | `/data/lgr/mongodb` | `k8s-worker-2` | 5 Gi | Retain |
| `lgr-uploads-pv` | `/data/lgr/uploads` | `k8s-worker-2` | 5 Gi | Retain |

Both PVs are node-local hostPaths pinned to the **same node**, `k8s-worker-2`, which is a
libvirt guest on **zeus**. `mongodb-0` and the `lgr` pod both schedule there. There is exactly
one copy of every byte LGR owns, on one physical machine.

The one piece of good news: **mars is a different bare-metal host** (it runs `k8s-master-1`
and `k8s-worker-1` only), and has `/dev/md2 437 G, 122 G free`. mars is therefore a legitimate
off-host tier-1 target, exactly as it already is for roomler and purestat.

Declared PV capacity is **5 Gi**, but the underlying filesystem is the node's 194 G root
volume, so hostPath does not enforce the quota today. §2.4 shows the uploads volume crossing
5 Gi in **year 7** — a limit that is currently cosmetic but becomes real the moment these PVs
are migrated to a CSI driver that enforces it.

### 1.3 What already exists that FR-13 must reuse

- **Scheduler pattern** — `unified.ts:355-390`: `setTimeout(…, 100)` after listen, dynamic
  import, `setInterval` with a config-driven interval, `.catch()` per tick, `try/catch` around
  the block. FR-11's digest scheduler is the direct precedent, including
  `config.digest.checkIntervalMs === 0` disabling it entirely so `.env.test` never fires it.
- **Run-once claim** — FR-11 established that *the unique index IS the lock*: `DigestRun`'s
  unique `{orgId, date}` makes the first inserter the winner and everyone else takes E11000.
  There is still no cron library, no queue and no lease primitive in this codebase, and FR-13
  does not add one.
- **`mongodump` availability** — the `mongo:7` StatefulSet image ships mongodump/mongorestore
  **100.14.1**. The application image (`oven/bun:1.3.10-slim` + Chromium libs, `Dockerfile`)
  does **not**. Any dump-based job must therefore run in a `mongo:7` container, not in the app.
- **In-process compression** — verified inside the running production pod on Bun 1.3.10:
  `zlib.brotliCompressSync`, `zlib.zstdCompressSync` and `zlib.gzipSync` are **all present
  natively**. No new dependency is needed for app-level compression, and zstd is not gated
  behind a newer Bun.
- **CronJob precedent** — the cluster runs exactly one CronJob, `purestat/geoip-update`
  (`concurrencyPolicy: Allow`, `failedJobsHistoryLimit: 2`, `backoffLimit: 3`,
  `restartPolicy: OnFailure`, `nodeSelector` pinning it to the node holding the hostPath,
  `imagePullSecrets: [regcred]`). Copy that shape.
- **Archive precedent in-tree** — `packages/desktop/src-tauri/src/archive.rs` already does
  exactly this job for the desktop SQLite build: online-backup snapshot, then
  `zstd::encode_all(input, 3)`. **zstd is already the house archive codec.**
- **Email** — `sendEmail` (`email.service.ts:95-140`) is result-typed since FR-10 and supports
  attachments. See §4.3 for the exact size ceiling, which is *not* the number in the constant.
- **Oplog** — the replica set carries a 3,544 MB oplog holding 1,642,643 entries and
  **134.8 days** of history in 492 MB. Point-in-time recovery material already exists on disk;
  nothing ships it anywhere.

### 1.4 Data hygiene facts that change backup sizing

- **73 of the 80 orgs in production are `e2e-*` test tenants** created on 2026-03-23. They are
  small, but they are in every dump and every restore. `lgr-deploy/scripts/cleanup-e2e-data.sh`
  exists and has evidently never been run against prod.
- **`User.password` has no `select: false`** (`user.model.ts:52` — `password: { type: String }`).
  90 bcrypt hashes sit in every dump. FR-11.3 fixed the *endpoint* that leaked them; the
  *dump* still carries them, which is why §5.6 makes encryption mandatory before any byte
  leaves the cluster.
- **`EmailLog` has no TTL and stores the digest HTML verbatim** — measured mean **52,085 bytes
  per row**, max 84,943, at 2 rows/day. See §2.3; it is the largest non-fiscal consumer in the
  system and the one collection that genuinely needs a retention rule.

---

## 2. Measured growth of regal-pz, and the yearly projection

Org `regal-pz` = `6a5ddbafdf2fc7b03bf596d2`, created **2026-07-20**, catalog seeded
**2026-07-23**, first real trading day **2026-07-26**. Measurement window for rates:
**2026-07-26 … 2026-09-02** (39 calendar days, 26 of them with invoice activity ⇒ ~5 trading
days/week ⇒ **260 trading days/year** is used throughout).

### 2.1 Today's footprint

Whole `lgr` database (all 80 orgs):

| metric | value |
|---|---|
| documents | 95,090 |
| `dataSize` (uncompressed BSON) | 96,714,195 B — 92.2 MiB |
| `storageSize` (WiredTiger, snappy) | 28,626,944 B — 27.3 MiB (**3.38×** on disk) |
| `indexSize` | 71,606,272 B — 68.3 MiB |
| `totalSize` | 100,233,216 B — 95.6 MiB |

`regal-pz` alone: **60,429 documents / 69,110,302 B (65.9 MiB) — 68 % of the whole database.**

| collection | docs | BSON bytes | MiB | avg doc |
|---|---|---|---|---|
| products | 23,246 | 48,852,301 | 46.59 | 2,102 B |
| stocklevels | 23,239 | 4,925,584 | 4.70 | 212 B |
| auditlogs | 4,680 | 2,433,614 | 2.32 | 520 B |
| files | 762 | 2,409,251 | 2.30 | 3,162 B |
| invoices | 548 | 2,252,945 | 2.15 | 4,111 B |
| docfiles | 946 | 2,119,586 | 2.02 | 2,241 B |
| stockmovements | 897 | 1,708,621 | 1.63 | 1,905 B |
| backgroundtasks | 102 | 1,379,108 | 1.32 | 13,521 B |
| emaillogs | 24 | 1,250,034 | 1.19 | **52,085 B** |
| contacts | 2,121 | 1,207,872 | 1.15 | 570 B |
| tags | 3,802 | 479,838 | 0.46 | 126 B |
| *(11 others)* | 62 | 91,548 | 0.09 | — |

⚠ **71 % of regal-pz is the one-off catalog seed** (23,246 products loaded on 2026-07-23).
That is a *level*, not a *rate* — projecting it forward is the easiest mistake to make here,
and it would overstate the yearly figure by roughly 5×. Everything in §2.2 excludes it.

Uploads PV, `/app/uploads/6a5ddbafdf2fc7b03bf596d2`: **1,532 files / 79,546,838 B (75.9 MiB)**,
mean 51,923 B/file — 1,426 pdf, 90 xlsx, 8 txt, 8 csv. Split: `docs/` 60 MB, `bill-ocr/` 20 MB,
`doc-import/` 156 KB.

### 2.2 Measured daily rate

Excluding the 2026-07-23 catalog seed, the 2026-08-03 bulk tag load, and the 2026-08-27
`_docs`→PV migration (770 DocFile rows in one day — a one-time event, so `docfiles` is rated
from 2026-08-28 onward only):

| collection | docs / trading day | KB / trading day | accumulates? | basis |
|---|---|---|---|---|
| docfiles | 34.8 | 262.8 | yes | post-migration days only |
| backgroundtasks | 17.0 | 224.5 | **no — 7-day TTL** | `background-task.model.ts:36` |
| emaillogs | 2.0 | 107.4 | yes | 2 recipients × 55 KB, **no TTL** |
| invoices | 19.0 | 75.7 | yes | 26 active days |
| auditlogs | 128.2 | 72.8 | yes | 30 active days, keyed on `timestamp` |
| files | 24.5 | 68.5 | yes | 26 active days |
| stockmovements | 31.6 | 58.9 | yes | 28 active days |
| products | 8.4 | 16.2 | yes | new SKUs only |
| contacts | 3.5 | 2.0 | yes | 20 active days |
| stocklevels | 8.2 | 1.7 | yes | one per new product |

**Accumulating: 260 documents/day, 666 KB BSON/day. Total write churn including TTL'd rows:
890 KB/day.**

Uploads, measured by file mtime: **August 2026 (first full month) = 1,049 files / 57.9 MB**;
typical trading day 24–80 files / 1.7–6.5 MB.

### 2.3 Yearly projection for regal-pz

At 260 trading days: **67,639 documents and 169.1 MB of BSON per year**, plus **~0.68 GB and
~12,600 files per year** of uploads.

| after | documents | BSON | gzip -9 | brotli q5 | zstd -19 | uploads |
|---|---|---|---|---|---|---|
| **year 1** | 128,068 | 237 MB | 14.2 MB | **9.1 MB** | 8.1 MB | 0.76 GB |
| year 2 | 195,707 | 406 MB | 24.4 MB | 15.7 MB | 13.9 MB | 1.43 GB |
| year 3 | 263,347 | 575 MB | 34.6 MB | 22.2 MB | 19.8 MB | 2.11 GB |
| year 5 | 398,625 | 913 MB | 55.0 MB | 35.2 MB | 31.4 MB | 3.47 GB |
| year 10 | 736,821 | 1,758 MB | 105.9 MB | 67.9 MB | 60.4 MB | **6.86 GB** |

Largest year-1 contributors: docfiles 68 MB · emaillogs 28 MB · invoices 20 MB · auditlogs
19 MB · files 18 MB · stockmovements 15 MB · products 4 MB · everything else < 1 MB.

### 2.4 What the projection actually says

Three conclusions, and they are not the ones a generic backup FR would reach:

1. **The database will not need archiving for size for at least a decade.** 1.76 GB of BSON
   after ten years compresses to **68 MB**. A ten-year GFS chain of full backups is ~3 GB.
   Any proposal to "move invoices older than 2 years out of Mongo" is solving a problem
   regal-pz does not have, and would trade a real compliance risk (§4.2) for an imaginary
   capacity win.
2. **The uploads volume is the only thing that actually grows dangerously.** 6.86 GB after ten
   years against a declared **5 Gi** PV — it crosses the declared capacity in **year 7** — and
   it barely compresses (§3.3: 1.18× gzip, 1.46× zstd-19), because PDF and XLSX are already
   deflate containers. **The archive policy in §6 is therefore about files, not about rows.**
3. **`EmailLog` is the one collection that needs a retention rule now.** 28 MB/year at *two*
   recipients, with no TTL, growing linearly with the recipient list — at five recipients it
   approaches the size of the entire product catalog inside a year. It is not fiscal data and
   nothing reads a 90-day-old digest body.

**Multi-tenant trigger.** These figures are for one real org. Scaling to *N* regal-sized
tenants multiplies §2.3 by *N*: at 50 real tenants the yearly figure is 8.5 GB of BSON and
34 GB of uploads, at which point per-org archiving (§6.4) stops being optional. FR-13 defines
the mechanism now so that the switch is a config change later.

---

## 3. Compression: measured, not assumed

The brief asked for "binary format or compressed (e.g. brotli)". Both halves are already
satisfied by the same artifact: `mongodump --archive` **is** a binary BSON stream, and it
compresses extraordinarily well because BSON repeats every field name in every document and
the product catalog repeats a 10-slot `priceTiers` skeleton 23,246 times.

### 3.1 The benchmark

Source: the real production archive, `mongodump --db lgr --archive` = **96,819,053 B
(92.34 MiB)**, produced in **1 second**. Ratios are hardware-independent; **timings are only
comparable within a block**, because the two blocks are the two runtimes the two layers of §5
actually use — CLI tools on mars for Layer 1, in-process `zlib` for Layer 2. (Bun's `zlib`
gzip is ~5× faster than mars's GNU `gzip` at the same level and output size; mars was also
serving image builds during the run.)

**Block A — CLI tools on mars (16 cores) — the Layer-1 path:**

| algorithm | output bytes | MiB | ratio | compress | decompress |
|---|---|---|---|---|---|
| `mongodump --gzip` (per-collection) | 6,043,440 | 5.76 | 16.0× | 2 s (incl. dump) | — |
| gzip -6 | 6,118,773 | 5.84 | 15.8× | 1.01 s | 0.30 s |
| gzip -9 | 5,846,877 | 5.58 | 16.6× | 2.22 s | 0.30 s |
| pigz -9 (8 threads) | 5,852,552 | 5.58 | 16.5× | 0.31 s | — |
| zstd -3 | 4,812,303 | 4.59 | 20.1× | 0.09 s | 0.06 s |
| zstd -12 | 3,790,923 | 3.62 | 25.5× | 0.61 s | — |
| **zstd -19** | **3,344,829** | **3.19** | **29.1×** | **16.5 s** | **0.06 s** |
| xz -6 | 3,282,280 | 3.13 | 29.5× | 5.23 s | — |
| xz -9e | 2,697,520 | 2.57 | 35.9× | 69.9 s | 0.27 s |

**Block B — in-process `zlib` under Bun — the Layer-2 path** (byte counts derived from the
measured MiB, which the harness reported to 2 dp):

| algorithm | MiB | ratio | compress | decompress |
|---|---|---|---|---|
| gzip -6 | 5.75 | 16.1× | 0.23 s | 0.05 s |
| gzip -9 | 5.56 | 16.6× | 0.46 s | 0.06 s |
| brotli q4 | 4.51 | 20.5× | 0.21 s | 0.06 s |
| **brotli q5** | **3.56** | **25.9×** | **0.33 s** | **0.06 s** |
| brotli q9 | 3.33 | 27.7× | 1.25 s | 0.06 s |
| brotli q11 | 2.91 | 31.7× | **2,734 s** | 0.10 s |
| zstd -3 | 4.59 | 20.1× | 0.17 s | 0.09 s |
| zstd -19 | 3.18 | 29.1× | 37.5 s | 0.06 s |

### 3.2 What this decides

- **Never use `mongodump --gzip`.** It gzips each collection *separately*, so the compressor
  restarts its dictionary 107 times. Piping the uncompressed archive through a single external
  compressor yields **3.19 MiB vs 5.76 MiB — 45 % smaller for the same work.** This is the one
  change that most improves on the roomler script being copied.
- **brotli q11 is a trap.** Within the same runtime it costs **2,734 s against zstd -19's
  37.5 s — 73× the CPU — to save 8 % of the output.** If a nightly job is ever written with
  `brotliCompressSync` and no explicit quality, it takes the library default of 11 and will
  read as a hung job. Any brotli use **MUST** pin the quality parameter.
- **brotli q5 is genuinely excellent** and beats gzip -9 on *both* axes in the same runtime —
  3.56 MiB in 0.33 s against 5.56 MiB in 0.46 s. It is the right answer whenever the compressor
  must run **in-process in the Bun app**, and it needs no dependency (verified present in the
  deployed 1.3.10 image, §1.3).
- **zstd -19 is the right answer for artifacts written once and kept for years** — best
  ratio per unit of decompression cost, and it is already the house archive codec
  (`archive.rs`). xz -9e buys a further 20 % for 4× the CPU and 4× the decompression time;
  it is worth it only for the yearly cold-storage tier (§6.3), where the file is written once
  and hopefully never read.
- **Compression is not the bottleneck anywhere.** The dump takes 1 s and zstd -19 takes 16 s.

### 3.3 Uploads compress hardly at all

Tarring regal-pz's `docs/` tree: 61,224,960 B → gzip -9 **52,002,829 B (1.18×)**, zstd -19
**41,868,843 B (1.46×)**. PDFs and XLSX are already compressed containers. Consequences: the
uploads tier is sized at ~1× its raw size, and its incremental strategy must be
**deduplication** (`rsync --link-dest` hard links, or content-addressed storage), not
compression. Files in the doc store are immutable once written — re-upload creates a new
`versions/…` file rather than mutating (`doc-store.service.ts` header comment) — which makes
hard-link rotation near-perfect: only genuinely new bytes are copied each night.

### 3.4 Delta: the oplog, not `updatedAt`

Two candidate delta mechanisms were measured against the real data.

**Query-delta (`updatedAt >= lastRun`) — rejected.** Measured for regal-pz:

| window | documents | bytes | share of the org |
|---|---|---|---|
| 7 days | 46,288 | 53.50 MB | **81 %** |
| 30 days | 48,909 | 58.52 MB | 89 % |

A "7-day delta" that carries 81 % of the database is not a delta. The cause is structural, not
incidental: the ops scripts this deployment depends on — `assign-din-tags`, `backfill-*`,
`seed-products --no-clean` — rewrite the entire 23k-product catalog on purpose, moving every
`updatedAt`. **And a query-delta cannot see deletions at all**, so restoring a chain of them
silently resurrects deleted rows.

**Oplog slices — recommended.** Real slices dumped with
`--db local --collection oplog.rs --query '{ts:{$gte,$lte}, op:{$ne:"n"}}'` (the `op:'n'`
exclusion drops ~8,500 replica-set no-ops per day that carry no information):

| day | character | raw | gzip -9 | zstd -19 |
|---|---|---|---|---|
| 2026-09-02 | quiet trading day | 511,260 B | 47,833 B | **30,170 B** |
| 2026-08-31 | busy trading day | 2,142,245 B | 210,609 B | **106,297 B** |
| 2026-08-28 | bulk migration + backfill | 18,920,709 B | 848,736 B | **431,897 B** |

**A day's delta is 30–430 KB compressed.** An *hourly* delta is 2–20 KB. It captures inserts,
updates and deletes; it replays with `mongorestore --oplogReplay`; and the source oplog already
retains 134 days, so a missed night is recoverable rather than lost.

### 3.5 The full dump restores — verified, not assumed

Restored into a throwaway `mongo:7` container on mars (never against production):

```
RESTORE elapsed=51.1s
restored: collections=107 objects=95090 dataSize=96714195 indexSize=16961536
  products       total=37878  regal-pz=23246
  invoices       total=697    regal-pz=548
  stockmovements total=990    regal-pz=897
  docfiles       total=946    regal-pz=946
  contacts       total=2243   regal-pz=2121
  auditlogs      total=6203   regal-pz=4680
  stocklevels    total=37881  regal-pz=23239
indexes on products: 14
sample product sku=REGALPZ-00001 name=0445 РЪКАВИЦИ - ТРИКО - БЕЛИ - KITE LUX
RESTORE(gz) elapsed=53.9s   gz-restored objects=95090
```

**Every count matches the source exactly, `dataSize` is byte-identical, all 14 product indexes
rebuild, and Cyrillic survives.** `mongodump --oplog` was also verified working against this
deployment (92.33 MiB in 1.9 s, `dumped 1 oplog entry`) — so a *consistent* point-in-time
snapshot costs nothing extra and **MUST** be the default.

⚠ Incidental but useful: restored `indexSize` is **16.9 MB against production's 71.6 MB**. The
production indexes carry ~4× bloat. A restore is also a compaction, which makes a
restore-verify a cheap way to know what the database *should* cost.

---

## 4. Constraints that bound the policy

### 4.1 Statutory retention (ЗСч чл. 12 / ДОПК чл. 38 ал. 1)

| data | minimum retention |
|---|---|
| payroll ledgers (*ведомости за заплати*) | **50 years** |
| accounting registers, financial statements, invoices and notices | **10 years** |
| documents for tax/insurance control | 5 years after the limitation period expires |
| all other carriers of accounting information | 5 years |

The clock starts on **1 January of the reporting period following** the one the data belongs
to. So regal-pz's 2026 documents must survive until at least **2037-01-01**, and any payslip
until **2077**. These are floors on *deletion*, and they bind the archive policy far more than
disk cost does — the year-10 numbers in §2.3 are the reason the floor is affordable rather
than the reason it is hard.

### 4.2 Приложение 29, т. 16 — the constraint that shapes the whole archive design

> „При архивиране на базата данни софтуерът осигурява създаване и поддържане на архив, както и
> достъп до архивните данни в сроковете по чл. 38, ал. 1 от ДОПК **през потребителски
> интерфейс**."

*When the database is archived, the software must provide for the creation and maintenance of
an archive **and access to the archived data through the user interface** for the periods of
ДОПК Art. 38(1).* Point 19 additionally requires the **auditor profile** (`nra_auditor`) to
reach the point-16/17/18 functionality.

**A tarball in a bucket does not satisfy this.** For a СУПТО org, "archiving" may not mean
"remove from the live system"; archived data must remain reachable from within LGR, by an NRA
auditor, for ten years. This single sentence is why §6 archives *file bytes with a live
metadata row and on-demand rehydration* rather than deleting rows, and why §6 forbids any TTL
on a fiscal collection.

### 4.3 The email ceiling is 14.6 MiB, not 20

`email.service.ts:46` declares `MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024`, but `:103-111`
base64-encodes first and then sums `a.content.length` — the cap is applied to the **encoded**
length. The real binary payload ceiling is therefore **20 MiB ÷ 4/3 = 14.6 MiB**. Against §2.3:

| after | brotli q5 full | as base64 | fits? |
|---|---|---|---|
| year 1 | 9.1 MB | 12.5 MB | ✅ |
| year 2 | 15.7 MB | 21.5 MB | ❌ |
| year 3 | 22.2 MB | 30.4 MB | ❌ |

**A full backup by email works for roughly the first 20 months of an org's life and then stops
— silently, as a `provider_error`.** A *delta* by email (30–430 KB) works indefinitely. The
policy in §5.4 follows this exactly, and requires the size check to be made *before* sending so
the failure is a logged, alerting decision rather than a bounced message.

### 4.4 Confidentiality

A dump contains 90 bcrypt password hashes (§1.4), every contact's `taxId`/`vatNumber`/address,
every invoice, and the OAuth identities linking real people to the org. mars is a shared host
and any off-site destination is by definition outside the cluster's trust boundary.
**Encryption before the bytes leave the cluster is not optional** (§5.6).

---

## 5. Requirements — backup

FR-13 is deliberately **two layers plus an attended path**. Layer 1 (§5.1) is pure ops, ships
in a day, and closes the "there are no backups" hole for the whole cluster. Layer 2 (§5.3) is
application code, gives per-org granularity and the UI that §4.2 demands. §5.7 adds the
**manual, operator-driven** backup and restore-from-file screen — a *system-administrator*
function, gated separately from everything else, because restoring is the most destructive
operation the product exposes. Layer 1 **MUST** ship first and **MUST NOT** wait for either.

### 5.1 Layer 1 — infrastructure DR (no application code)

**FR-13.1** Three scripts **MUST** be added to `lgr-deploy/scripts/`, modelled on
`roomler-deploy/scripts/*` so the operator sees one pattern, with the corrections below:
`backup-mongodb.sh`, `backup-uploads.sh`, `verify-backups.sh`.

**FR-13.2** `backup-mongodb.sh` **MUST** produce a *consistent* archive and compress the
**whole stream**, not per collection:

```bash
kubectl -n lgr exec mongodb-0 -c mongodb -- \
  mongodump -u "$U" -p "$P" --authenticationDatabase admin --oplog --archive \
  | zstd -19 -T4 > "$BACKUP_DIR/lgr-$DATE.archive.zst"
```

`--oplog` (verified working, §3.5) makes it a point-in-time snapshot; a plain `mongodump`
against a live replica set is not. `--archive` keeps it a single binary stream. External
zstd -19 is 45 % smaller than `--gzip` (§3.2). Restore is
`zstd -d` then `mongorestore --archive --oplogReplay`.

**FR-13.3** `backup-uploads.sh` **MUST** use `rsync --link-dest` hard-link rotation against
`k8s-worker-2:/data/lgr/uploads/`, and **MUST** fail loudly when the `latest` symlink is
missing or the snapshot is empty — the exact condition that has left roomler with zero uploads
snapshots (§1.1). Compression is not applied to the rotation (§3.3); the *archive* tier
compresses instead (§6).

**FR-13.4** Sanity gates. Each script **MUST** exit non-zero when the artifact is smaller than
a floor (`> 1 MB` for the Mongo dump at today's 3.2 MiB — the roomler script's 1,000-byte floor
would pass a truncated file), when the file count drops versus the previous snapshot, or when
`zstd -t` fails to validate the archive.

**FR-13.5 — verification must restore.** `verify-backups.sh` **MUST**, weekly, restore the
latest archive into a throwaway `mongo:7` container and assert per-collection document counts
against the live database within a tolerance for the elapsed window; a stat-and-mtime check is
**not** sufficient. Measured cost: **51 s**. It **MUST** also `zstd -t` every retained artifact
and check the age of the newest (< 25 h).

**FR-13.6 — the result must reach a human.** Verification output **MUST** be surfaced in the
FR-11 daily digest as a "Backups" section (last full, age, size, last successful restore-test,
retained counts per tier). A failure **MUST** render as a visible failure line, not an absent
section. The roomler precedent proves that a cron job writing to a log nobody reads is
indistinguishable from no backup at all.

**FR-13.7 — schedule.** Deliberately avoiding the already-occupied 03:00 / 03:30 / 04:00 slots
in mars's crontab (§1.1):

| when | job | measured cost | artifact today |
|---|---|---|---|
| hourly, 07:00–20:00 | oplog delta since last checkpoint | < 1 s | 2–20 KB |
| 02:30 daily | full `mongodump --oplog \| zstd -19` | ~18 s | 3.2 MiB |
| 03:15 daily | uploads `rsync --link-dest` | seconds | ~2.9 MB new |
| 03:45 daily | Layer-2 per-org bundle + email (§5.4) | seconds | < 1 MB |
| 04:30 Sun | restore-verify into a throwaway container | 51 s | — |
| 05:00 1st of month | promote latest full to the monthly tier | — | — |
| 05:00 2 Jan | promote to the yearly tier, xz -9e, encrypt | ~70 s | — |

**FR-13.8 — GFS retention.** 14 daily · 8 weekly · 24 monthly · **10 yearly** (the §4.1 floor).
Total at year-10 sizes: 56 × 60 MB ≈ **3.4 GB** — against 122 GB free on mars. Retention
**MUST** be expressed in *generations kept*, never `find -mtime +N -delete`, so that a run of
failed backups cannot silently age out the last good copy.

**FR-13.9 — the delta job.** Hourly, dump `local.oplog.rs` filtered to
`{ts: {$gt: <last checkpoint>}, op: {$ne: 'n'}}`, compress with zstd -19, and record the new
high-water `ts` in a checkpoint file. The job **MUST** verify that its `$gt` bound still lies
inside the live oplog window before trusting the chain, and **MUST** escalate to a full backup
when it does not. (Today's window is 134.8 days, so this is a guard against a future write-rate
change, not a live risk.)

### 5.2 Destinations — evaluated

| tier | destination | today | year 10 | verdict |
|---|---|---|---|---|
| 1 | **mars local disk** `/home/gjovanov/lgr-deploy/backup` | 3.2 MiB/night | 60 MB/night, ~3.4 GB retained | **MUST.** Different physical host from k8s-worker-2/zeus; 122 GB free; already the house pattern. |
| 2 | **second cluster host** (jupiter) over the existing WireGuard overlay | same | same | **SHOULD.** Nearly free, protects against losing mars. |
| 3 | **external object store** (Backblaze B2 / Cloudflare R2 / Hetzner Storage Box), S3 API | ~100 MB total | ~10 GB total | **MUST.** The only true off-site copy and the only real gap. ~€0.5–5/month at these volumes. No S3 SDK is in the tree today; `rclone` or `aws s3 cp` from the job avoids adding one. |
| 3b | **Google Drive** (OAuth refresh token — **not** an API key, §5.8) | 3.2 MiB/night | `data` chain ~3.4 GB | **MAY, as an alternative tier-3.** Cheaper and more familiar than S3, and the adapter is already stubbed in-tree. Free account is 15 GB shared with Gmail/Photos, so it holds the `data` chain and the yearly archive but **not** the `full` uploads rotation. No object-lock: the writing credential can also delete (FR-13.58). |
| 4 | **email** (SendGrid, existing integration) | delta 30–430 KB | delta unchanged | **SHOULD for the delta and the manifest; MUST NOT be the only copy.** Full-by-email dies at ~month 20 (§4.3). |
| 5 | **in-cluster MinIO** (`roomler-ai/minio-0`, 10 Gi, already running) | — | — | **MAY**, as a convenient staging target only. Same cluster ⇒ **not** off-site; it does not satisfy tier 3. |

3-2-1 restated for LGR: **3 copies** (live, mars, off-site object store), **2 distinct
media/hosts**, **1 off-site**. Today LGR has one copy and zero backups.

### 5.3 Layer 2 — per-org backup in the application

**FR-13.10** A scheduler **MUST** be added to `unified.ts` beside the FR-11 digest tick, with
`config.backup.checkIntervalMs` (`0` disables it entirely; `.env.test` **MUST** set `0` so no
test ever writes a bundle or sends mail).

**FR-13.11** A `BackupRun` model **MUST** carry a unique index on `{orgId, kind, date}` — kind
∈ `full | delta`. That index **is** the lock, exactly as `DigestRun`'s is (§1.3): the first
writer claims the day, concurrent pods take E11000 and stand down. ⚠ Two dates are in play and
conflating them is the same bug FR-11 called out: a run is *claimed* under the day it executes
and *covers* the day before.

**FR-13.12** The per-org bundle **MUST** be a single binary artifact containing, per
collection, the org's documents as length-prefixed BSON or NDJSON, plus a `manifest.json`
carrying: org id and slug, kind, covered window, per-collection document counts, a SHA-256 per
collection stream and one over the whole bundle, the schema/migration version, and the app
image tag. The manifest **MUST** be reproducible from the bundle so a restore can prove
completeness rather than assume it.

**FR-13.13** Compression **MUST** be `zstd` level 19 for full bundles and level 3 for deltas,
via the natively available `zlib.zstdCompressSync` (§1.3). Where brotli is preferred it
**MUST** pin quality **5** explicitly (§3.2) — the library default of 11 takes 45 minutes on
this data and will read as a hung job.

**FR-13.14** Bundles **MUST** be written under `<UPLOAD_DIR>/<orgId>/backups/` so they inherit
the existing PV, the existing per-org isolation, and the Layer-1 uploads rotation for free.

**FR-13.15** Endpoints, admin-only, following the FR-11 digest controller's raw role guard:
`POST /org/:orgId/backup/run` (kind, force), `GET /org/:orgId/backup/runs` (history + sizes +
checksums), `GET /org/:orgId/backup/:id/download` (streams the artifact), `POST
/org/:orgId/backup/test-email` (sends to the **caller only**, never a configured list — the
FR-11 precedent). ⚠ Every one of these **MUST** carry its own explicit `if (!user) return
status(401)`; per `CLAUDE.md` the `isSignIn` macro does not by itself reject anonymous callers
on these controllers, and that check is load-bearing.

### 5.4 Email delivery

**FR-13.16** The daily email **MUST** always carry the **manifest** (a few KB: checksums,
counts, destinations reached) so the operator can prove what should exist even when the payload
is too large to send.

**FR-13.17** The **delta MUST** be attached (30–430 KB, viable indefinitely).

**FR-13.18** The **full MAY** be attached, gated on a pre-flight check against the *effective*
ceiling of **14.6 MiB of binary** (§4.3), computed on the base64 length exactly as
`email.service.ts:110` does. Over the ceiling, the send **MUST** be skipped with a logged,
digest-visible reason — never attempted and left to fail as a `provider_error`. Expected
crossover for regal-pz: **~month 20**.

**FR-13.19** Email **MUST NOT** be counted as one of the three copies in §5.2. It is a courier
of last resort, not a backup destination.

### 5.5 Recovery objectives

**FR-13.20** **RPO ≤ 1 hour** during trading hours, from the hourly oplog delta. **RTO ≤ 1
hour**: measured restore 51 s + pod restart; the remainder is human decision latency, which is
what the runbook (FR-13.22) is for.

**FR-13.21** A restore **MUST** be possible to a *point in time*, not only to a nightly
boundary: `zstd -d` the full, `mongorestore --archive --oplogReplay`, then replay the delta
slices in order up to the chosen `ts`.

**FR-13.22** A runbook **MUST** live in `lgr-deploy/` covering: full-cluster loss, single-org
loss (restore the bundle into a scratch database and copy the org's documents back — never
restore a whole database over a live multi-tenant one), accidental mass-delete, and PV
corruption. It **MUST** be rehearsed once before sign-off and the rehearsal timed.

### 5.6 Security

**FR-13.23** Any artifact leaving the cluster **MUST** be encrypted at rest — `age` (simplest)
or `gpg`, recipient key held outside mars. The private key **MUST NOT** live on mars or on any
cluster node, and the runbook **MUST** state where it does live: an encrypted backup whose key
is lost with the cluster is not a backup.

**FR-13.24** Backup artifacts **MUST NOT** be served from any unauthenticated route. The
download endpoint is admin-only, and bundles under `<UPLOAD_DIR>/<orgId>/backups/` **MUST NOT**
be reachable by the static-file handler.

**FR-13.25** Creating, downloading and restoring a backup **MUST** each write an `AuditLog`
entry (`module: 'admin'`), including the destinations reached.

### 5.7 Manual backup and restore from a file — a **system-administrator** function

Everything above runs unattended. This section adds the attended path: a screen where an
operator takes a backup on demand, downloads it, and restores from a file.

**This is a system-administrator surface, not an org-admin one**, and that distinction has to
be built rather than assumed — see FR-13.26. Restoring is the most destructive operation the
product will ever expose: it can delete issued fiscal documents, roll invoice numbering
backwards into numbers already in customers' hands (FR-13.34), and write rows into an org that
`tenantPlugin` will then hide from every query (FR-13.31). The shop owner who runs regal-pz is
an `admin`; they are not the person who should have this button.

**FR-13.26 — LGR has no system-administrator role, and this feature needs one.**
`ROLES = ['admin','manager','accountant','warehouse_manager','member','nra_auditor']`
(`config/constants.ts:1`). The highest role is `admin`, and it is **org-scoped**: every route
is `/org/:orgId/…`, every model carries `tenantPlugin`, and `admin` expands to
`admin.users`, `admin.settings`, `admin.audit` plus every non-admin permission **within one
org**. There is no cross-org identity and no platform operator. Therefore:

- **P1 (ships with this FR): a config allow-list.** `config.backup.sysAdmins` — a
  comma-separated list of user ids or emails, checked **server-side** on every route in this
  section, in addition to the existing role guard. This deliberately avoids the
  PermissionSet/JWT path: a new permission would need a model change, a `PermissionSet`
  backfill and a re-login before it took effect, because a JWT carries the permission list it
  was issued with. FR-06 P2 already paid for that lesson —
  `scripts/backfill-reports-permissions.ts` plus "tell people to re-login", with the symptom
  of skipping it being a silently missing tile. An allow-list has no such ordering hazard and
  is correct from the first request after deploy.
- **P2 (follow-up, out of scope here): a real `platform.admin` permission** and a `sys_admin`
  role, with the deploy → backfill → re-login sequence written down before it ships.
- **The allow-list MUST be empty by default.** An unset `config.backup.sysAdmins` means the
  restore routes 403 for everyone, including org admins. Failing closed is the point.

**FR-13.27 — where it lives.** A new route `admin/backup` → `portal-ui/src/views/admin/
BackupView.vue`, beside the existing `admin/audit-log` → `views/admin/AuditLogView.vue`
(`portal-ui/src/router/index.ts:39`). It **MUST NOT** go under `settings/` — that group
(Organization, Users, Invites, Billing, Permission Sets) is the org owner's self-service area,
and this is not self-service. ⚠ Portal routes carry **no client-side role gating** today; the
server 403s. Hiding the nav entry is presentation only — **the allow-list check on the server
is the whole of the security** and every route in this section **MUST** carry it explicitly,
alongside the explicit `if (!user) return status(401)` that FR-13.15 already requires.

**FR-13.28 — the desktop already has this, unwired.** `packages/desktop/src-tauri/src/
archive.rs` exposes `create_archive`, `restore_archive`, `list_archives`, `delete_archive`,
`cleanup_old_archives` and `get_archive_stats` as Tauri commands — and `desktop-ui/src/views/`
contains only `auth/`, so **nothing consumes them**. The cloud screen **SHOULD** mirror that
command surface name-for-name so the desktop shell can later be pointed at the same view
instead of growing a second, divergent one.

**FR-13.29 — manual backup (create + download).** "Create backup now" **MUST** dispatch a
`BackgroundTask` and poll, never block the request. The Files app already paid for this: the
OCR sidecar draft at ~53 s exceeded the ingress proxy timeout and had to become an async job.
Today's bundle takes seconds; at year-10 volumes (737k documents) it will not. Two variants,
selected explicitly and named in the UI with their estimated size **before** the run starts:

| variant | contents | today | year 10 | usable destinations |
|---|---|---|---|---|
| `data` | Mongo rows only | 3.2 MiB | ~68 MB | disk · S3 · email (while under §4.3) |
| `full` | Mongo rows **+ the org's `docs/` files** | ~80 MB | ~6.9 GB | disk · S3 only |

**FR-13.30 — restore from file: getting the bytes in.** Upload is multipart, matching the Files
app pattern (`files-ui/src/views/FileUploadView.vue:340` — `FormData` +
`Content-Type: multipart/form-data`). ⚠ **`config.upload.maxFileSize` is `50_000_000`**
(`config/index.ts:95`): a `full` bundle exceeds it **today**, and a `data` bundle exceeds it
around **year 8**. The route **MUST** therefore either carry its own higher cap or accept an
artifact already on the server — and restoring the org's own most recent bundle **MUST NOT**
require a round trip through the browser at all. Sources the UI **MUST** offer: a listed run
from `GET /backup/runs`, a path on the backup volume, and an uploaded file.

**FR-13.31 — validate everything before writing anything.** Mirror the desktop sequence
(`archive.rs:78-146`), which is the in-tree precedent and is correct: decompress → check the
format → verify integrity → stage → verify again → swap → roll back on failure. In the cloud:

1. Decompress and verify **every** SHA-256 in the manifest (FR-13.12). Any mismatch aborts
   before a single write — the desktop's magic-byte check is the same instinct.
2. Compare `manifest.orgId` with `:orgId` (FR-13.32).
3. Compare `manifest.schemaVersion` and image tag with the running app: **refuse** a bundle
   newer than the running code, **warn** on an older one.
4. Restore into a **staging namespace first**, never straight over live collections.

**FR-13.32 — the multi-tenant hazard.** A bundle carries its origin `orgId`. Restoring bundle A
into org B while keeping that `orgId` writes documents `tenantPlugin` filters out of every
query — rows that exist, occupy space, appear in every future backup, and are invisible in the
UI. The restore **MUST** refuse when `manifest.orgId !== :orgId` unless a **remap** is
explicitly requested, in which case every `orgId` **and every cross-collection reference**
is rewritten. Remap is the clearest example of why this is a sys-admin function.

**FR-13.33 — restore modes; the default writes nothing.**

| mode | effect | gate |
|---|---|---|
| **Inspect** (default) | writes nothing; renders a per-collection diff — in bundle / in live / differing / missing | sys admin |
| **Merge (additive)** | inserts only documents absent from live; never updates, never deletes | sys admin + confirm |
| **Replace org** | deletes the org's documents in the covered collections, then restores | sys admin + typed org slug + FR-13.35 |

Inspect **MUST** have been run on the bundle, and its result shown, before either writing mode
can be selected. Merge is the mode that answers the common real need ("something was deleted by
mistake") and it cannot destroy anything.

**FR-13.34 — a safety backup is mandatory and automatic.** Before any writing restore the
system **MUST** take a fresh `data` bundle of the target org and confirm it verifies. This is
exactly what the desktop does by renaming the live database to `.db.pre-restore` before
installing the restored one, and renaming it back if the install fails (`archive.rs:120-133`).
A restore that cannot first back up **MUST** abort. A restore that fails part-way **MUST** roll
back from that safety bundle and say so.

**FR-13.35 — sequences never move backwards.** §8 already forbids resetting `Sequence` rows; a
restore button makes violating it a two-click operation. On any writing restore each
`Sequence.lastNumber` **MUST** be set to `max(live, bundle)` — **never** to the bundle's value.
Rolling a counter back reissues a document number that is already in a customer's hands and in
the numbering continuity the NRA expects (and that FR-11's digest checks per family). That is a
fiscal defect, not a data defect, and it is invisible until the duplicate surfaces weeks later.
The restore report **MUST** list every sequence it clamped and by how much.

**FR-13.36 — SUPTO orgs cannot be Replaced.** Наредба Н-18 / Приложение 29 forbid deleting or
modifying completed sales (`docs/supto/COMPLIANCE-CHECKLIST.md` rows 21–24: *„Без изтриване на
завършени продажби"*, *„Сторно операции вместо изтриване"*, *„Защита от промяна/изтриване"*).
For an org with an active `FiscalDevice`, or with any `locked` fiscal year inside the bundle's
range, **Replace MUST be blocked**; Merge remains available. Deleting an issued invoice to
tidy up a restore is precisely the operation the ordinance exists to prevent.

**FR-13.37 — files, dangling references, and honest reporting.** A `data` restore reinstates
`DocFile` rows whose bytes may not be on the PV. The result **MUST** count and list the
dangling references, and the UI **MUST** state plainly that a data-only restore does not bring
the documents themselves back. A `full` restore **MUST** verify each file's checksum as it
lands and report any that fail. Every manual backup, download and restore **MUST** write an
`AuditLog` entry (FR-13.25) naming actor, mode, bundle window and checksum, and the counts
written — and a restore **MUST** also surface in the next FR-11 digest, so that an operator
action against live data is visible to the people who did not perform it.

### 5.8 Google Drive as an off-site destination

**FR-13.48 — API keys cannot do this, and the repo already assumed they couldn't.** A Google
API key authenticates *anonymous access to public data*; writing to a private Drive requires
**OAuth 2.0**. A service account is not a shortcut either: **service accounts have no storage
quota and cannot own files** — they must write into a **Shared Drive** (Google Workspace only)
or act on behalf of a human through domain-wide delegation, and uploading to a service
account's own My Drive fails with `403 storageQuotaExceeded` even when that Drive is empty.

So Drive backup uses **OAuth 2.0 with a long-lived refresh token** — which is exactly what the
codebase already models: `Org.settings.integrations.googleDrive`
`{ accessToken, refreshToken, expiresAt, email }` (`org.model.ts:89` + `:203`, mirrored in the
DAL at `dal/src/entities/core.ts:41`), with `config.integrations.google` already carrying
`clientId` / `clientSecret` / `redirectUri` (`config/index.ts:104-108`). **No API key is
introduced anywhere in this FR.** If the intent behind "API keys" was *"credentials in config
rather than a per-org click-through"*, the equivalent is a **one-time consent whose refresh
token is then held in config or a secret** — same operational feel, and the only shape Google
actually permits.

**FR-13.49 — complete the existing placeholder; do not add a second integration.**
`services/biz/cloud-storage.service.ts` already defines `CloudStorageAdapter`,
`googleDriveAdapter`, `dropboxAdapter`, `onedriveAdapter` and `getAdapter('google_drive')`.
Every method is a stub — `handleCallback` returns empty strings, `listFiles` returns `[]`,
`downloadFile` returns a zero-length `Buffer`. FR-13 **MUST** implement that adapter rather
than grow a parallel Drive client.

**FR-13.50 — the adapter interface is read-only and must be extended.** `CloudStorageAdapter`
has exactly four methods — `getAuthUrl`, `handleCallback`, `listFiles`, `downloadFile` —
because it was designed for *importing* documents, not writing them. Backups need
`uploadFile`, `deleteFile` (for GFS rotation) and `ensureFolder`. Extending a shared interface
means the Dropbox and OneDrive stubs **MUST** gain the same signatures — throwing
`not_implemented` is acceptable — or the type stops compiling.

**FR-13.51 — scope.** The current scope is `https://www.googleapis.com/auth/drive.readonly`
(`cloud-storage.service.ts:24`), which cannot write. Use **`drive.file`** — per-file access
limited to files the app itself created — **not** full `drive`. A backup job only ever touches
its own artifacts, so `drive.file` is sufficient, and it means a leaked token cannot read the
user's other documents. ⚠ Changing the scope invalidates existing consent: any org already
connected under `drive.readonly` must re-consent.

**FR-13.52 — uploads MUST be resumable.** Google's simple and multipart uploads are for
**≤ 5 MB**; larger files require `uploadType=resumable`, and Google recommends resumable even
for small files at the cost of one extra HTTP request. Today's `data` bundle is 3.2 MiB — under
the threshold — but it crosses 5 MB inside year 1, and a `full` bundle is ~80 MB today and
~6.9 GB at year 10 (§2.3). **Implement resumable only**, so there is no size at which the code
path changes. An interrupted upload resumes by sending an empty `PUT` with
`Content-Range: bytes */{total}` and continuing from the returned `Range`. A partial upload
**MUST NOT** be recorded as a destination reached.

**FR-13.53 — no new dependency.** The placeholder comment says *"requires googleapis
package"*. It does not: the Drive endpoints are plain HTTPS, and the house pattern for
third-party APIs is raw `fetch` (`oauth.service.ts:42`, `email.service.ts:112`). Pulling
`googleapis` into an image that already carries Chromium is not worth it. **SHOULD** use
`fetch`.

**FR-13.54 — token refresh is a first-class failure mode, not an edge case.** Access tokens
last ~1 hour, so the nightly job will **always** start with an expired one and **MUST** refresh
from `refreshToken` before uploading, persisting the new `expiresAt`. A refresh token dies on
password change, consent revocation, or ~6 months idle. The job **MUST** distinguish
*"refresh failed — re-consent required"* from a transport error, surface it in the digest
(FR-13.6), and **MUST NOT** count the destination as reached. A silently-dead Drive token is
the roomler `latest`-symlink failure wearing a different costume.

**FR-13.55 — ⚠ the org settings PUT silently strips `integrations`.** `PUT /org/:orgId`
whitelists the settings sub-object and already drops `accounting` and `integrations` (FR-11
§1), and a partial `settings` object **replaces the whole subdocument** (`findByIdAndUpdate`).
Drive tokens **MUST** therefore be written by a dedicated endpoint —
`GET /org/:orgId/integrations/google-drive/auth-url` and
`POST /org/:orgId/integrations/google-drive/callback`, sys-admin gated per FR-13.26 — which
**MUST** merge into `settings.integrations` rather than replace it. ⚠ Note also that
`handleCallback(code)` takes **no `orgId`**; the existing design smuggles it through
`redirectUri.replace('{orgId}', orgId)` (`cloud-storage.service.ts:25`). Keep that, or change
the signature — but do not assume the callback knows its org.

**FR-13.56 — ⚠ the backup contains the key to the backup.** The refresh token is stored in
**plaintext** on the Org document, and `orgs` is in every dump. So any bundle carries the
credential that can write to — and **delete from** — its own off-site destination. Therefore:
encryption before upload (FR-13.23) is doubly mandatory for Drive-bound artifacts; the Drive
folder **MUST** be dedicated to backups and not shared with anything else; and the credential
**MUST** be independently revocable — a **dedicated Google account**, never the owner's
personal one. **SHOULD**: hold the refresh token in the sealed secret rather than the Org
document, which breaks the circularity outright.

**FR-13.57 — capacity: what Drive may and may not hold.** A free Google account has **15 GB
shared across Drive, Gmail and Photos**.

| artifact | today | year 10 | fits a free 15 GB account? |
|---|---|---|---|
| one `data` bundle | 3.2 MiB | ~68 MB | yes |
| `data` GFS chain (56 generations) | ~180 MB | ~3.4 GB | yes |
| one `full` bundle (incl. uploads) | ~80 MB | ~6.9 GB | one, barely |
| `full` GFS chain | — | ~380 GB | **no** |

Drive **MAY** therefore carry the `data` GFS chain and the yearly cold archive; it **MUST NOT**
be relied on for the `full` uploads rotation on a free account. The job **MUST** read
`about.get?fields=storageQuota` and refuse up front with a clear message when the artifact will
not fit, rather than failing mid-transfer.

**FR-13.58 — Drive satisfies tier 3, with one caveat object storage does not have.** Drive is
an acceptable off-site destination (§5.2 tier 3) and is cheaper and more familiar than S3. But
it has **no object-lock or write-once retention**: the same credential that writes can delete,
so a leaked token or a buggy rotation can destroy the off-site copy — where S3 with versioning
plus Object Lock cannot. An operator choosing Drive as the *only* off-site copy is accepting
that. **SHOULD** keep the yearly cold tier additionally on object storage.

**FR-13.59 — layout, listing, retention and verification.** One dedicated folder tree,
`LGR Backups/<org slug>/<tier>/`, files named
`lgr-<orgSlug>-<kind>-<YYYY-MM-DD>.archive.zst[.age]`. Retention reuses the FR-13.8 generation
counts via `listFiles` + `deleteFile` — generations kept, never age-based deletion.
`appProperties` **MUST** carry the manifest checksum and the covered window, so the remote copy
is self-describing without downloading it. Verification (FR-13.5) **MUST** include, at least
weekly, **downloading the newest Drive artifact and checking its checksum** — an upload that
returns `200` and stores nothing readable is precisely the failure mode §1.1 exists to warn
about.

---

## 6. Requirements — archiving (cold storage)

Driven by §2.4 and bounded by §4.2. The **only** hot resource under real pressure is the
uploads volume.

**FR-13.38 — the archive unit is a locked fiscal year, not a date.** `FiscalYear.status` is
already `open | closed | locked` (`fiscal-year.model.ts:22`). Archiving **MUST** be triggered
by `locked`, never by age alone: a year that is still being corrected must stay hot regardless
of the calendar. Every archivable collection already has an indexed date to range-scan on —
`Invoice.issueDate` `{orgId,direction,issueDate:-1}` · `StockMovement.date` `{orgId,type,date:-1}`
· `AuditLog.timestamp` `{orgId,timestamp:-1}` · `POSTransaction.createdAt` · `JournalEntry.date`
· `DocFile.docDate` `{orgId,docDate,docType}` · `EmailLog.createdAt`.

**FR-13.39 — tiers.**

| tier | contents | where | readable how |
|---|---|---|---|
| **hot** | current + previous fiscal year; all Mongo rows regardless of age | live DB + uploads PV | the app, normally |
| **warm** | file *bytes* for locked fiscal years ≥ 2 years old | `.tar.zst` per fiscal year, on the PV or tier-3 object store | **through the UI**, rehydrated on demand (§4.2) |
| **cold** | yearly full dump + yearly uploads archive | off-site, xz -9e, encrypted | restore procedure; retained to the §4.1 floor |

**FR-13.40 — Mongo rows are NOT moved out.** At 1.76 GB of BSON after ten years (§2.3) there is
no capacity argument, and moving fiscal rows out of the live database would put §4.2 compliance
at risk for no gain. This is a deliberate, recorded decision, and FR-13.47 defines the volume
at which to revisit it.

**FR-13.41 — file archiving.** For a locked fiscal year older than the configured horizon
(default **2 years**), the archive job **MUST**: pack that year's `docs/<date>/…` tree into one
`.tar.zst` (level 19; measured 1.46× — the win is inode and rotation cost, not bytes), verify
the archive restores the same SHA-256 per file, then remove the loose files and set
`DocFile.archived = true` + `archiveRef` on each row. **The `DocFile` row itself stays live and
listed.**

**FR-13.42 — rehydration.** Opening an archived document **MUST** work from the normal UI for
any user who may read it, including `nra_auditor` — extracting the single member from the
`.tar.zst` (or fetching it from the object store) on demand, with a visible "retrieving from
archive" state. This is what makes §4.2 satisfied rather than merely claimed.

**FR-13.43 — retention rules for non-fiscal collections.** These are the only rows FR-13 ever
deletes:

| collection | rule | rationale |
|---|---|---|
| `EmailLog.body` | strip after **90 days**, keep the row | 28 MB/yr, 52 KB/row, non-fiscal; the row is the audit trail, the HTML is not |
| `EmailLog` row | delete after **1 year** | non-fiscal delivery log |
| `BackgroundTask` | unchanged 7-day TTL | already correct |
| `DocFile.compareSummary` | strip once the doc is `committed`/`superseded` | up to 113 KB per row |
| `e2e-*` orgs | purge from production | 73 of 80 orgs; `cleanup-e2e-data.sh` exists |

**FR-13.44 — nothing else may be deleted.** `Invoice`, `StockMovement`, `POSTransaction`,
`JournalEntry`, `AuditLog`, `Sequence`, `PayrollRun`, `Payslip`, `DocFile`, `Product`,
`Contact`, `Warehouse` **MUST NOT** be TTL'd, pruned or hard-deleted by any archive job.
Payroll carries a **50-year** floor (§4.1) — longer than the rest of the system by 40 years,
and easy to forget.

**FR-13.45 — an archive UI.** A read-only "Archives" view (Settings, or a Files-app tab)
**MUST** list archive units, their coverage, size and checksum, and allow a `nra_auditor` to
browse and export from them. Приложение 29 т. 19 requires the auditor profile to reach т. 16
functionality; a policy with no UI does not satisfy т. 16.

**FR-13.46 — archiving MUST be reversible.** Un-archiving a fiscal year (restoring loose files
and clearing `archived`) **MUST** be a supported admin action.

**FR-13.47 — revisit triggers.** Reopen FR-13.40 when any of: live `dataSize` > 20 GB · a
single org > 5 GB of BSON · > 50 real tenants · restore time > 15 minutes. At the measured
regal-pz rate none of these arrives before year 10.

---

## 7. Edge cases and traps

1. **`mongodump --gzip` looks like the obvious choice and costs 45 % of the artifact** (§3.2).
2. **`brotliCompressSync` defaults to quality 11 = 45 minutes on this data** (§3.1). Pin q5.
3. **`updatedAt`-based deltas carry 81 % of the database and cannot see deletes** (§3.4).
4. **The email cap is applied to base64**, so the real ceiling is 14.6 MiB, not 20 (§4.3).
5. **Uploads do not compress** (1.18×) — dedupe, don't compress the hot rotation (§3.3).
6. **`find -mtime +N -delete` can delete the last good backup** after a run of failures.
   Retention counts generations (FR-13.8).
7. **The oplog is on the same PV as the data** — it is a delta *source*, never a delta *copy*.
   Slices must be shipped off-host within the hour to mean anything.
8. **A restore into a live multi-tenant database is destructive.** Per-org recovery goes via a
   scratch database (FR-13.22).
9. **The app image has no `mongodump`** (§1.3) — dump jobs run in `mongo:7`.
10. **Claim-day vs covered-day**, the FR-11 bug, applies identically here (FR-13.11).
11. **A bulk ops day makes the delta 14× a normal day** (18 MB raw / 432 KB compressed,
    2026-08-28). Sized for, not a failure.
12. **Restoring compacts indexes 4×** (§3.5) — do not read a size drop after restore as loss.
13. **`config.backup.checkIntervalMs` must be 0 in `.env.test`**, or a test run mails a backup.
14. **Encrypting with a key stored on mars** protects nothing against losing mars (FR-13.23).
15. **73 e2e orgs ride along in every dump and every restore** (§1.4).
16. **There is no sys-admin role to gate the restore screen on** — the highest role in the
    product is an *org-scoped* `admin` (FR-13.26). Gating on `role === 'admin'` would hand the
    regal-pz shop owner a button that can delete issued fiscal documents.
17. **Restoring a bundle into the wrong org writes invisible rows** — `tenantPlugin` filters
    them out of every query, so the data is present, backed up forever, and unreachable
    (FR-13.32).
18. **A restore that rolls `Sequence.lastNumber` backwards reissues invoice numbers already
    sent to customers** (FR-13.35). Silent for weeks.
19. **`config.upload.maxFileSize` is 50 MB** — restore-by-browser-upload fails today for a
    `full` bundle and around year 8 for a `data` one (FR-13.30).
20. **Client-side route gating does not exist in the portal** — hiding the nav entry hides
    nothing. The server-side allow-list check is the entire control (FR-13.27).
21. **A new permission would need deploy → backfill → re-login before it took effect**, because
    a JWT carries the permissions it was issued with. That ordering hazard is why P1 uses a
    config allow-list instead (FR-13.26).
22. **A Google API key cannot write to Drive at all** — keys authenticate anonymous access to
    *public* data (FR-13.48). Building against one fails at the first authenticated call.
23. **A service account looks like the fix and is not**: no storage quota, cannot own files,
    `403 storageQuotaExceeded` even against an empty Drive. Shared Drive (Workspace) or OAuth
    delegation only (FR-13.48).
24. **The existing Drive scope is `drive.readonly`** — it cannot write, and changing it
    invalidates any consent already granted (FR-13.51).
25. **`CloudStorageAdapter` has no `uploadFile`** — the interface is read-only, and extending it
    breaks the Dropbox/OneDrive stubs unless they gain the same signatures (FR-13.50).
26. **Simple/multipart Drive uploads cap at 5 MB.** Today's bundle is 3.2 MiB, so a naive
    implementation works right up until it silently stops working in year 1 (FR-13.52).
27. **The Drive refresh token is stored in plaintext in `orgs`, so it is inside every dump** —
    the backup carries the credential to its own destination, and that credential can delete
    (FR-13.56).
28. **`PUT /org/:orgId` silently strips `integrations`** — tokens written that way vanish with
    no error (FR-13.55).
29. **An access token is always expired by the time the nightly job runs.** Refresh is the
    normal path, not the exception; a dead refresh token must not read as success (FR-13.54).

---

## 8. Integration constraints

- The five migration CLI skills drive `POST /org/:orgId/bills/import/*` against the deployed
  API; FR-13 touches none of it, and the nightly job **MUST NOT** hold locks that could block
  an import.
- Backup runs **MUST NOT** collide with the FR-11 digest tick — the digest reads the previous
  day and the full backup is claimed for the same window. FR-13.7 schedules the bundle at 03:45
  and the digest reads at its org-configured hour.
- `mongodump` reads from the primary of a single-node replica set. At 92 MiB / 1.9 s the load
  is negligible, but the job **SHOULD** still run in the 02:30 window.
- Sequence and prefix logic is registry-driven; a restore **MUST NOT** reset `Sequence` rows,
  or reissued numbers will collide with documents already in customers' hands.
- Post-implementation verification per `CLAUDE.md`: backend → `bun run test`; frontend →
  `bun run build`; full-flow → `bun run test:e2e`. On Windows, convert any new test using
  `.rejects`/`.resolves` to try/catch capture (known Bun deadlock).

---

## 9. Migration and ops notes

1. **Ship Layer 1 first.** It is three shell scripts and five crontab lines and it closes the
   actual hole. Do not let it wait for Layer 2.
2. **Set up the off-site destination before anything else is tuned.** A second copy on mars is
   an improvement; an off-site copy is the requirement.
3. **Run `cleanup-e2e-data.sh` against production** before measuring baselines, or the first
   figures are 73 orgs of noise.
4. **Rehearse the restore once, with a stopwatch**, and record the number in the runbook.
5. **`EmailLog` needs a one-off backfill** to strip bodies older than 90 days; at 24 rows today
   the migration is trivial, and it will not be later.
6. **Record the encryption key's location outside the cluster** — in the password manager, not
   in `lgr-deploy`.
7. **`config.backup.*` needs an `.env.example` entry** alongside `SENDGRID_API_KEY` /
   `FROM_EMAIL`, and `0` in `.env.test`.
8. **`BACKUP_SYS_ADMINS` ships empty and stays empty until someone is named.** Document that
   setting it is a deliberate act, that it takes effect on the next request with no re-login,
   and that removing a name revokes access immediately — which is exactly the property the
   PermissionSet route would not have given us.
9. **Do not exercise the manual restore against production first.** Rehearse Inspect → Merge →
   Replace on a scratch org restored from a real bundle, and only then let it near regal-pz.
10. **Create a dedicated Google account for backups** — not goran's personal Drive. Its
    credential can delete the off-site copy (FR-13.56), it must be revocable without
    collateral damage, and its 15 GB is a budget that Gmail must not be eating into.
11. **Register the Drive OAuth client alongside the existing ones.** `GOOGLE_CLIENT_ID` /
    `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` already exist in `config.integrations.google`
    but are unused (only the stub reads them) — confirm whether they are live credentials or
    placeholders before reusing them, and keep them distinct from the **social-login**
    `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` pair, which is a different app.
12. **Prefer holding the Drive refresh token in `lgr-secret`** over the Org document, so a
    leaked bundle does not carry write access to its own destination (FR-13.56).

---

## 10. Acceptance criteria

1. A nightly full backup exists on mars, is `zstd`-compressed from a `--oplog` archive, and is
   < 10 MB for today's data.
2. Hourly oplog deltas exist during trading hours, each < 1 MB, chained from a checkpoint.
3. A restore of the latest full into a throwaway container reproduces every collection's
   document count and is timed at under 5 minutes.
4. A point-in-time restore to an arbitrary hour of the previous day succeeds.
5. Three independent copies exist, at least one off-site and encrypted, and the decryption key
   is not on any cluster node.
6. `verify-backups.sh` fails loudly for: a missing night, a truncated artifact, a missing
   `latest` symlink, and a restore count mismatch — each proven by deliberately breaking it.
7. The FR-11 daily digest shows a Backups section, and a failed backup renders as a visible
   failure.
8. GFS retention holds 14/8/24/10 generations and survives a simulated run of five consecutive
   failed backups without losing the last good copy.
9. A per-org bundle for regal-pz downloads, verifies against its manifest checksums, and
   restores into a scratch database.
10. The daily email carries the manifest always and the delta always; the full is attached only
    under 14.6 MiB of binary, and skipping it is logged and visible.
11. Archiving a locked fiscal year removes the loose files, keeps every `DocFile` row listed,
    and an `nra_auditor` can still open and export an archived document through the UI.
12. `EmailLog` bodies older than 90 days are gone; no fiscal collection lost a single row.
13. `bun run test` and `bun run build` green; `config.backup.checkIntervalMs = 0` in
    `.env.test` and no test emits mail or writes a bundle.
14. With `config.backup.sysAdmins` unset, **every** route in §5.7 answers 403 — including for
    an org `admin` and for a user holding `admin.settings`. With the caller listed, the same
    routes work. Anonymous callers get 401 from the explicit handler check, not from `isSignIn`.
15. An org `admin` who is not on the allow-list cannot reach `admin/backup` by typing the URL,
    and cannot drive its endpoints directly with a valid JWT.
16. "Create backup now" returns a `BackgroundTask` id immediately, the UI polls it, and a
    `full` variant of regal-pz (~80 MB) completes and downloads without hitting a proxy timeout.
17. Inspect on a valid bundle writes **zero** documents (asserted by comparing counts and
    `updatedAt` maxima before and after) and renders a per-collection diff.
18. A bundle with one flipped byte is rejected on checksum before any write.
19. A bundle whose `manifest.orgId` differs from the target is refused; the same bundle with an
    explicit remap restores and leaves **no** document carrying the original `orgId`.
20. Merge restores only missing documents: no existing document is updated and none is deleted.
21. Replace on regal-pz (which has an active `FiscalDevice`) is **blocked**; Merge is offered.
22. A writing restore takes a verifying safety bundle first, and a deliberately failed restore
    rolls back from it leaving the org byte-identical to its pre-restore state.
23. Restoring an old bundle leaves every `Sequence.lastNumber` at the live value, and the report
    lists each sequence it clamped.
24. A `data`-only restore reports its dangling `DocFile` references by count and by number.
25. Every manual backup, download and restore appears in `AuditLog` with actor and mode, and a
    restore appears in the next daily digest.
26. Google Drive connects through OAuth consent with the `drive.file` scope and stores its
    tokens via the dedicated endpoint — **no API key exists anywhere in the config or code**,
    and the tokens survive a subsequent `PUT /org/:orgId` (i.e. they were not written through
    the stripped `settings.integrations` path).
27. The nightly job uploads to Drive with an **expired** access token in the store, refreshes
    transparently, and persists the new `expiresAt`.
28. A revoked Drive consent produces a distinct "re-consent required" failure that is visible
    in the digest, and the run is **not** recorded as having reached the destination.
29. A file larger than 5 MB uploads via the resumable endpoint; killing the connection
    mid-upload and re-running resumes rather than restarting, and a partial upload is never
    recorded as a success.
30. The weekly verification **downloads** the newest Drive artifact and checks its checksum —
    not merely lists it.
31. Drive retention keeps generations (not ages), and an upload that would exceed the account's
    `storageQuota` is refused **before** transfer with a clear message.
32. `googleDriveAdapter` no longer returns stub values, and the Dropbox/OneDrive stubs still
    compile against the extended interface.

---

## 11. Field-test script (production, `https://lgrai.app`, org `regal-pz`)

1. Run `backup-mongodb.sh` by hand; confirm the artifact is ~3.2 MiB and `zstd -t` passes.
2. `zstd -d` it and `mongorestore --archive --oplogReplay` into a throwaway `mongo:7`
   container; confirm 95,090 objects and `products` = 37,878 / regal-pz 23,246.
3. Truncate a copy of the archive to 500 bytes and confirm `verify-backups.sh` fails.
4. Delete the uploads `latest` symlink and confirm `backup-uploads.sh` fails loudly (the
   condition that has silently defeated roomler's uploads backup since installation).
5. Import a normal trading day, then confirm the next hourly delta is 30–200 KB and replays
   cleanly onto the previous night's full.
6. Confirm the next morning's digest shows the Backups section with a fresh timestamp.
7. Trigger `POST /org/:orgId/backup/run` for regal-pz; download the bundle, verify its manifest
   checksums, restore it into a scratch database and diff invoice counts against production.
8. Force the email path over the ceiling (attach a padded artifact) and confirm the send is
   **skipped with a logged reason**, not attempted and failed.
9. Lock fiscal year 2026 in a scratch environment, archive it, and confirm as `nra_auditor`
   that an archived `invoicem_*.pdf` still opens and exports from the UI.
10. Simulate five consecutive failed nights and confirm the last good full is still retained.
11. With the allow-list unset, sign in as the regal-pz `admin` and confirm `admin/backup` and
    each of its endpoints answer 403. Add that user to `config.backup.sysAdmins`, redeploy, and
    confirm the screen works **without** the user re-logging in (the point of not using a JWT
    permission).
12. Create a `full` backup of regal-pz from the UI, download it, and restore it in **Inspect**
    mode into a scratch org — confirm zero writes and a diff showing 23,246 products.
13. Flip one byte of that bundle and confirm the restore is refused on checksum.
14. Restore the regal-pz bundle into a *different* org and confirm it is refused; repeat with
    remap and confirm no document keeps the original `orgId`.
15. Attempt **Replace** on regal-pz and confirm it is blocked because a fiscal device is
    active; run **Merge** instead after deleting one test contact, and confirm exactly that one
    row returns and nothing else changed.
16. Confirm the invoice sequence did not move backwards, and that the restore is in the audit
    log and in the next morning's digest.
17. Connect Google Drive for regal-pz using a **dedicated** Google account (not goran's
    personal one), consent with `drive.file`, and confirm the tokens land in
    `settings.integrations.googleDrive` and survive an unrelated org-settings save.
18. Run the nightly job and confirm the artifact appears under `LGR Backups/regal-pz/daily/`
    with `appProperties` carrying the checksum and covered window.
19. Manually expire the stored access token (set `expiresAt` in the past) and confirm the next
    run refreshes and succeeds without operator action.
20. Revoke the app's access from the Google account's security page and confirm the next run
    fails with "re-consent required", surfaces in the digest, and does **not** count the
    destination as reached.
21. Download the newest Drive artifact via the verification path and confirm its checksum
    matches the manifest; then restore it into a throwaway container.
22. Upload a padded artifact large enough to exceed the account's remaining quota and confirm
    it is refused before transfer starts.

---

## Appendix A — reproducing the measurements

All figures in §§1–3 come from these, run 2026-09-03 against the live cluster. Reads are
read-only; the restore test ran in a throwaway container and never touched production.

```bash
# credentials
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
M="kubectl -n lgr exec mongodb-0 -c mongodb -- mongosh -u $U -p $P --authenticationDatabase admin --quiet"

# §2.1 per-org BSON footprint
$M --eval 'const d=db.getSiblingDB("lgr"), O=ObjectId("6a5ddbafdf2fc7b03bf596d2");
 d.getCollectionNames().forEach(n=>{const r=d[n].aggregate([{$match:{orgId:O}},
   {$group:{_id:null,n:{$sum:1},b:{$sum:{$bsonSize:"$$ROOT"}}}}]).toArray()[0];
   if(r) print(n, r.n, r.b)})'

# §2.2 daily creation histogram
$M --eval 'const d=db.getSiblingDB("lgr"), O=ObjectId("6a5ddbafdf2fc7b03bf596d2");
 d.invoices.aggregate([{$match:{orgId:O}},{$group:{_id:{$dateToString:{format:"%Y-%m-%d",date:"$createdAt"}},
   n:{$sum:1},b:{$sum:{$bsonSize:"$$ROOT"}}}},{$sort:{_id:1}}]).toArray().forEach(r=>print(JSON.stringify(r)))'
# NB: auditlogs are keyed on `timestamp`, not `createdAt` — a $dateToString over createdAt yields null.

# §2.1/§2.2 uploads
kubectl -n lgr exec deploy/lgr -- find /app/uploads/6a5ddbafdf2fc7b03bf596d2 -type f -printf '%TY-%Tm-%Td %s\n'

# §3.1 the archive, and the compressor benchmark
kubectl -n lgr exec mongodb-0 -c mongodb -- mongodump -u "$U" -p "$P" \
  --authenticationDatabase admin --db lgr --archive > lgr.archive
for c in "gzip -9" "zstd -19 -T4" "xz -9e -T4"; do $c -c < lgr.archive | wc -c; done

# §3.4 a real daily delta (op:'n' drops ~8,500 replica-set no-ops/day)
FROM=$(date -u -d '2026-09-02 00:00:00' +%s); TO=$(date -u -d '2026-09-02 23:59:59' +%s)
kubectl -n lgr exec mongodb-0 -c mongodb -- mongodump -u "$U" -p "$P" --authenticationDatabase admin \
  --db local --collection oplog.rs \
  --query "{\"ts\":{\"\$gte\":{\"\$timestamp\":{\"t\":$FROM,\"i\":0}},\"\$lte\":{\"\$timestamp\":{\"t\":$TO,\"i\":4294967295}}},\"op\":{\"\$ne\":\"n\"}}" \
  --archive | zstd -19 | wc -c

# §3.5 restore-verify, in a throwaway container
docker run -d --name rt -v "$PWD:/bk:ro" mongo:7 mongod --replSet rt --bind_ip_all
docker exec rt mongorestore --archive=/bk/lgr.archive
docker exec rt mongosh --quiet --eval 'print(JSON.stringify(db.getSiblingDB("lgr").stats()))'
docker rm -f rt

# §1.3 compressors available in the deployed app image
kubectl -n lgr exec deploy/lgr -- bun -e \
  'const z=require("zlib"); console.log(typeof z.brotliCompressSync, typeof z.zstdCompressSync)'
```

## Appendix B — sources for §4

- [ЗСч чл. 12 / срокове за съхранение на счетоводни документи](https://help.inv.bg/books/polezna-informaciya/page/kakvi-sa-srokovete-za-sxranenie-na-scetovodnite-dokumenti)
- [Съхраняване на счетоводната информация при спазване на приложимото законодателство](https://trudipravo.bg/izbrani-statii/sahranyavane-na-schetovodnata-informatziya-pri-spazvane-na-prilozhimoto-zakonodatelstvo/)
- [АРХИВ — Приложение 29 към Наредба Н-18 (т. 16, т. 19)](https://seliton.bg/page/316/arhiv-prilozhenie-29-kam-naredba-n-18.html)
- [Наредба № Н-18 от 13 декември 2006 г.](https://www.tita.bg/laws/44)
- [НАП — срокове за съхранение и унищожаване на документи](https://kik-info.com/stanovishta-na-nap/8d30b8f77ec2bae866ac9a83698223d7)

## Appendix C — sources for §5.8 (Google Drive)

- [Choose Google Drive API scopes](https://developers.google.com/drive/api/v3/about-auth) — `drive.file` vs full `drive`
- [Create access credentials](https://developers.google.com/workspace/guides/create-credentials) — API keys are for **public** data; OAuth client IDs for private user data
- [Using OAuth 2.0 for server-to-server applications](https://developers.google.com/identity/protocols/oauth2/service-account) — service-account delegation
- [Resolve Drive API errors](https://developers.google.com/workspace/drive/api/guides/handle-errors) — `storageQuotaExceeded`; service accounts have no quota and cannot own files
- [Manage uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads) — simple/multipart ≤ 5 MB, resumable above, `Content-Range: bytes */{total}` to resume
- [Service accounts do not have storage quota (report)](https://github.com/n8n-io/n8n/issues/26050) · [403 storageQuotaExceeded on an empty service-account Drive](https://discuss.google.dev/t/error-403-storagequotaexceeded-when-the-service-accounts-drive-is-completely-empty/194265)

