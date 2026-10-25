/**
 * The copy a move sends a master (FR-20.79 step 3, plan step P3-6a): the org's data as the mirror
 * defines it, every replicated and split collection with `Org` itself, type-exact, then the org's
 * people and their local credentials.
 *
 * - **Canonical EJSON per document**, read with `promoteValues: false`: an integral Double stays a
 *   Double, a Long a Long, an ObjectId inside a Mixed field an ObjectId. ⚠ The FR-13 backup bundle
 *   writes `JSON.stringify` and lets the restore re-cast through the schemas, which a Mixed field
 *   defeats, and the master's first pages would then carry the drifted types into the mirror.
 * - **What never travels** (FR-20.79): password copies and OAuth links (`User.password`,
 *   `oauthProviders`), `Org.settings.integrations`, FR-20's own state (node-local collections are
 *   not in the set), and the node-owned fields of split documents, which the master observes itself.
 * - **The people** (`$people`): the `Identity` of every member, as who the person is
 *   (`PEOPLE_FIELDS`, FR-20.44) and nothing else. A master signs people in against its own copy of
 *   them, and its identity feed only ever updates people it already holds, so without them nobody
 *   could sign in there. Never their password, OAuth links, or the other orgs they belong to.
 * - **The local credentials** (`$credentials`, FR-20.40): the verifiers set on lgrai.app, each
 *   sealed to the master's seal key, as the credential feed delivers them. ⚠ The feed alone would
 *   not do: it skips people a master does not hold yet and moves its cursor past them, so the
 *   credentials of a moved org's people would only arrive with the next daily full pass.
 * - **Streamed**, through zstd, so an org of any size is never whole in memory: a header line, then
 *   per collection a `{"$coll"}` line and its documents in `_id` order, then the people and the
 *   credentials, then a trailer with each section's count and sha256 over its lines.
 * - **Digests are a function of the database**, not of the file: `collectionDigests` reads the same
 *   projection back, so the master computes them over what it imported and global over what it
 *   froze, and the flip waits for both to be equal (FR-20.79 step 4).
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { REPLICATION_META } from 'db/replication/meta.generated'
import type { MetaEntry } from 'db/replication/generate'
import { splitLines } from '../backup/backup-files.service.js'
import { isPlain } from '../replication/project.js'

type Db = mongo.Db
type ObjectId = mongo.ObjectId
type Doc = Record<string, unknown>

export const MOVE_FORMAT = 'lgr-move/1'
const EJSON = mongoose.mongo.BSON.EJSON
const BATCH = 500

export type Digests = Record<string, { count: number; sha256: string }>
export interface SectionDigest {
  count: number
  sha256: string
}

/** Who a person is, as a master holds them (FR-20.44). Everything else of an `Identity` stays home. */
export const PEOPLE_FIELDS = ['_id', 'email', 'emailVerified', 'emailVerifiedAt', 'tokenVersion', 'firstName', 'middleName', 'lastName', 'avatar', 'isActive', 'createdAt', 'updatedAt'] as const
const PEOPLE_PROJECTION = Object.fromEntries(PEOPLE_FIELDS.map(f => [f, 1]))
const PEOPLE_KEYS: ReadonlySet<string> = new Set(PEOPLE_FIELDS)

/** The collections a move copies: the mirror's, replicated and split, each with an org. */
export function moveCollections(): MetaEntry[] {
  return Object.values(REPLICATION_META)
    .filter(e => (e.class === 'R' || e.class === 'S') && e.orgPath)
    .sort((a, b) => a.collection.localeCompare(b.collection))
}

/** Never on a master (FR-20.79): password copies, OAuth links, the cloud integrations' tokens. */
const NEVER: Readonly<Record<string, readonly string[]>> = {
  users: ['password', 'oauthProviders'],
  orgs: ['settings.integrations'],
}

/** `doc` without `paths` (dotted), copied only along them: the original is left as it was. */
function without(doc: Doc, paths: readonly string[]): Doc {
  const out: Doc = { ...doc }
  for (const p of paths) {
    const segs = p.split('.')
    let cur: Doc | null = out
    for (let i = 0; i < segs.length - 1 && cur; i++) {
      const v = cur[segs[i]]
      if (!isPlain(v)) {
        cur = null
        break
      }
      cur[segs[i]] = { ...v }
      cur = cur[segs[i]] as Doc
    }
    if (cur) delete cur[segs[segs.length - 1]]
  }
  return out
}

