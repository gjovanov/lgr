/**
 * Test copies of a real org: build one, bring it up to date, wipe one, compare.
 *
 * ⚠ SERVER-ONLY. Reads one org's collections and writes another's with RAW driver calls, which the
 * Mongoose home guard cannot see, so every writing entry point asserts the target's home first
 * (FR-20.4) and every write carries the target's `orgId` in its filter or document.
 *
 * Why this exists: `regal-pz` and `regal-sf` are real shops. Their people need a place that holds
 * the same catalogue, contacts, stock and documents, where an experiment cannot print a fiscal
 * receipt, mail a customer, or move a real shelf. `test-regal-pz` / `test-regal-sf` are those
 * places, and this file is how they are filled and kept current.
 *
 * The rules this file keeps, each of which is a hazard that costs a release to find:
 *
 * 1. **The copy is written ONLY into an org marked `dev`**, and never from one (`assertCloneAllowed`).
 *    The marker is not an org admin's to set, so a real org cannot be turned into a target by
 *    someone with a clipboard, and a sync pointed at the wrong slug stops instead of overwriting
 *    a company's books.
 * 2. **Nothing reaches outward.** Hardware, devices, credentials, invites, mail logs and inboxes
 *    are never copied (`policy.ts#NEVER_CLONED`); the daily digest and the nightly backup are
 *    switched off on the copy. A source that keeps a company's books keeps them too
 *    (`policy.ts#BOOKS_NEVER_CLONED`, FR-25 R7), and `scanCopyForBooks` proves the copy holds none.
 * 3. **No file store.** Files, documents, archives and backups are not copied, so a delete in the
 *    test org cannot reach a file of the real one.
 * 4. **Idempotent and stateless.** A copy's id is a pure function of its source's (`ids.ts`) and a
 *    document is rewritten only when its content differs, so a run needs no memory of the last
 *    one and a second run changes nothing.
 * 5. **Source wins on a document both orgs hold; the test org keeps what only it holds.** A
 *    document someone created in the test org is never touched, and a deletion in the real org
 *    is not propagated. (`insertOnly` leaves even a drifted copy alone.)
 * 6. **A unique index is not a failure.** A document the test org already holds under the same
 *    number is reported as a conflict, and the run goes on: one clash must not hide the other
 *    five thousand documents.
 */

import { mongoose } from 'db/connection'
import { Org } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { tenantCollections } from '../backup/backup-bundle.service.js'
import { contentHash } from './canonical.js'
import { HEX24, cloneIdHex } from './ids.js'
import { namedIds } from './leaks.js'
import {
  BOOKS_NEVER_CLONED,
  IDENTITY_FIELDS,
  KEPT_ON_RESET,
  OUTWARD_SWITCHES_OFF,
  REFUSED_SOURCE_MODELS,
  clonePlain,
  clonedModels,
  copyOrder,
  keepsBooks,
  neverClonedFor,
  testOrgSettings,
} from './policy.js'
import { remapDoc, remapValue, type RemapEnv } from './remap.js'

const ObjectId = mongoose.Types.ObjectId
type Oid = InstanceType<typeof ObjectId>

export class OrgCloneError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'OrgCloneError'
  }
}

export type CloneLog = (message: string, extra?: Record<string, unknown>) => void

export interface CloneOptions {
  sourceOrgId: string
  targetOrgId: string
  /** false = a dry run: everything is read and compared, nothing is written. */
  execute: boolean
  /** Add what is missing; never touch a document the copy already holds, drifted or not. */
  insertOnly?: boolean
  /** The first copy: admin memberships keep their access to the test org. Every other membership is copied switched off. */
  activateAdmins?: boolean
  /** A warehouse code of the copy to point kept fiscal devices and workstations at, when theirs no longer exists (after a reset). */
  relinkHardwareTo?: string
  /** Restrict to these models (by model name). */
  only?: string[]
  batchSize?: number
  log?: CloneLog
}

export interface CollectionResult {
  model: string
  scanned: number
  /** On a dry run: what WOULD be inserted. */
  inserted: number
  /** On a dry run: what WOULD be rewritten. */
  updated: number
  unchanged: number
  /** A membership or permission set the test org already holds, so nothing was copied. */
  merged: number
  conflicts: number
  conflictSamples: string[]
  errors: string[]
}

export interface CloneReport {
  source: { id: string; slug: string }
  target: { id: string; slug: string }
  execute: boolean
  insertOnly: boolean
  startedAt: string
  durationMs: number
  collections: CollectionResult[]
  totals: { scanned: number; inserted: number; updated: number; unchanged: number; merged: number; conflicts: number; errors: number }
  /** What the source holds that the copy deliberately does not: model, why, how many rows. */
  notCloned: { model: string; reason: string; rows: number }[]
  warnings: string[]
}

const emptyResult = (model: string): CollectionResult => ({
  model, scanned: 0, inserted: 0, updated: 0, unchanged: 0, merged: 0, conflicts: 0, conflictSamples: [], errors: [],
})

const SAMPLE_CAP = 5
const sample = (res: CollectionResult, text: string) => {
  if (res.conflictSamples.length < SAMPLE_CAP) res.conflictSamples.push(text.slice(0, 240))
}

