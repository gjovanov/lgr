/**
 * Global's half of the file lane (FR-20.66, FR-20.69, plan step P3-3, Part A.6.4): the files of an
 * org homed on a master, which global's mirror holds by content, per org.
 *
 * - **What is asked for** (`wantBlobs`): the contents the mirror's own rows of THAT org name, and only
 *   those: current documents, `File` rows (versions, deleted ones, imports) and archive units. A
 *   document in an archive travels inside its unit. ⚠ Computed per org and from nothing else, so an
 *   answer never says whether another org holds some content (FR-20.66).
 * - **What global already had** before a move is taken from its own copy, never asked for again: a
 *   file at a mirrored row's stored path, under the org, whose bytes hash to what the row says, is
 *   copied into the content store. Bounded per ask, so the first pass after a big move takes a few.
 * - **Chunks** (`acceptChunk`): from the org's home, registered, linked at Full, at global's offset
 *   (resumable; anything else is told where to resume), appended to `<sha256>.part`; complete, the
 *   file is hashed and only then named `<sha256>`. A file that is not what it claims is dropped and
 *   asked for again later, with a growing wait.
 * - **Read by content only** (`mirroredBlobFile`): global never opens a mirrored org's file where its
 *   row says. The row's path is the master's to choose.
 *
 * Files land at `<UPLOAD_DIR>/<orgId>/blobs/`, a directory no writer of the org's own uses.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat, truncate, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { config, nodeRole } from 'config'
import { ArchiveUnit, DocFile, File as FileModel, LIVE_MOVE_STATES, MirrorBlob, MirrorState, Org, OrgMove, ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { mongoose } from 'db/connection'
import { logger } from '../../logger/logger.js'
import { resolveStored } from '../files/stored-path.js'
import { SHA256_HEX, type BlobChunk } from './blob-frame.js'

/** Contents named in one `blob-want`; the master asks again for the rest. */
export const WANT_PER_ASK = 64
/** What one ask may hash of global's own copies, so it answers in seconds whatever the org's size. */
const ADOPT_PER_ASK = { files: 200, bytes: 512 * 1024 ** 2 }
/** A file the master could not read is asked for again after this. */
const MISSING_RETRY_MS = 6 * 3600_000
/** A transfer that ended in a bad file waits this long, doubled per failure, at most a day. */
const FAILED_RETRY_MS = 10 * 60_000
const RETRY_MAX_MS = 24 * 3600_000
/** States in which the home still sends: as for pages, a move drains what is left first. */
const SENDING: ReadonlySet<string> = new Set(['active', 'freezing', 'frozen'])
const ALARMS_KEPT = 20

export type BlobRefusal =
  | 'not_registered' | 'clone_alarm' | 'not_full' | 'not_home'
  /** The org mirrors its records only (FR-20.69). */
  | 'metadata_only'
  /** No row of the org names this content, or it waits before being asked for again. */
  | 'not_wanted'
  /** Not where global stands: the answer carries the offset to resume from. */
  | 'offset'
  /** Another size than the transfer began with: begun again from 0. */
  | 'size_changed'
  /** The whole file does not hash to its name: dropped, asked for again later. */
  | 'hash_mismatch'
  /** The org's files would pass `MIRROR_FILES_MAX_GB`. */
  | 'quota'

export interface WantItem {
  sha256: string
  /** Where to resume: global's bytes so far. */
  offset: number
  /** The size the mirror's rows say, when they say it. */
  size?: number
}

export type WantAnswer =
  | { t: 'blob-want'; orgId: string; files: 'all' | 'metadata'; want: WantItem[]; more: boolean; adopted?: number; quota?: true }
  | { t: 'blob-refused'; orgId: string; reason: BlobRefusal; detail?: string }

export type ChunkAnswer =
  | { t: 'blob-ack'; orgId: string; sha256: string; offset: number; state: 'partial' | 'ok' }
  | { t: 'blob-refused'; orgId: string; sha256: string; reason: BlobRefusal; offset?: number; detail?: string }