/** A document as a move carries it. */
export function moveProjection(entry: MetaEntry, doc: Doc): Doc {
  const drop = [...(NEVER[entry.collection] ?? []), ...(entry.class === 'S' ? entry.node ?? [] : [])]
  return drop.length ? without(doc, drop) : doc
}

const filterFor = (e: MetaEntry, orgId: ObjectId) => (e.orgPath === '_id' ? { _id: orgId } : { orgId })

/** One document as its line in the bundle and in the digest. */
const lineOf = (e: MetaEntry, doc: Doc) => `${EJSON.stringify(moveProjection(e, doc) as any, { relaxed: false })}\n`
const personLine = (doc: Doc) => `${EJSON.stringify(doc as any, { relaxed: false })}\n`

/** Per collection, the count and sha256 of the org's documents as a move carries them. */
export async function collectionDigests(db: Db, orgId: ObjectId): Promise<Digests> {
  const out: Digests = {}
  for (const e of moveCollections()) {
    const h = createHash('sha256')
    let count = 0
    for await (const doc of db.collection(e.collection).find(filterFor(e, orgId) as any, { sort: { _id: 1 }, promoteValues: false })) {
      h.update(lineOf(e, doc as Doc))
      count++
    }
    if (count) out[e.collection] = { count, sha256: h.digest('hex') }
  }
  return out
}

/** The collections whose count or sha256 differ, by name. */
export function digestMismatch(a: Digests, b: Digests): string[] {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return names.filter(n => a[n]?.sha256 !== b[n]?.sha256 || a[n]?.count !== b[n]?.count)
}

export interface MoveBundle {
  file: string
  sha256: string
  bytes: number
  documents: number
  digests: Digests
  people: number
  credentials: number
}

const sectionOf = (h: ReturnType<typeof createHash>, count: number): SectionDigest => ({ count, sha256: h.digest('hex') })

/**
 * Write the org's copy to `path`. The org is frozen: nothing changes under the cursor. `credentials`
 * are the feed's items for the org's people, already sealed to the master's key.
 */
export async function writeMoveBundle(db: Db, orgId: ObjectId, path: string, opts: { credentials?: readonly unknown[] } = {}): Promise<MoveBundle> {
  const digests: Digests = {}
  let documents = 0
  let people = 0
  let credentials = 0
  async function* lines(): AsyncGenerator<Buffer> {
    yield Buffer.from(`${JSON.stringify({ format: MOVE_FORMAT, orgId: String(orgId) })}\n`)
    for (const e of moveCollections()) {
      const h = createHash('sha256')
      let count = 0
      for await (const doc of db.collection(e.collection).find(filterFor(e, orgId) as any, { sort: { _id: 1 }, promoteValues: false })) {
        if (!count) yield Buffer.from(`${JSON.stringify({ $coll: e.collection })}\n`)
        const line = lineOf(e, doc as Doc)
        h.update(line)
        count++
        yield Buffer.from(line)
      }
      if (count) {
        digests[e.collection] = { count, sha256: h.digest('hex') }
        documents += count
      }
    }
    // The people the org's members are, and no one else.
    const ids = await db.collection('users').distinct('identityId', { orgId, identityId: { $ne: null } } as any)
    const ph = createHash('sha256')
    if (ids.length) {
      yield Buffer.from('{"$people":true}\n')
      for await (const doc of db.collection('identities').find({ _id: { $in: ids } } as any, { sort: { _id: 1 }, promoteValues: false, projection: PEOPLE_PROJECTION })) {
        const line = personLine(doc as Doc)
        ph.update(line)
        people++
        yield Buffer.from(line)
      }
    }
    const ch = createHash('sha256')
    if (opts.credentials?.length) {
      yield Buffer.from('{"$credentials":true}\n')
      for (const c of opts.credentials) {
        const line = `${JSON.stringify(c)}\n`
        ch.update(line)
        credentials++
        yield Buffer.from(line)
      }
    }
    yield Buffer.from(`${JSON.stringify({ $end: true, documents, digests, people: sectionOf(ph, people), credentials: sectionOf(ch, credentials) })}\n`)
  }
  await mkdir(dirname(path), { recursive: true })
  await pipeline(Readable.from(lines()), zlib.createZstdCompress(), createWriteStream(path))
  return { file: basename(path), sha256: await fileSha256(path), bytes: (await stat(path)).size, documents, digests, people, credentials }
}