const asOid = (id: string, what: string): Oid => {
  if (!HEX24.test(String(id).toLowerCase())) throw new OrgCloneError('bad_id', `${what} is not an org id: ${JSON.stringify(id)}`)
  return new ObjectId(String(id))
}

const model = (name: string) => {
  const m = mongoose.models[name]
  if (!m) throw new OrgCloneError('no_model', `no model ${name}`)
  return m
}

// ── Guards ────────────────────────────────────────────────────────────────────────────────

interface RawOrg { _id: Oid; slug?: string; name?: string; settings?: any; [k: string]: any }

/**
 * May this pair be copied at all? Rule 1. Throws `OrgCloneError`; returns the two org documents.
 * Read fresh from the database, never from a cache: the marker is what the whole safety argument
 * rests on.
 */
export async function assertCloneAllowed(sourceOrgId: string, targetOrgId: string): Promise<{ source: RawOrg; target: RawOrg }> {
  const srcOid = asOid(sourceOrgId, 'source')
  const tgtOid = asOid(targetOrgId, 'target')
  if (String(srcOid) === String(tgtOid)) throw new OrgCloneError('same_org', 'the source and the target are the same org')
  const [source, target] = await Promise.all([
    Org.collection.findOne({ _id: srcOid }) as Promise<RawOrg | null>,
    Org.collection.findOne({ _id: tgtOid }) as Promise<RawOrg | null>,
  ])
  if (!source) throw new OrgCloneError('source_missing', `no org ${sourceOrgId}`)
  if (!target) throw new OrgCloneError('target_missing', `no org ${targetOrgId}`)
  if (target.settings?.environment !== 'dev') {
    throw new OrgCloneError('target_not_dev', `${target.slug} is not marked as a dev org (settings.environment): a copy is only ever written into one`)
  }
  if (source.settings?.environment === 'dev') {
    throw new OrgCloneError('source_is_dev', `${source.slug} is a dev org: a test copy is never a source`)
  }
  await assertHomeIsHere(String(srcOid), { fresh: true })
  await assertHomeIsHere(String(tgtOid), { fresh: true })
  for (const name of REFUSED_SOURCE_MODELS) {
    const m = mongoose.models[name]
    if (m && (await m.collection.countDocuments({ orgId: srcOid }, { limit: 1 }))) {
      throw new OrgCloneError('source_holds_sealed_data', `${source.slug} holds ${name} rows (sealed personal data): the engine does not copy those`)
    }
  }
  return { source, target }
}

// ── The environment the rewrite runs in ───────────────────────────────────────────────────

/**
 * Every model that holds an org's documents under an `orgId`: what a backup would bundle, the never-copied
 * ones included, AND the org's operational records and node state (backup runs, background tasks, the digest
 * log...). The last are never copied, but a copied document may still name one (an audit entry about a
 * backup): its id is then rewritten to the id the copy WOULD have, which points at nothing, instead of
 * being left naming a record of the real org.
 */
function orgScopedModels(): string[] {
  return Object.keys(mongoose.models).filter(name => !!mongoose.models[name]!.schema.path('orgId')).sort()
}

/** Every `_id` of the source org in every collection that holds its documents (see `orgScopedModels`). */
async function loadKnownIds(srcOid: Oid, models: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>()
  for (const name of models) {
    const cursor = model(name).collection.find({ orgId: srcOid }, { projection: { _id: 1 } })
    for await (const d of cursor as any) known.add(String(d._id))
  }
  return known
}

/**
 * Source ids that map onto a document the target ALREADY has, not onto a fresh copy: a person who
 * is already a member (matched by their identity), a permission set or a role of the same name, an
 * enabled app of the same app. Without it
 * a membership that exists would be copied a second time and refused by the unique index, and
 * every document the person created would point at a membership nobody holds.
 */