const root = () => resolve(config.upload.dir)

/** `<UPLOAD_DIR>/<orgId>/blobs`. */
export function blobDir(orgId: string): string {
  if (!/^[0-9a-f]{24}$/.test(String(orgId))) throw new Error('not an org id')
  return join(root(), String(orgId), 'blobs')
}

/** Where `sha256` of `orgId` lives once whole. ⚠ The hash is checked: it is part of a path. */
export function blobPath(orgId: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new Error('not a SHA-256')
  return join(blobDir(orgId), sha256)
}

const partPath = (orgId: string, sha256: string) => `${blobPath(orgId, sha256)}.part`
const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? null

const locks = new Map<string, Promise<unknown>>()

/** One writer per file in this process; across processes the conditional updates decide. */
async function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve()
  const run = before.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  try {
    return await run
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/** Why `nodeId` may not send `orgId`'s files, or null: the rules a page is held to (FR-20.66). */
async function senderRefusal(nodeId: string, orgId: string): Promise<{ reason: BlobRefusal; detail: string } | null> {
  const node: any = await ServerNode.findOne({ _id: nodeId }, { status: 1, orgIds: 1, cloneAlarm: 1, linkLevel: 1 }).lean()
  if (!node || node.status !== 'active' || !(node.orgIds ?? []).some((id: unknown) => String(id) === orgId)) {
    return { reason: 'not_registered', detail: 'the node is not registered for this org' }
  }
  if (node.cloneAlarm) return { reason: 'clone_alarm', detail: 'two live uplinks share this node id' }
  if (node.linkLevel !== 'full') return { reason: 'not_full', detail: 'the mirror, files and all, is Full only' }
  const home = await homeOf(orgId)
  if (home.home !== nodeId || !SENDING.has(home.state)) return { reason: 'not_home', detail: `the org's home is not this node (${home.state})` }
  return null
}

/** Whether the org's files travel to the mirror: unless its admin chose metadata only. */
export async function filesMirrored(orgId: string): Promise<boolean> {
  const org: any = await Org.findById(orgId, { 'settings.node.mirrorFiles': 1 }).lean()
  if (org?.settings?.node?.mirrorFiles !== false) return true
  // FR-20.80: a move back to lgrai.app takes every file, whatever the org chose.
  return movingBack(orgId)
}

/** Whether a move of the org back to lgrai.app is under way (FR-20.80, P3-6c). */
export async function movingBack(orgId: string): Promise<boolean> {
  return !!(await OrgMove.exists({ orgId, kind: 'to_global', state: { $in: [...LIVE_MOVE_STATES] } }))
}

interface Referenced {
  size?: number
  /** The stored paths the mirror's rows give it: where global's own copy from before a move may be. */
  paths: string[]
}

/**
 * The contents the mirror's rows of `orgId` name, by hash. A document in an archive is left out: its
 * bytes are in the unit, which is named in its own right, and the master no longer has them loose.
 */
export async function referencedBlobs(orgId: string): Promise<Map<string, Referenced>> {
  const [docs, files, units] = await Promise.all([
    DocFile.find({ orgId }, { currentChecksum: 1, size: 1, currentPath: 1, archived: 1 }).lean(),
    FileModel.find({ orgId, sha256: { $type: 'string' }, storageProvider: { $in: ['local', null] } }, { sha256: 1, size: 1, storagePath: 1 }).lean(),
    ArchiveUnit.find({ orgId, sha256: { $type: 'string' } }, { sha256: 1, bytes: 1, path: 1 }).lean(),
  ])
  const out = new Map<string, Referenced>()
  const add = (sha: unknown, size: unknown, path: unknown) => {
    if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) return
    const e = out.get(sha) ?? { paths: [] }
    if (e.size === undefined && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) e.size = size
    if (typeof path === 'string' && path) e.paths.push(path)
    out.set(sha, e)
  }
  const archived = new Set((docs as any[]).filter(d => d.archived).map(d => d.currentChecksum))
  for (const d of docs as any[]) if (!d.archived) add(d.currentChecksum, d.size, d.currentPath)
  // The File row of a document now in an archive names bytes the master no longer has loose.
  for (const f of files as any[]) if (!archived.has(f.sha256) || out.has(f.sha256)) add(f.sha256, f.size, f.storagePath)
  for (const u of units as any[]) add(u.sha256, u.bytes, u.path)
  return out
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const part of Bun.file(path).stream()) h.update(part)
  return h.digest('hex')
}