export async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

export class MoveBundleError extends Error {
  readonly code = 'move_bundle_invalid'
}

export type BundleItem =
  | { kind: 'doc'; coll: string; doc: Doc }
  | { kind: 'person'; doc: Doc }
  | { kind: 'credential'; item: unknown }

export interface BundleTrailer {
  digests: Digests
  people: SectionDigest
  credentials: SectionDigest
}

const sameSection = (a: SectionDigest, b: any) => a.count === (b?.count ?? 0) && (a.count === 0 || a.sha256 === b?.sha256)

/**
 * Every item of a bundle, in order, each section's lines checked against the trailer as they go
 * past. Throws on a format it does not know, a collection that does not move, a person carrying
 * more than who they are, or a digest that does not match; returns the trailer's digests.
 */
export async function* readMoveBundle(path: string): AsyncGenerator<BundleItem, BundleTrailer> {
  const known = new Set(moveCollections().map(e => e.collection))
  const seen: Record<string, { h: ReturnType<typeof createHash>; count: number }> = {}
  const people = { h: createHash('sha256'), count: 0 }
  const credentials = { h: createHash('sha256'), count: 0 }
  let header = false
  let section: 'docs' | 'people' | 'credentials' = 'docs'
  let coll: string | null = null
  for await (const line of splitLines(createReadStream(path).pipe(zlib.createZstdDecompress()))) {
    if (!line) continue
    if (!header) {
      const h = JSON.parse(line)
      if (h?.format !== MOVE_FORMAT) throw new MoveBundleError(`not a move bundle (${String(h?.format)})`)
      header = true
      continue
    }
    if (line.startsWith('{"$coll":')) {
      if (section !== 'docs') throw new MoveBundleError('a collection after the people')
      coll = JSON.parse(line).$coll
      if (!coll || !known.has(coll)) throw new MoveBundleError(`${String(coll)} is not a collection a move copies`)
      if (seen[coll]) throw new MoveBundleError(`${coll} appears twice`)
      seen[coll] = { h: createHash('sha256'), count: 0 }
      continue
    }
    if (line === '{"$people":true}') {
      if (section !== 'docs') throw new MoveBundleError('the people appear twice, or after the credentials')
      section = 'people'
      continue
    }
    if (line === '{"$credentials":true}') {
      if (section === 'credentials') throw new MoveBundleError('the credentials appear twice')
      section = 'credentials'
      continue
    }
    if (line.startsWith('{"$end":')) {
      const trailer = JSON.parse(line)
      const got: Digests = Object.fromEntries(Object.entries(seen).map(([c, s]) => [c, { count: s.count, sha256: s.h.digest('hex') }]))
      const bad = digestMismatch(got, trailer.digests ?? {})
      const ours = { people: sectionOf(people.h, people.count), credentials: sectionOf(credentials.h, credentials.count) }
      if (!sameSection(ours.people, trailer.people)) bad.push('people')
      if (!sameSection(ours.credentials, trailer.credentials)) bad.push('credentials')
      if (bad.length) throw new MoveBundleError(`the copy does not match its own digests: ${bad.join(', ')}`)
      return { digests: got, ...ours }
    }
    if (section === 'people') {
      people.h.update(`${line}\n`)
      people.count++
      const doc = EJSON.parse(line, { relaxed: false }) as Doc
      const extra = Object.keys(doc).filter(k => !PEOPLE_KEYS.has(k))
      // Enforced at both ends: a copy that carries a password, wherever it came from, is not taken.
      if (extra.length) throw new MoveBundleError(`a person in the copy carries ${extra.join(', ')}`)
      yield { kind: 'person', doc }
      continue
    }
    if (section === 'credentials') {
      credentials.h.update(`${line}\n`)
      credentials.count++
      yield { kind: 'credential', item: JSON.parse(line) }
      continue
    }
    if (!coll) throw new MoveBundleError('a document before any collection')
    seen[coll].h.update(`${line}\n`)
    seen[coll].count++
    yield { kind: 'doc', coll, doc: EJSON.parse(line, { relaxed: false }) as Doc }
  }
  throw new MoveBundleError('the copy ends without its trailer')
}