async function buildOverrides(srcOid: Oid, tgtOid: Oid): Promise<Map<string, string>> {
  const overrides = new Map<string, string>()

  const users = model('User').collection
  const mine = new Map<string, string>()
  for await (const u of users.find({ orgId: tgtOid, identityId: { $ne: null } }, { projection: { identityId: 1 } }) as any) {
    mine.set(String(u.identityId), String(u._id))
  }
  for await (const u of users.find({ orgId: srcOid, identityId: { $ne: null } }, { projection: { identityId: 1 } }) as any) {
    const there = mine.get(String(u.identityId))
    if (there) overrides.set(String(u._id), there)
  }

  const sets = model('PermissionSet').collection
  const byName = new Map<string, string>()
  for await (const s of sets.find({ orgId: tgtOid }, { projection: { name: 1 } }) as any) byName.set(String(s.name), String(s._id))
  for await (const s of sets.find({ orgId: srcOid }, { projection: { name: 1 } }) as any) {
    const there = byName.get(String(s.name))
    if (there) overrides.set(String(s._id), there)
  }

  // An enabled app is matched by which app it is: the unique key (orgId, appId), and a row the app made by
  // itself when someone opened the hub is the same switch as the real org's.
  const apps = model('OrgApp').collection
  const appByKey = new Map<string, string>()
  for await (const a of apps.find({ orgId: tgtOid }, { projection: { appId: 1 } }) as any) appByKey.set(String(a.appId), String(a._id))
  for await (const a of apps.find({ orgId: srcOid }, { projection: { appId: 1 } }) as any) {
    const there = appByKey.get(String(a.appId))
    if (there) overrides.set(String(a._id), there)
  }

  // A role (FR-27) is matched by its name, then as the same built-in template, then as the same
  // imported access: the three unique keys a role has, so a copy never meets its own clash.
  const roles = model('Role').collection
  const projection = { name: 1, isBuiltin: 1, templateKey: 1, legacyKey: 1 }
  const roleByName = new Map<string, string>()
  const roleByTemplate = new Map<string, string>()
  const roleByLegacy = new Map<string, string>()
  for await (const r of roles.find({ orgId: tgtOid }, { projection }) as any) {
    roleByName.set(String(r.name), String(r._id))
    if (r.isBuiltin && r.templateKey) roleByTemplate.set(String(r.templateKey), String(r._id))
    if (typeof r.legacyKey === 'string') roleByLegacy.set(r.legacyKey, String(r._id))
  }
  for await (const r of roles.find({ orgId: srcOid }, { projection }) as any) {
    const there =
      roleByName.get(String(r.name)) ??
      (r.isBuiltin && r.templateKey ? roleByTemplate.get(String(r.templateKey)) : undefined) ??
      (typeof r.legacyKey === 'string' ? roleByLegacy.get(r.legacyKey) : undefined)
    if (there) overrides.set(String(r._id), there)
  }
  return overrides
}