/** Copy `src` to `dest` through a temporary name: a reader never sees half of it. */
async function placeCopy(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.adopt-${process.pid}`
  // A reflink where the filesystem has them, a copy otherwise. Never a hard link: the original stays
  // global's own file, which its writers may rewrite in place once the org is home here again.
  await copyFile(src, tmp, fsConstants.COPYFILE_FICLONE)
  await rename(tmp, dest)
}

/**
 * Take `sha256` from global's own copy of it, when the mirror's rows say where that was before the
 * move and the bytes there are still exactly those: `adopted` (in the content store now), `none`
 * (no such copy here), or `later` (there is one, and this ask's hashing is spent).
 *
 * ⚠ The path is the row's, so the master's to choose; only the org's own tree is ever read
 * (`resolveStored` with the org), and only bytes that hash to the row's content are taken, so what is
 * served afterwards is exactly the content the row names, never some other file.
 */
async function adopt(orgId: string, sha256: string, paths: readonly string[], budget: { files: number; bytes: number }): Promise<'adopted' | 'none' | 'later'> {
  const blobs = blobDir(orgId)
  for (const p of new Set(paths)) {
    let src: string
    try {
      src = resolveStored(p, orgId)
    } catch {
      continue // not a path under the org: the apply refuses those, and nothing is read from one
    }
    if (src === blobs || src.startsWith(blobs + sep)) continue
    const s = await stat(src).catch(() => null)
    if (!s?.isFile()) continue
    // A fresh budget always takes one file, whatever its size.
    if (budget.files <= 0 || budget.bytes <= 0) return 'later'
    budget.files--
    budget.bytes -= s.size
    if ((await hashFile(src)) !== sha256) continue
    await mkdir(blobs, { recursive: true })
    await placeCopy(src, blobPath(orgId, sha256))
    await MirrorBlob.updateOne(
      { orgId, sha256 },
      { $set: { state: 'ok', size: s.size, offset: s.size, source: 'local', completedAt: new Date() }, $unset: { retryAt: '', lastError: '', nodeId: '' }, $setOnInsert: { failures: 0 } },
      { upsert: true },
    )
    await unlink(partPath(orgId, sha256)).catch(() => {})
    return 'adopted'
  }
  return 'none'
}

/** The bytes the org's mirrored files take, held and arriving. */
async function bytesHeld(orgId: string): Promise<number> {
  const [r] = await MirrorBlob.aggregate([
    { $match: { orgId: new mongoose.Types.ObjectId(orgId), state: { $in: ['ok', 'partial'] } } },
    { $group: { _id: null, bytes: { $sum: { $ifNull: ['$size', 0] } } } },
  ])
  return r?.bytes ?? 0
}

/** An alarm on the org's mirror, once an hour per kind. */
async function alarm(orgId: string, kind: string, detail: string, now: Date): Promise<void> {
  const recent = await MirrorState.exists({ orgId, alarms: { $elemMatch: { kind, at: { $gt: new Date(now.getTime() - 3600_000) } } } })
  if (recent) return
  // Not upserted: a mirror_state row is the apply's to create, with the chain it starts.
  await MirrorState.updateOne({ orgId }, { $push: { alarms: { $each: [{ kind, at: now, detail }], $slice: -ALARMS_KEPT } } })
  logger.warn({ orgId, kind, detail }, 'Mirror: an alarm on an org\'s files')
}

/**
 * The org's next files for `nodeId` to send: the mirror's rows name them and global holds none of
 * their bytes, or part. Global's own copies from before a move are taken first.
 */
export async function wantBlobs(nodeId: string, orgId: string, now = new Date()): Promise<WantAnswer> {
  const refused = await senderRefusal(nodeId, orgId)
  if (refused) return { t: 'blob-refused', orgId, ...refused }
  if (!(await filesMirrored(orgId))) return { t: 'blob-want', orgId, files: 'metadata', want: [], more: false }

  const referenced = await referencedBlobs(orgId)
  const held = new Map((await MirrorBlob.find({ orgId }).lean()).map((r: any) => [r.sha256, r]))
  const budget = { ...ADOPT_PER_ASK }
  const want: WantItem[] = []
  const created: Array<{ sha256: string; size?: number }> = []
  let adopted = 0
  let more = false
  let room = config.mirror.filesMaxBytes - (await bytesHeld(orgId))
  let quota = false
  for (const sha256 of [...referenced.keys()].sort()) {
    const r: any = held.get(sha256)
    if (r?.state === 'ok') continue
    if (r?.retryAt && new Date(r.retryAt) > now) continue
    const ref = referenced.get(sha256)!
    if (r?.state !== 'partial') {
      const taken = await adopt(orgId, sha256, ref.paths, budget)
      if (taken === 'adopted') {
        adopted++
        continue
      }
      // Global still holds it from before the move: the next ask hashes it, rather than the shop's
      // uplink carrying bytes global has.
      if (taken === 'later') {
        more = true
        continue
      }
    }
    let offset = 0
    if (r?.state === 'partial') {
      // Where the bytes on disk really end: a pod that crashed mid-write, or another pod's volume.
      const actual = (await sizeOf(partPath(orgId, sha256))) ?? 0
      offset = Math.min(r.offset ?? 0, actual)
    } else {
      // A new transfer: is there room for it? Sizes the rows do not say count once they are known.
      const size = ref.size ?? 0
      if (size > room) {
        quota = true
        continue
      }
      room -= size
      if (!r) created.push({ sha256, size: ref.size })
    }
    if (want.length >= WANT_PER_ASK) {
      more = true
      break
    }
    want.push({ sha256, offset, ...(ref.size !== undefined ? { size: ref.size } : {}) })
  }
  if (created.length) {
    await MirrorBlob.bulkWrite(created.filter(c => want.some(w => w.sha256 === c.sha256)).map(c => ({
      updateOne: {
        filter: { orgId, sha256: c.sha256 },
        update: { $setOnInsert: { state: 'wanted', offset: 0, failures: 0, ...(c.size !== undefined ? { size: c.size } : {}) } },
        upsert: true,
      },
    })) as any)
  }
  if (quota) await alarm(orgId, 'files_quota', `the org's files would pass ${Math.round(config.mirror.filesMaxBytes / 1024 ** 3)} GB on the mirror; files past it are not taken`, now)
  return { t: 'blob-want', orgId, files: 'all', want, more, ...(adopted ? { adopted } : {}), ...(quota ? { quota: true as const } : {}) }
}