/** Whether the org has any document here at all: a move imports only into an empty org. */
export async function orgHasData(db: Db, orgId: ObjectId): Promise<string | null> {
  for (const e of moveCollections()) {
    if (await db.collection(e.collection).findOne(filterFor(e, orgId) as any, { projection: { _id: 1 } })) return e.collection
  }
  return null
}

export interface ImportOptions {
  /** Called with the people about to be added, before they are: what an abort may remove again. */
  onNewPeople?: (ids: ObjectId[]) => Promise<void>
  /** Keeps the delivered credentials (`applyCredentialChanges`), once the people are in. */
  applyCredentials?: (items: unknown[]) => Promise<{ live: string[]; unopened: number }>
}

export interface Imported {
  documents: number
  digests: Digests
  /** The copy's people this server holds now, those it held before included. */
  people: number
  /** The copy's credentials this server keeps. */
  credentials: number
}

/**
 * Import a bundle into an EMPTY org, with raw writes: the documents are final as their home wrote
 * them, and no Mongoose hook may change one. Then the people: a person this server holds already
 * (a member of another org here) is kept as it is, its `tokenVersion` only ever raised. Returns the
 * digests of what is now in the database.
 */
export async function importMoveBundle(db: Db, orgId: ObjectId, path: string, opts: ImportOptions = {}): Promise<Imported> {
  const holder = await orgHasData(db, orgId)
  if (holder) throw new MoveBundleError(`this server already holds the org's ${holder}: a move imports only into an empty org`)
  let documents = 0
  let batch: Doc[] = []
  let batchColl: string | null = null
  const people: Doc[] = []
  const credentials: unknown[] = []
  const flush = async () => {
    if (batch.length && batchColl) await db.collection(batchColl).insertMany(batch as any[], { ordered: true })
    documents += batch.length
    batch = []
  }
  const it = readMoveBundle(path)
  for (;;) {
    const r = await it.next()
    if (r.done) break
    const item = r.value
    if (item.kind === 'person') {
      people.push(item.doc)
      continue
    }
    if (item.kind === 'credential') {
      credentials.push(item.item)
      continue
    }
    const { coll, doc } = item
    const docOrg = coll === 'orgs' ? doc._id : doc.orgId
    if (String(docOrg) !== String(orgId)) throw new MoveBundleError(`${coll} ${String(doc._id)} is not the org's`)
    if (coll !== batchColl || batch.length >= BATCH) {
      await flush()
      batchColl = coll
    }
    batch.push(doc)
  }
  await flush()

  // The people, once the whole copy has checked out.
  const ids = people.map(p => p._id as ObjectId)
  const held = new Map((await db.collection('identities').find({ _id: { $in: ids } } as any, { projection: { _id: 1 } }).toArray()).map((d: any) => [String(d._id), d]))
  const fresh = people.filter(p => !held.has(String(p._id)))
  if (fresh.length) {
    await opts.onNewPeople?.(fresh.map(p => p._id as ObjectId))
    try {
      await db.collection('identities').insertMany(fresh as any[], { ordered: true })
    } catch (e: any) {
      if (e?.code === 11000) throw new MoveBundleError('a person in the copy has the email of another person this server holds')
      throw e
    }
  }
  for (const p of people) {
    if (held.has(String(p._id))) {
      await db.collection('identities').updateOne({ _id: p._id, tokenVersion: { $lt: p.tokenVersion } } as any, { $set: { tokenVersion: p.tokenVersion } })
    }
  }
  let kept = 0
  if (credentials.length) {
    if (!opts.applyCredentials) throw new MoveBundleError('the copy carries credentials, and nothing here keeps them')
    const r = await opts.applyCredentials(credentials)
    if (r.unopened) throw new MoveBundleError(`${r.unopened} credentials did not open: lgrai.app sealed them to another key of this server`)
    kept = r.live.length
  }
  return {
    documents,
    digests: await collectionDigests(db, orgId),
    people: ids.length ? await db.collection('identities').countDocuments({ _id: { $in: ids } } as any) : 0,
    credentials: kept,
  }
}

/** Remove what an aborted move imported. Only the move's own frozen org, which held nothing before it. */
export async function discardMoveImport(db: Db, orgId: ObjectId): Promise<number> {
  let n = 0
  for (const e of moveCollections()) n += (await db.collection(e.collection).deleteMany(filterFor(e, orgId) as any)).deletedCount
  return n
}