function makeEnv(srcHex: string, tgtHex: string, known: ReadonlySet<string>, overrides: ReadonlyMap<string, string>): RemapEnv {
  return {
    idOf: hex => {
      const id = hex.toLowerCase()
      const over = overrides.get(id)
      if (over) return over
      if (id === srcHex) return tgtHex
      return known.has(id) ? cloneIdHex(id, tgtHex) : undefined
    },
    oid: hex => new ObjectId(hex),
    sourceOrgId: srcHex,
    targetOrgId: tgtHex,
  }
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────

interface Ctx {
  execute: boolean
  insertOnly: boolean
  activateAdmins: boolean
  batch: number
  srcOid: Oid
  tgtOid: Oid
  srcHex: string
  tgtHex: string
  env: RemapEnv
  overrides: ReadonlyMap<string, string>
  log: CloneLog
}

/** Never write a document that is not the target's. A bug in the rewrite stops the run here, not in the real org. */
function assertTargetDocs(ctx: Ctx, docs: any[], where: string): void {
  for (const d of docs) {
    if (String(d?.orgId) !== ctx.tgtHex) throw new OrgCloneError('foreign_write', `${where}: a document would be written with orgId ${String(d?.orgId)}, not ${ctx.tgtHex}`)
  }
}

interface InsertOutcome { inserted: number; conflicts: number; samples: string[]; errors: string[] }

/** `insertMany` that treats a unique-index clash as a count, not a failure. */
async function insertUnordered(coll: any, docs: any[]): Promise<InsertOutcome> {
  try {
    const r = await coll.insertMany(docs, { ordered: false })
    return { inserted: r?.insertedCount ?? docs.length, conflicts: 0, samples: [], errors: [] }
  } catch (e: any) {
    const raw = e?.writeErrors ?? e?.result?.getWriteErrors?.() ?? e?.result?.result?.writeErrors
    const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : []
    if (!list.length) throw e
    const out: InsertOutcome = { inserted: docs.length - list.length, conflicts: 0, samples: [], errors: [] }
    for (const we of list) {
      const code = we?.code ?? we?.err?.code
      const text = String(we?.errmsg ?? we?.err?.errmsg ?? we?.message ?? '')
      if (code === 11000) {
        out.conflicts++
        out.samples.push(text)
      } else {
        out.errors.push(`${code}: ${text}`.slice(0, 240))
      }
    }
    return out
  }
}

/** One batch of source documents of an ordinary model: insert what is missing, rewrite what drifted. */
async function writeBatch(name: string, coll: any, docs: any[], ctx: Ctx, res: CollectionResult): Promise<void> {
  res.scanned += docs.length
  const clones = docs.map(d => remapDoc(d, ctx.env))
  assertTargetDocs(ctx, clones, name)

  const present = new Map<string, any>()
  for (const e of await coll.find({ _id: { $in: clones.map(c => c._id) } }).toArray()) present.set(String(e._id), e)

  const toInsert: any[] = []
  const toReplace: any[] = []
  for (const c of clones) {
    const held = present.get(String(c._id))
    if (!held) {
      toInsert.push(c)
    } else if (String(held.orgId) !== ctx.tgtHex) {
      // The copy's id is taken by a document of another org. 2^-64 by construction; said, not skipped.
      res.conflicts++
      sample(res, `${String(c._id)} is held by another org`)
    } else if (ctx.insertOnly || contentHash(held) === contentHash(c)) {
      res.unchanged++
    } else {
      toReplace.push(c)
    }
  }

  if (!ctx.execute) {
    res.inserted += toInsert.length
    res.updated += toReplace.length
    return
  }
  if (toInsert.length) {
    const r = await insertUnordered(coll, toInsert)
    res.inserted += r.inserted
    res.conflicts += r.conflicts
    r.samples.forEach(s => sample(res, s))
    res.errors.push(...r.errors)
  }
  if (toReplace.length) {
    const r = await coll.bulkWrite(
      toReplace.map(c => ({ replaceOne: { filter: { _id: c._id, orgId: ctx.tgtOid }, replacement: c } })),
      { ordered: false },
    )
    res.updated += r?.modifiedCount ?? toReplace.length
  }
}

async function copyOrdinary(name: string, ctx: Ctx): Promise<CollectionResult> {
  const coll = model(name).collection
  const res = emptyResult(name)
  let batch: any[] = []
  const flush = async () => {
    if (!batch.length) return
    const docs = batch
    batch = []
    await writeBatch(name, coll, docs, ctx, res)
  }
  const cursor = coll.find({ orgId: ctx.srcOid }).sort({ _id: 1 }).batchSize(ctx.batch)
  for await (const doc of cursor as any) {
    batch.push(doc)
    if (batch.length >= ctx.batch) await flush()
  }
  await flush()
  return res
}

/**
 * A seed-only model: inserted when the target has nothing for it, never rewritten. Source documents
 * the target already covers (see `buildOverrides`) are skipped; `shape` adjusts the copy.
 */
async function copySeedOnly(name: string, ctx: Ctx, shape?: (source: any, copy: any) => void): Promise<CollectionResult> {
  const coll = model(name).collection
  const res = emptyResult(name)
  for await (const doc of coll.find({ orgId: ctx.srcOid }).sort({ _id: 1 }) as any) {
    res.scanned++
    if (ctx.overrides.has(String(doc._id))) {
      res.merged++
      continue
    }
    const copy = remapDoc(doc, ctx.env)
    assertTargetDocs(ctx, [copy], name)
    if (await coll.findOne({ _id: copy._id }, { projection: { _id: 1 } })) {
      res.unchanged++
      continue
    }
    shape?.(doc, copy)
    if (!ctx.execute) {
      res.inserted++
      continue
    }
    const r = await insertUnordered(coll, [copy])
    res.inserted += r.inserted
    res.conflicts += r.conflicts
    r.samples.forEach(s => sample(res, s))
    res.errors.push(...r.errors)
  }
  return res
}

/** Memberships are copied switched off, except an admin's on the first copy: who may enter the test org is decided there. */
function membershipAccess(ctx: Ctx) {
  return (source: any, copy: any) => {
    const keep = ctx.activateAdmins && source.role === 'admin' && source.isActive !== false
    if (!keep && copy.isActive !== false) {
      copy.isActive = false
      copy.deactivatedAt = copy.deactivatedAt ?? new Date()
    }
  }
}

/** Numbering never goes backwards: a counter the copy is already past stays where it is. */
async function copySequences(ctx: Ctx): Promise<CollectionResult> {
  const coll = model('Sequence').collection
  const res = emptyResult('Sequence')
  for await (const doc of coll.find({ orgId: ctx.srcOid }).sort({ _id: 1 }) as any) {
    res.scanned++
    const held: any = await coll.findOne({ orgId: ctx.tgtOid, prefix: doc.prefix, year: doc.year })
    if (!held) {
      const copy = remapDoc(doc, ctx.env)
      assertTargetDocs(ctx, [copy], 'Sequence')
      if (!ctx.execute) {
        res.inserted++
        continue
      }
      const r = await insertUnordered(coll, [copy])
      res.inserted += r.inserted
      res.conflicts += r.conflicts
      r.samples.forEach(s => sample(res, s))
      res.errors.push(...r.errors)
      continue
    }
    const set: Record<string, unknown> = {}
    if ((held.lastNumber ?? 0) < (doc.lastNumber ?? 0)) set.lastNumber = doc.lastNumber
    if (doc.displayPrefix && !held.displayPrefix) set.displayPrefix = doc.displayPrefix
    if (!Object.keys(set).length) {
      res.unchanged++
      continue
    }
    if (ctx.execute) await coll.updateOne({ _id: held._id, orgId: ctx.tgtOid }, { $set: set })
    res.updated++
  }
  return res
}

// ── The copy ──────────────────────────────────────────────────────────────────────────────

/**
 * Bring the target org's data up to date with the source's. Safe to run any number of times.
 * `execute: false` reads and compares everything and writes nothing.
 */
export async function cloneOrgData(opts: CloneOptions): Promise<CloneReport> {
  const started = Date.now()
  const log: CloneLog = opts.log ?? (() => {})
  const { source, target } = await assertCloneAllowed(opts.sourceOrgId, opts.targetOrgId)
  const srcOid = source._id
  const tgtOid = target._id
  const srcHex = String(srcOid)
  const tgtHex = String(tgtOid)

  const tenant = tenantCollections()
  // Read from the source as it is now: an org that keeps a company's books never lets them into a copy.
  const never = neverClonedFor(source)
  const toCopy = copyOrder(clonedModels(tenant, source)).filter(m => !opts.only?.length || opts.only.includes(m))
  const unknown = (opts.only ?? []).filter(m => !tenant.includes(m) || m in never)
  if (unknown.length) throw new OrgCloneError('bad_only', `not a model a copy carries: ${unknown.join(', ')}`)

  log('reading the source ids', { source: source.slug })
  const known = await loadKnownIds(srcOid, orgScopedModels())
  const overrides = await buildOverrides(srcOid, tgtOid)
  const env = makeEnv(srcHex, tgtHex, known, overrides)
  log('ids read', { documents: known.size, mapped: overrides.size })

  const ctx: Ctx = {
    execute: !!opts.execute,
    insertOnly: !!opts.insertOnly,
    activateAdmins: !!opts.activateAdmins,
    batch: Math.max(50, Math.min(opts.batchSize ?? 500, 2000)),
    srcOid, tgtOid, srcHex, tgtHex, env, overrides, log,
  }

  const collections: CollectionResult[] = []
  for (const name of toCopy) {
    const t = Date.now()
    let res: CollectionResult
    try {
      if (name === 'User') res = await copySeedOnly(name, ctx, membershipAccess(ctx))
      else if (name === 'PermissionSet' || name === 'Role' || name === 'OrgApp') res = await copySeedOnly(name, ctx)
      else if (name === 'Sequence') res = await copySequences(ctx)
      else res = await copyOrdinary(name, ctx)
    } catch (e: any) {
      // One model failing must not stop the others, but it must not look fine either.
      res = emptyResult(name)
      res.errors.push(String(e?.message ?? e).slice(0, 300))
      logger.error({ model: name, err: e?.message }, 'Org clone: a model failed')
    }
    collections.push(res)
    if (res.scanned || res.errors.length) {
      const would = ctx.execute ? '' : 'would be '
      log(
        `${name}: ${res.scanned} read, ${res.inserted} ${would}inserted, ${res.updated} ${would}updated, ${res.unchanged} unchanged` +
          `${res.merged ? `, ${res.merged} already there` : ''}${res.conflicts ? `, ${res.conflicts} conflicts` : ''}${res.errors.length ? `, ${res.errors.length} ERRORS` : ''}`,
        { ms: Date.now() - t },
      )
    }
  }

  const warnings: string[] = []
  if (ctx.execute) {
    await finishProfile(ctx, source, target, warnings)
    if (opts.relinkHardwareTo) await relinkHardware(ctx, opts.relinkHardwareTo, warnings)
  }

  const notCloned: CloneReport['notCloned'] = []
  for (const [name, reason] of Object.entries(never)) {
    if (!tenant.includes(name)) continue
    const rows = await model(name).collection.countDocuments({ orgId: srcOid })
    if (rows) notCloned.push({ model: name, reason, rows })
  }

  const sum = (k: keyof CollectionResult) => collections.reduce((n, c) => n + (c[k] as number), 0)
  return {
    source: { id: srcHex, slug: source.slug ?? '' },
    target: { id: tgtHex, slug: target.slug ?? '' },
    execute: ctx.execute,
    insertOnly: ctx.insertOnly,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    collections,
    totals: {
      scanned: sum('scanned'), inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'),
      merged: sum('merged'), conflicts: sum('conflicts'), errors: collections.reduce((n, c) => n + c.errors.length, 0),
    },
    notCloned,
    warnings,
  }
}

/**
 * What the org document itself needs once its data is in: its owner (a membership of the copy),
 * and the logo's URL (it names the org). Fills gaps only; an owner or a logo the test org already
 * has is its own.
 */
async function finishProfile(ctx: Ctx, source: RawOrg, target: RawOrg, warnings: string[]): Promise<void> {
  const set: Record<string, unknown> = {}
  const users = model('User').collection

  if (source.ownerId) {
    const wanted = ctx.env.idOf(String(source.ownerId))
    const heldOwner = target.ownerId ? await users.findOne({ _id: target.ownerId, orgId: ctx.tgtOid }, { projection: { _id: 1 } }) : null
    if (wanted && !heldOwner) {
      const exists = await users.findOne({ _id: new ObjectId(wanted), orgId: ctx.tgtOid }, { projection: { _id: 1 } })
      if (exists) set.ownerId = new ObjectId(wanted)
      else warnings.push("the copy has no membership for the source org's owner: its owner is left as it was")
    }
  }

  const logo: any = await model('OrgLogo').collection.findOne({ orgId: ctx.tgtOid }, { projection: { hash: 1 } })
  if (logo?.hash) {
    // The same URL the logo service writes (`org-logo.service.ts#logoUrl`).
    const url = `/api/org/${ctx.tgtHex}/logo?v=${logo.hash}`
    if (target.logo !== url) set.logo = url
  }

  if (Object.keys(set).length) await Org.collection.updateOne({ _id: ctx.tgtOid }, { $set: set })
}

/**
 * After a reset the kept fiscal devices and workstations name warehouses that no longer exist.
 * Point them at the copy's warehouse with this code, so the owner's test rig is still one piece.
 */
async function relinkHardware(ctx: Ctx, warehouseCode: string, warnings: string[]): Promise<void> {
  const warehouses = model('Warehouse').collection
  const wanted: any = await warehouses.findOne({ orgId: ctx.tgtOid, code: warehouseCode }, { projection: { _id: 1 } })
  if (!wanted) {
    warnings.push(`no warehouse with code ${warehouseCode} in the copy: kept hardware was not relinked`)
    return
  }
  const live = new Set<string>()
  for await (const w of warehouses.find({ orgId: ctx.tgtOid }, { projection: { _id: 1 } }) as any) live.add(String(w._id))
  for (const name of ['FiscalDevice', 'Workstation']) {
    const coll = model(name).collection
    for await (const d of coll.find({ orgId: ctx.tgtOid }, { projection: { warehouseId: 1 } }) as any) {
      if (d.warehouseId && !live.has(String(d.warehouseId))) {
        await coll.updateOne({ _id: d._id, orgId: ctx.tgtOid }, { $set: { warehouseId: wanted._id } })
        ctx.log(`${name} ${String(d._id)} relinked to warehouse ${warehouseCode}`)
      }
    }
  }
}

// ── Creating, converting, resetting, marking ──────────────────────────────────────────────

/** A brand-new test org, from the real one's identity and settings. No data yet: `cloneOrgData` fills it. */
export async function createTestOrgFrom(opts: { sourceOrgId: string; slug: string; name: string; execute: boolean; log?: CloneLog }): Promise<{ orgId: string; created: boolean }> {
  const srcOid = asOid(opts.sourceOrgId, 'source')
  const source = (await Org.collection.findOne({ _id: srcOid })) as RawOrg | null
  if (!source) throw new OrgCloneError('source_missing', `no org ${opts.sourceOrgId}`)
  if (source.settings?.environment === 'dev') throw new OrgCloneError('source_is_dev', `${source.slug} is a dev org: a test copy is never a source`)
  await assertHomeIsHere(String(srcOid), { fresh: true })
  const slug = opts.slug.toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) throw new OrgCloneError('bad_slug', `not a usable slug: ${opts.slug}`)
  const already = (await Org.collection.findOne({ slug })) as RawOrg | null
  if (already) {
    if (already.settings?.environment === 'dev') return { orgId: String(already._id), created: false }
    throw new OrgCloneError('slug_taken', `${slug} exists and is not a dev org`)
  }
  if (!opts.execute) return { orgId: '(dry run)', created: true }

  const tgtOid = new ObjectId()
  const tgtHex = String(tgtOid)
  // The rewrite needs the source's ids to turn the settings' account and journal ids into the copy's.
  const known = await loadKnownIds(srcOid, orgScopedModels())
  const env = makeEnv(String(srcOid), tgtHex, known, new Map())

  const settings: any = remapValue(testOrgSettings(source.settings), env)
  // A copy holds no fiscal device (they are never copied), so a till sale could never find a connected
  // printer: the printer gate is off, as on every org with no device (FR-23). `new-org-printer-gate.flow.test.ts`
  // names this creation path and looks for exactly this line.
  settings.cashRegister = { ...(settings.cashRegister ?? {}), requireConnectedDevice: false }

  const doc: Record<string, unknown> = {
    _id: tgtOid,
    name: opts.name,
    slug,
    settings,
    subscription: { plan: 'professional', maxUsers: 50, status: 'active', cancelAtPeriodEnd: false },
  }
  for (const f of IDENTITY_FIELDS) if (source[f] !== undefined) doc[f] = clonePlain(source[f])
  if (source.ownerId) doc.ownerId = env.oid(env.idOf(String(source.ownerId)) ?? String(source.ownerId))
  await Org.create(doc as any)
  opts.log?.(`created ${slug}`, { orgId: tgtHex })
  return { orgId: tgtHex, created: true }
}