const backoff = (failures: number) => Math.min(RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** Math.max(0, failures - 1))

/** One chunk from `nodeId`: written where global stands, and the file named by its hash once whole. */
export async function acceptChunk(nodeId: string, chunk: BlobChunk, now = new Date()): Promise<ChunkAnswer> {
  const { orgId, sha256 } = chunk
  const base = { orgId, sha256 }
  return serially(`${orgId}:${sha256}`, async (): Promise<ChunkAnswer> => {
    const refused = await senderRefusal(nodeId, orgId)
    if (refused) return { t: 'blob-refused', ...base, ...refused }
    if (!(await filesMirrored(orgId))) return { t: 'blob-refused', ...base, reason: 'metadata_only' }
    const r: any = await MirrorBlob.findOne({ orgId, sha256 }).lean()
    // Only what global asked for, which only its rows of this org name.
    if (!r || (r.retryAt && new Date(r.retryAt) > now)) return { t: 'blob-refused', ...base, reason: 'not_wanted' }
    if (r.state === 'ok') return { t: 'blob-ack', ...base, offset: r.size ?? r.offset, state: 'ok' }

    const part = partPath(orgId, sha256)
    const onDisk = (await sizeOf(part)) ?? 0
    const at = r.state === 'partial' ? Math.min(r.offset ?? 0, onDisk) : 0
    if (chunk.offset !== at) return { t: 'blob-refused', ...base, reason: 'offset', offset: at }
    if (at > 0 && r.size !== chunk.size) {
      await reset(orgId, sha256)
      return { t: 'blob-refused', ...base, reason: 'size_changed', offset: 0 }
    }
    if (at === 0 && chunk.size > config.mirror.filesMaxBytes - (await bytesHeld(orgId)) + (r.state === 'partial' ? r.size ?? 0 : 0)) {
      await alarm(orgId, 'files_quota', `a file of ${chunk.size} bytes would pass the org's ${Math.round(config.mirror.filesMaxBytes / 1024 ** 3)} GB on the mirror`, now)
      return { t: 'blob-refused', ...base, reason: 'quota' }
    }

    await mkdir(blobDir(orgId), { recursive: true })
    // What a crash left past where global stands is not trusted: cut, then written again.
    if (onDisk > at) await truncate(part, at)
    const fh = await open(part, at === 0 ? 'w' : 'r+')
    try {
      if (chunk.bytes.length) await fh.write(chunk.bytes, 0, chunk.bytes.length, at)
    } finally {
      await fh.close()
    }
    const end = at + chunk.bytes.length
    if (end < chunk.size) {
      const moved = await MirrorBlob.updateOne(
        { orgId, sha256, state: r.state, offset: r.offset ?? 0 },
        { $set: { state: 'partial', offset: end, size: chunk.size, nodeId } },
      )
      // Another writer moved it first: say where it stands now.
      if (!moved.matchedCount) return { t: 'blob-refused', ...base, reason: 'offset', offset: (await MirrorBlob.findOne({ orgId, sha256 }).lean() as any)?.offset ?? 0 }
      return { t: 'blob-ack', ...base, offset: end, state: 'partial' }
    }

    // Whole: named by its hash only once it hashes to it.
    if ((await hashFile(part)) !== sha256) {
      await unlink(part).catch(() => {})
      const failures = (r.failures ?? 0) + 1
      await MirrorBlob.updateOne(
        { orgId, sha256 },
        { $set: { state: 'wanted', offset: 0, failures, retryAt: new Date(now.getTime() + backoff(failures)), lastError: { reason: 'hash_mismatch', at: now, detail: `${chunk.size} bytes from ${nodeId} hash to something else` } }, $unset: { size: '' } },
      )
      logger.warn({ orgId, sha256, nodeId, failures }, 'Mirror: a file did not hash to its name; asked for again later')
      return { t: 'blob-refused', ...base, reason: 'hash_mismatch', offset: 0 }
    }
    const dest = blobPath(orgId, sha256)
    if ((await sizeOf(dest)) === chunk.size) await unlink(part).catch(() => {})
    else await rename(part, dest)
    await MirrorBlob.updateOne(
      { orgId, sha256 },
      { $set: { state: 'ok', offset: chunk.size, size: chunk.size, nodeId, source: 'master', completedAt: now }, $unset: { retryAt: '', lastError: '' } },
    )
    return { t: 'blob-ack', ...base, offset: chunk.size, state: 'ok' }
  })
}