/**
 * An EXISTING org becomes a test copy: renamed, marked dev, its outward switches off, its company
 * identity taken from the real one. Its other settings (the till's printer gate among them), its
 * people and its enrolled devices are left exactly as they were.
 */
export async function convertToTestOrg(opts: {
  orgId: string
  expectSlug: string
  newSlug: string
  newName: string
  sourceOrgId: string
  execute: boolean
  log?: CloneLog
}): Promise<{ changes: Record<string, unknown> }> {
  const oid = asOid(opts.orgId, 'org')
  const srcOid = asOid(opts.sourceOrgId, 'source')
  const org = (await Org.collection.findOne({ _id: oid })) as RawOrg | null
  if (!org) throw new OrgCloneError('target_missing', `no org ${opts.orgId}`)
  if (org.slug !== opts.expectSlug) throw new OrgCloneError('slug_mismatch', `the org is ${org.slug}, not ${opts.expectSlug}: nothing was changed`)
  if (org.settings?.environment === 'prod') throw new OrgCloneError('org_is_prod', `${org.slug} is marked prod`)
  const source = (await Org.collection.findOne({ _id: srcOid })) as RawOrg | null
  if (!source) throw new OrgCloneError('source_missing', `no org ${opts.sourceOrgId}`)
  if (source.settings?.environment === 'dev') throw new OrgCloneError('source_is_dev', `${source.slug} is a dev org: a test copy is never a source`)
  await assertHomeIsHere(String(oid), { fresh: true })

  const slug = opts.newSlug.toLowerCase()
  if (slug !== org.slug) {
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) throw new OrgCloneError('bad_slug', `not a usable slug: ${opts.newSlug}`)
    if (await Org.collection.findOne({ slug, _id: { $ne: oid } })) throw new OrgCloneError('slug_taken', `${slug} is taken`)
  }
  const changes: Record<string, unknown> = { slug, name: opts.newName, ...OUTWARD_SWITCHES_OFF }
  for (const f of IDENTITY_FIELDS) if (source[f] !== undefined) changes[f] = clonePlain(source[f])
  if (opts.execute) await Org.collection.updateOne({ _id: oid }, { $set: changes })
  opts.log?.(`${org.slug} -> ${slug}`, { name: opts.newName })
  return { changes }
}