async function reset(orgId: string, sha256: string): Promise<void> {
  await unlink(partPath(orgId, sha256)).catch(() => {})
  await MirrorBlob.updateOne({ orgId, sha256 }, { $set: { state: 'wanted', offset: 0 }, $unset: { size: '' } })
}

/**
 * The master could not send a file global asked for: it holds no readable bytes for it, or not the
 * ones its row names. Asked for again later, and counted, since on the master that is lost data.
 */
export async function blobUnavailable(nodeId: string, orgId: string, sha256: string, reason: string, now = new Date()): Promise<void> {
  if (!SHA256_HEX.test(sha256) || !/^[0-9a-f]{24}$/.test(orgId)) return
  if (await senderRefusal(nodeId, orgId)) return
  await serially(`${orgId}:${sha256}`, async () => {
    const r: any = await MirrorBlob.findOne({ orgId, sha256 }).lean()
    if (!r || r.state === 'ok') return
    // Global holds more than the master's file has: begin again, at once.
    if (reason === 'offset_beyond') return reset(orgId, sha256)
    const missing = reason === 'missing'
    const failures = (r.failures ?? 0) + 1
    await MirrorBlob.updateOne(
      { orgId, sha256 },
      {
        $set: {
          failures,
          retryAt: new Date(now.getTime() + (missing ? MISSING_RETRY_MS : backoff(failures))),
          lastError: { reason: missing ? 'missing_on_master' : String(reason).slice(0, 40), at: now },
        },
      },
    )
  })
}