export async function markOrgEnvironment(opts: { orgId: string; expectSlug: string; environment: 'prod' | 'dev'; execute: boolean }): Promise<void> {
  const oid = asOid(opts.orgId, 'org')
  const org = (await Org.collection.findOne({ _id: oid })) as RawOrg | null
  if (!org) throw new OrgCloneError('target_missing', `no org ${opts.orgId}`)
  if (org.slug !== opts.expectSlug) throw new OrgCloneError('slug_mismatch', `the org is ${org.slug}, not ${opts.expectSlug}: nothing was changed`)
  if (opts.environment !== 'prod' && opts.environment !== 'dev') throw new OrgCloneError('bad_environment', 'prod or dev')
  await assertHomeIsHere(String(oid), { fresh: true })
  if (opts.execute) await Org.collection.updateOne({ _id: oid }, { $set: { 'settings.environment': opts.environment } })
}

export interface ResetReport {
  org: { id: string; slug: string }
  execute: boolean
  deleted: Record<string, number>
  kept: Record<string, number>
}

/**
 * Empty a test org of its data, keeping its people and its enrolled hardware (`KEPT_ON_RESET`), so
 * the next copy starts from nothing. The backups, the digest log and the node state of the org
 * are not data and are not touched: the nightly bundles of the org stay where they are, which is
 * what an undo is made from.
 */