/**
 * Where each file of the org must be once global is its home again (FR-20.80, P3-6c): the stored
 * path of every row global's mirror holds, with the content its row names. A current document wins
 * over an archive unit, which wins over a `File` row, when two name one path with different bytes;
 * those are counted, never guessed.
 */
async function placements(orgId: string): Promise<{ want: Map<string, string>; conflicts: number }> {
  const [docs, files, units] = await Promise.all([
    DocFile.find({ orgId }, { currentChecksum: 1, currentPath: 1, archived: 1 }).lean(),
    FileModel.find({ orgId, sha256: { $type: 'string' }, storageProvider: { $in: ['local', null] } }, { sha256: 1, storagePath: 1 }).lean(),
    ArchiveUnit.find({ orgId, sha256: { $type: 'string' } }, { sha256: 1, path: 1 }).lean(),
  ])
  const want = new Map<string, string>()
  let conflicts = 0
  const claim = (rel: unknown, sha: unknown) => {
    if (typeof rel !== 'string' || typeof sha !== 'string' || !SHA256_HEX.test(sha)) return
    let abs: string
    try {
      abs = resolveStored(rel, orgId)
    } catch {
      return
    }
    const had = want.get(abs)
    if (had === undefined) want.set(abs, sha)
    else if (had !== sha) conflicts++
  }
  const archived = new Set((docs as any[]).filter(d => d.archived).map(d => d.currentChecksum))
  for (const d of docs as any[]) if (!d.archived) claim(d.currentPath, d.currentChecksum)
  for (const u of units as any[]) claim(u.path, u.sha256)
  // The File row of a document now in an archive names bytes that live in its unit.
  for (const f of files as any[]) if (!archived.has(f.sha256)) claim(f.storagePath, f.sha256)
  return { want, conflicts }
}

/**
 * Put every file of the org where its row says, from the content store (FR-20.80, P3-6c): global
 * reads an org homed here by path. A file already there with the right bytes stays; one with other
 * bytes is replaced. Idempotent, so a tick that dies half-way is simply run again.
 */