export async function resetOrgData(opts: { orgId: string; expectSlug: string; execute: boolean; log?: CloneLog }): Promise<ResetReport> {
  const oid = asOid(opts.orgId, 'org')
  const org = (await Org.collection.findOne({ _id: oid })) as RawOrg | null
  if (!org) throw new OrgCloneError('target_missing', `no org ${opts.orgId}`)
  if (org.slug !== opts.expectSlug) throw new OrgCloneError('slug_mismatch', `the org is ${org.slug}, not ${opts.expectSlug}: nothing was deleted`)
  if (org.settings?.environment !== 'dev') throw new OrgCloneError('target_not_dev', `${org.slug} is not marked dev: only a test copy is ever wiped`)
  await assertHomeIsHere(String(oid), { fresh: true })
  for (const name of REFUSED_SOURCE_MODELS) {
    const m = mongoose.models[name]
    if (m && (await m.collection.countDocuments({ orgId: oid }, { limit: 1 }))) {
      throw new OrgCloneError('holds_sealed_data', `${org.slug} holds ${name} rows (sealed personal data): it is not wiped`)
    }
  }

  const report: ResetReport = { org: { id: String(oid), slug: org.slug ?? '' }, execute: !!opts.execute, deleted: {}, kept: {} }
  for (const name of tenantCollections()) {
    const coll = model(name).collection
    const rows = await coll.countDocuments({ orgId: oid })
    if (!rows) continue
    if (KEPT_ON_RESET.includes(name)) {
      report.kept[name] = rows
      continue
    }
    report.deleted[name] = rows
    if (opts.execute) await coll.deleteMany({ orgId: oid })
    opts.log?.(`${name}: ${rows} ${opts.execute ? 'deleted' : 'would be deleted'}`)
  }
  return report
}

// ── Looking ───────────────────────────────────────────────────────────────────────────────

export interface CompareRow { model: string; source: number; target: number }

/**
 * Document counts per carried model, side by side. The target may hold more (what only it created); fewer is a copy not yet made.
 * A source that keeps a company's books carries none of them, so they are not rows here (`scanCopyForBooks` checks them).
 */
export async function compareOrgs(sourceOrgId: string, targetOrgId: string): Promise<CompareRow[]> {
  const srcOid = asOid(sourceOrgId, 'source')
  const tgtOid = asOid(targetOrgId, 'target')
  const source = (await Org.collection.findOne({ _id: srcOid }, { projection: { 'settings.accounting.books.mode': 1 } })) as RawOrg | null
  const rows: CompareRow[] = []
  for (const name of clonedModels(tenantCollections(), source)) {
    const coll = model(name).collection
    const [source, target] = await Promise.all([coll.countDocuments({ orgId: srcOid }), coll.countDocuments({ orgId: tgtOid })])
    if (source || target) rows.push({ model: name, source, target })
  }
  return rows
}

// ── Checking ──────────────────────────────────────────────────────────────────────────────

export interface LeakScan {
  /** The ids of the real org the scan looked for: its own, and every document's it holds in any collection. */
  sourceIds: number
  /** Documents of the copy that were read (its org row included). */
  copyDocs: number
  /** Documents of the copy that name an id of the real org. Zero is the only acceptable answer. */
  leaking: number
  /** Per collection: how many documents of the copy leak. */
  byCollection: Record<string, number>
  /** Up to three of the COPY's own document ids per collection, to go and look at. Never an id of the real org. */
  samples: Record<string, string[]>
}

/**
 * READ-ONLY: does any document of the copy still name the real org, its id or the id of any document it holds?
 * That is a link into another tenant, which is what a copy exists not to have.
 *
 * Independent of the engine on purpose. It does not use the models a copy is built from, nor the rewrite's
 * rule: it walks EVERY collection of the database that has a row under either org's `orgId` and looks at
 * every 24-hex window of every document (`leaks.ts`). A test's fixture cannot hold the shapes real data has
 * (the first production copies named real-org ids inside tags and audit text that no fixture had), so this
 * is what to run on the real copies after a change to `remap.ts`, a new model with an `orgId`, or a doubt.
 * It takes exactly the pairs a sync takes (`assertCloneAllowed`) and reports counts and the copy's own ids only.
 */
export async function scanCopyForLeaks(sourceOrgId: string, targetOrgId: string): Promise<LeakScan> {
  const { source, target } = await assertCloneAllowed(sourceOrgId, targetOrgId)
  const db = mongoose.connection.db
  if (!db) throw new OrgCloneError('not_connected', 'no database connection')
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort()

  const ids = new Set<string>([String(source._id)])
  for (const name of names) {
    const c = db.collection(name)
    if (!(await c.countDocuments({ orgId: source._id }, { limit: 1 }))) continue
    for await (const d of c.find({ orgId: source._id }, { projection: { _id: 1 } })) {
      const id = String(d._id).toLowerCase()
      if (HEX24.test(id)) ids.add(id)
    }
  }

  const byCollection: Record<string, number> = {}
  const samples: Record<string, string[]> = {}
  let copyDocs = 0
  let leaking = 0
  const look = (name: string, d: any) => {
    copyDocs++
    if (!namedIds(JSON.stringify(d), ids).length) return
    leaking++
    byCollection[name] = (byCollection[name] ?? 0) + 1
    const list = (samples[name] ??= [])
    if (list.length < 3) list.push(String(d._id))
  }

  look(Org.collection.collectionName, target) // the copy's own org row must not name the real one either
  for (const name of names) {
    const c = db.collection(name)
    if (!(await c.countDocuments({ orgId: target._id }, { limit: 1 }))) continue
    for await (const d of c.find({ orgId: target._id })) look(name, d)
  }
  return { sourceIds: ids.size, copyDocs, leaking, byCollection, samples }
}

export interface BooksScan {
  /** Whether the real org keeps a company's books. When it does not, nothing was looked for. */
  keepsBooks: boolean
  /** Rows of the real org's books looked for in the copy. */
  checked: number
  /** Per model, how many of them the copy holds a copy of. Empty is the only acceptable answer. */
  copied: Record<string, number>
}

/**
 * READ-ONLY: does the copy hold a copy of the real org's books (FR-25 R7)? The leak scan cannot tell: a
 * copied entry has every id rewritten, so it names nothing of the real org. A copy's id is a function of
 * its source's (`ids.ts`), so each row of the books is looked for under the id its copy would carry. The
 * test org's own accounting, typed in there, is not a copy and is not counted. Counts only.
 */
export async function scanCopyForBooks(sourceOrgId: string, targetOrgId: string): Promise<BooksScan> {
  const { source, target } = await assertCloneAllowed(sourceOrgId, targetOrgId)
  if (!keepsBooks(source)) return { keepsBooks: false, checked: 0, copied: {} }
  const tgtHex = String(target._id)
  const copied: Record<string, number> = {}
  let checked = 0
  for (const name of Object.keys(BOOKS_NEVER_CLONED)) {
    const coll = mongoose.models[name]?.collection
    if (!coll) continue
    let batch: Oid[] = []
    const flush = async () => {
      if (!batch.length) return
      const held = await coll.countDocuments({ _id: { $in: batch }, orgId: target._id })
      batch = []
      if (held) copied[name] = (copied[name] ?? 0) + held
    }
    for await (const d of coll.find({ orgId: source._id }, { projection: { _id: 1 } }) as any) {
      const hex = String(d._id).toLowerCase()
      if (!HEX24.test(hex)) continue
      checked++
      batch.push(new ObjectId(cloneIdHex(hex, tgtHex)))
      if (batch.length >= 1000) await flush()
    }
    await flush()
  }
  return { keepsBooks: true, checked, copied }
}