export async function placeFilesBack(orgId: string): Promise<{ placed: number; present: number; missing: number; conflicts: number }> {
  const { want, conflicts } = await placements(orgId)
  let placed = 0
  let present = 0
  let missing = 0
  for (const [abs, sha] of want) {
    const s = await stat(abs).catch(() => null)
    if (s?.isFile() && (await hashFile(abs)) === sha) {
      present++
      continue
    }
    const blob = await mirroredBlobFile(orgId, sha)
    if (!blob) {
      missing++
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    await placeCopy(blob, abs)
    placed++
  }
  return { placed, present, missing, conflicts }
}

/** Once the org is home here again, its content store goes: every file is where its row says. */
export async function dropMirrorBlobs(orgId: string): Promise<number> {
  const r = await MirrorBlob.deleteMany({ orgId })
  await rm(blobDir(orgId), { recursive: true, force: true }).catch(() => {})
  return r.deletedCount ?? 0
}

/** True where a mirrored org's files are read by content: on global, for an org homed elsewhere. */
export async function readsByContent(orgId: string): Promise<boolean> {
  if (nodeRole() !== 'global') return false
  return (await homeOf(orgId)).home !== 'global'
}

/**
 * The file holding `sha256` of `orgId` on the mirror, or null while it has not arrived. A file the
 * row says is held but the disk lost is asked for again.
 *
 * `paths`, the stored paths of the row being read: global's own copy from before a move is taken
 * there and then (one file, checked by its hash), so it opens even before the master's file pass
 * reaches it, and for an org that mirrors its records only.
 */
export async function mirroredBlobFile(orgId: string, sha256: unknown, paths: readonly string[] = []): Promise<string | null> {
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
  const r: any = await MirrorBlob.findOne({ orgId, sha256, state: 'ok' }, { size: 1 }).lean()
  if (!r) {
    if (!paths.length) return null
    const taken = await serially(`${orgId}:${sha256}`, () => adopt(orgId, sha256, paths, { files: 1, bytes: 1 }))
    return taken === 'adopted' ? blobPath(orgId, sha256) : null
  }
  const path = blobPath(orgId, sha256)
  const size = await sizeOf(path)
  if (size === null || (typeof r.size === 'number' && size !== r.size)) {
    logger.warn({ orgId, sha256, size, expected: r.size }, 'Mirror: a file held by content is not on disk; asked for again')
    await MirrorBlob.updateOne({ orgId, sha256 }, { $set: { state: 'wanted', offset: 0 }, $unset: { retryAt: '' } })
    return null
  }
  return path
}

/** Why a mirrored org's file does not open on global, in words a person can act on. */
export class MirrorFileMissing extends Error {
  readonly statusCode = 404
  constructor(readonly code: 'file_not_mirrored' | 'files_not_mirrored') {
    super(code === 'files_not_mirrored'
      ? 'This organisation mirrors its records only; the file is on its server.'
      : 'This file has not reached lgrai.app from the organisation\'s server yet.')
  }
}

/** The error a read of `orgId`'s missing file answers: the org chose metadata only, or the file is on its way. */
export async function mirrorFileMissing(orgId: string): Promise<MirrorFileMissing> {
  return new MirrorFileMissing((await filesMirrored(orgId)) ? 'file_not_mirrored' : 'files_not_mirrored')
}

export interface MirrorFilesStatus {
  /** The org's choice: files too, or metadata only. */
  files: boolean
  /** Contents the mirror's rows name. */
  referenced: number
  held: number
  bytesHeld: number
  arriving: number
  /** Asked for, or about to be. */
  waiting: number
  /** The master said it holds no readable bytes for them. */
  missingOnMaster: number
  /** Waiting after a transfer that ended in a bad file. */
  failing: number
  /** Every content the rows name is held: what a move back waits for (FR-20.80). */
  complete: boolean
}

export async function mirrorFilesStatus(orgId: string, now = new Date()): Promise<MirrorFilesStatus> {
  const [files, referenced, rows] = await Promise.all([
    filesMirrored(orgId),
    referencedBlobs(orgId),
    MirrorBlob.find({ orgId }, { sha256: 1, state: 1, size: 1, retryAt: 1, lastError: 1 }).lean(),
  ])
  const bySha = new Map((rows as any[]).map(r => [r.sha256, r]))
  const st: MirrorFilesStatus = { files, referenced: referenced.size, held: 0, bytesHeld: 0, arriving: 0, waiting: 0, missingOnMaster: 0, failing: 0, complete: false }
  for (const sha of referenced.keys()) {
    const r: any = bySha.get(sha)
    if (r?.state === 'ok') {
      st.held++
      st.bytesHeld += r.size ?? 0
    } else if (r?.state === 'partial') st.arriving++
    else if (r?.retryAt && new Date(r.retryAt) > now) {
      if (r.lastError?.reason === 'missing_on_master') st.missingOnMaster++
      else st.failing++
    } else st.waiting++
  }
  st.complete = st.held === st.referenced
  return st
}
