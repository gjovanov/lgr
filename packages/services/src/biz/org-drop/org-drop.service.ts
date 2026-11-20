import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Types } from 'mongoose'
import { mongoose } from 'db/connection'
import { assertHomeIsHere, HomeElsewhereError } from 'db/home/home'
import { bundleExclusion, iterateBundleLines, readBundlePlain, verifyBundle } from '../backup/backup-bundle.service'
import { namedIds } from '../org-clone/leaks'

/**
 * Deleting an organisation for good: every row under its `orgId`, then the org itself (FR-25 §7, 2026-11-20).
 *
 * The app never deletes an org. This is for the one case its owner orders it, once its data lives elsewhere, and it deletes
 * only documents that a verified backup bundle holds byte for byte:
 * - the org is named twice, by slug and by id, and both must match. Its home is this server (FR-20.4), because the
 *   deletes go through the driver, which no write guard sees;
 * - nobody can sign in to it or join it. Every membership is switched off (`isActive: false` with a `deactivatedAt`; one
 *   without is pending, and a password reset turns it on) and no invite is open;
 * - nothing outside it names it: no other org, no membership of another org, no person, no global registry (every
 *   collection that is not an org's data). The exception is `PROVENANCE_ONLY`, a record of where something came from
 *   that nothing reads. Other orgs' DATA is not searched: it is most of the database, and a link from one org's data
 *   into another's is what the tenant guard exists to prevent;
 * - all of its rows belong to models that a bundle carries. Node state (a home, an address, a node, a move) is refused,
 *   because each has its own way to be retired and a deleted row would free what it reserves. Operational records
 *   (backup, digest and restore runs), which a bundle leaves out on purpose, are saved in the org's file instead and
 *   deleted with it;
 * - a FULL bundle of exactly this org verifies against the sha256 it was written with, and holds every live row with the
 *   same content, read the way the database holds it. A row written or changed after the bundle stops the drop. A row
 *   deleted since does not, because the bundle still holds it, and that is what lets an interrupted drop run again.
 *
 * The deletes then name each proven document by its id, so a row written after the check stays. The org itself goes
 * only once nothing is left under its id. Before any delete, the org's own document (which no bundle carries) and its
 * operational records are written beside the bundle (`…-org.json`, mode 600), without the cloud-storage tokens it holds.
 * The people (`Identity`) are global and stay, and the bundle holds a copy of them.
 */
export class OrgDropError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OrgDropError'
  }
}

/**
 * Fields outside an org that may still name it once it is gone. `passwordSetByOrgId` says which org's admin set a
 * person's password: it is history, and nothing decides anything on it.
 */
export const PROVENANCE_ONLY: Readonly<Record<string, readonly string[]>> = { identities: ['passwordSetByOrgId'] }

/** Credentials an org document may hold, which the saved copy leaves out: a restored org connects its storage again. */
const SECRET_FIELDS: ReadonlyArray<readonly [string, string]> = ['googleDrive', 'onedrive', 'dropbox'].flatMap(p => [[p, 'accessToken'], [p, 'refreshToken']] as const)

const EJSON = mongoose.mongo.BSON.EJSON
/** A document id as the driver reads it. */
type RowId = InstanceType<typeof mongoose.mongo.ObjectId>
const SAVED_FORMAT = 'lgr-org-drop/1'

export interface OrgDropRequest {
  orgId: string
  /** The org's slug, as a second name for it: an id copied from the wrong line is refused. */
  expectSlug: string
  bundlePath: string
  /** The sha256 the bundle was written with, over the compressed file. */
  bundleSha256: string
}

export interface OrgDropPlan {
  org: { id: string; slug: string }
  bundle: { path: string; sha256: string; documentCount: number; createdAt: string }
  /** Rows under the org's id, per collection: what the drop deletes. */
  rows: Record<string, number>
  total: number
  /** Collections of `rows` holding operational records, which no bundle carries: they are saved in the org's file instead. */
  operational: string[]
  /** Documents outside the org that name it only in a `PROVENANCE_ONLY` field, and keep naming it. */
  provenance: number
  /** Per collection, the ids of the documents proven to be in the bundle, or saved for the operational ones. Not printed. */
  ids: Record<string, RowId[]>
  /** The operational records themselves, for the org's file. Not printed. */
  operationalDocs: Record<string, Record<string, unknown>[]>
}

export interface OrgDropReport extends OrgDropPlan {
  execute: boolean
  deleted: Record<string, number>
  /** The org's file beside the bundle. `reused` means an interrupted earlier run had written it. */
  saved?: { path: string; sha256: string; reused: boolean }
  /** Rows still under the org's id after the deletes. With any left, the org stays. */
  left: number
  orgDeleted: boolean
}

const db = () => {
  const handle = mongoose.connection.db
  if (!handle) throw new OrgDropError('not_connected', 'no database connection')
  return handle
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** The id, checked to be one. The CLI calls it before anything else, so a mistyped id never reaches a guard. */
export function asOrgId(orgId: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/.test(orgId)) throw new OrgDropError('bad_id', `not an org id: ${JSON.stringify(orgId)}`)
  return new mongoose.Types.ObjectId(orgId)
}

async function collectionNames(): Promise<string[]> {
  return (await db().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort()
}

/** Collection name → model name, for every model whose documents belong to an org (an `orgId` path). */
function tenantModels(): Map<string, string> {
  const models = new Map<string, string>()
  for (const [name, model] of Object.entries(mongoose.models)) {
    if (model.schema.path('orgId') && !models.has(model.collection.name)) models.set(model.collection.name, name)
  }
  return models
}

/** The org, named by its id AND its slug, homed here. Shared with the CLI's bundle command, so both refuse the same mistakes. */
export async function namedOrg(orgId: string, expectSlug: string): Promise<{ _id: Types.ObjectId; slug: string }> {
  const oid = asOrgId(orgId)
  const org = await db().collection('orgs').findOne({ _id: oid })
  if (!org) throw new OrgDropError('org_missing', `no org ${orgId}`)
  if (org.slug !== expectSlug) throw new OrgDropError('slug_mismatch', `org ${orgId} is ${org.slug}, not ${expectSlug}: nothing was done`)
  try {
    await assertHomeIsHere(orgId, { fresh: true })
  } catch (e) {
    if (e instanceof HomeElsewhereError) throw new OrgDropError('home_elsewhere', `${e.message} Nothing was done.`)
    throw e
  }
  return { _id: oid, slug: expectSlug }
}

/** A copy of `doc` without the fields `PROVENANCE_ONLY` names for its collection, so the rest can be searched for the id. */
function withoutProvenance(collection: string, doc: Record<string, unknown>): Record<string, unknown> {
  const fields = PROVENANCE_ONLY[collection]
  if (!fields) return doc
  const copy = { ...doc }
  for (const field of fields) delete copy[field]
  return copy
}

const REFUSAL_BY_COLLECTION: Record<string, string> = { orgs: 'named_by_org', users: 'named_by_membership', identities: 'named_by_person' }

/**
 * Who outside the org names it: every collection that is not an org's data (the orgs, the people, the registries), and
 * the memberships of other orgs. Matching is case-insensitive, at any depth, in a value or a key (`leaks.ts#namedIds`).
 * A document whose `orgId` is the org is one of its rows, which the row count deals with.
 */
async function namedOutside(oid: Types.ObjectId, names: string[], tenants: Map<string, string>): Promise<number> {
  const ids: ReadonlySet<string> = new Set([String(oid)])
  const notUnder = { orgId: { $nin: [oid, String(oid)] } }
  const named: Array<[string, number]> = []
  let provenance = 0
  for (const name of names) {
    if (tenants.has(name) && name !== 'users') continue
    const filter = name === 'orgs' ? { _id: { $ne: oid } } : notUnder
    let count = 0
    for await (const doc of db().collection(name).find(filter)) {
      if (!namedIds(JSON.stringify(doc), ids).length) continue
      if (namedIds(JSON.stringify(withoutProvenance(name, doc)), ids).length) count++
      else provenance++
    }
    if (count) named.push([name, count])
  }
  if (named.length) {
    const code = REFUSAL_BY_COLLECTION[named[0]![0]] ?? 'named_by_registry'
    throw new OrgDropError(code, `the org is named outside it, and would be left named by nothing: ${named.map(([c, n]) => `${c} ${n}`).join(', ')}`)
  }
  return provenance
}

/** A document's id, written the way a bundle line writes it: from the line's start when it can be read there. */
function idOfLine(line: string): string {
  const fast = /^\{"_id":("[0-9a-f]{24}")[,}]/.exec(line)
  return fast ? fast[1]! : JSON.stringify(JSON.parse(line)._id)
}

/** What the bundle holds, per collection: each document's id and the sha256 of its line. */
async function bundleContents(path: string): Promise<Map<string, Map<string, string>>> {
  const held = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  let index = 0
  for (const line of iterateBundleLines(await readBundlePlain(path))) {
    if (index++ === 0) continue
    if (line.startsWith('{"$collection":')) {
      const model = String(JSON.parse(line).$collection)
      const name = mongoose.models[model]?.collection.name ?? model
      current = held.get(name) ?? new Map()
      held.set(name, current)
      continue
    }
    current?.set(idOfLine(line), digest(line))
  }
  return held
}

/** Every guard, and what the drop would delete, document by document. Reads only. */
export async function planOrgDrop(request: OrgDropRequest): Promise<OrgDropPlan> {
  if (!/^[0-9a-f]{64}$/.test(request.bundleSha256 ?? '')) throw new OrgDropError('bad_sha256', 'the bundle\'s sha256 is 64 hex digits; without it the file is never checked')
  const org = await namedOrg(request.orgId, request.expectSlug)
  const oid = org._id
  const hex = String(oid)

  const live = await db().collection('users').countDocuments({ orgId: oid, $or: [{ isActive: { $ne: false } }, { deactivatedAt: null }] })
  if (live) throw new OrgDropError('active_membership', `${org.slug} has ${live} membership(s) switched on or pending: switch each off (isActive false, with a deactivatedAt)`)
  const invites = await db().collection('invites').countDocuments({ orgId: oid, status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] })
  if (invites) throw new OrgDropError('open_invite', `${org.slug} has ${invites} open invite(s): revoke them first`)

  const names = await collectionNames()
  const tenants = tenantModels()
  const provenance = await namedOutside(oid, names, tenants)

  // What lies under its id, in every collection there is, with a model or without.
  const rows: Record<string, number> = {}
  const operational: string[] = []
  const nodeState: string[] = []
  const counts = await Promise.all(names.map(async name => [name, await db().collection(name).countDocuments({ orgId: { $in: [oid, hex] } })] as const))
  for (const [name, count] of counts) {
    if (!count) continue
    const asString = await db().collection(name).countDocuments({ orgId: hex })
    if (asString) throw new OrgDropError('unbundled_rows', `${name} holds ${asString} row(s) whose orgId is the id as a string: no bundle carries them`)
    const model = tenants.get(name)
    if (!model) throw new OrgDropError('unbundled_rows', `${name} holds ${count} row(s) of ${org.slug} and no model: no bundle carries them`)
    const why = bundleExclusion(model)
    if (why === 'node_state') nodeState.push(`${name} ${count}`)
    if (why === 'operational') operational.push(name)
    rows[name] = count
  }
  if (nodeState.length) {
    throw new OrgDropError('node_state_rows', `${org.slug} has node state (${nodeState.join(', ')}): a home, an address, a node or a move is retired through its own flow, never deleted with the org`)
  }

  const verified = await verifyBundle(request.bundlePath, request.bundleSha256)
  if (!verified.ok || !verified.manifest) throw new OrgDropError('bundle_unverified', `the bundle does not verify: ${verified.problems.slice(0, 2).join('; ')}`)
  const manifest = verified.manifest
  if (manifest.orgId !== hex) throw new OrgDropError('bundle_of_another_org', `the bundle is of org ${manifest.orgId} (${manifest.orgSlug}), not ${hex}`)
  if (manifest.kind !== 'full') throw new OrgDropError('bundle_not_full', `the bundle is a ${manifest.kind} one: only a full bundle is the org's whole data`)

  // Document by document, read raw: a field a model would leave out of a read is a field the bundle may not hold.
  const held = await bundleContents(request.bundlePath)
  const ids: Record<string, RowId[]> = {}
  const operationalDocs: Record<string, Record<string, unknown>[]> = {}
  for (const [name, count] of Object.entries(rows)) {
    if (operational.includes(name)) {
      const docs = await db().collection(name).find({ orgId: oid }).toArray()
      operationalDocs[name] = docs
      ids[name] = docs.map(d => d._id)
      continue
    }
    const bundled = held.get(name) ?? new Map<string, string>()
    const proven: RowId[] = []
    let added = 0
    let changed = 0
    for await (const doc of db().collection(name).find({ orgId: oid })) {
      const was = bundled.get(JSON.stringify(doc._id))
      if (was === undefined) added++
      else if (was !== digest(JSON.stringify(doc))) changed++
      else proven.push(doc._id)
    }
    if (added || changed) throw new OrgDropError('bundle_stale', `${name}: ${added} row(s) not in the bundle, ${changed} changed since it was written: take a new bundle`)
    if (proven.length !== count) throw new OrgDropError('bundle_stale', `${name}: ${count} row(s) counted, ${proven.length} read: rows are being written, take a new bundle when it is quiet`)
    ids[name] = proven
  }

  return {
    org: { id: hex, slug: org.slug },
    bundle: { path: request.bundlePath, sha256: request.bundleSha256, documentCount: verified.documentCount, createdAt: manifest.createdAt },
    rows,
    total: Object.values(rows).reduce((a, b) => a + b, 0),
    operational,
    provenance,
    ids,
    operationalDocs,
  }
}

/** Where the org's file goes: beside the bundle, named after it. */
export const orgDocumentPath = (bundlePath: string) => `${bundlePath.replace(/\.ndjson\.zst$/, '')}-org.json`

/** The org's document without the credentials `SECRET_FIELDS` names, and the paths it left out. */
function withoutSecrets(org: Record<string, unknown>): { doc: Record<string, any>; redacted: string[] } {
  const doc = EJSON.parse(EJSON.stringify(org, { relaxed: false }), { relaxed: false }) as Record<string, any>
  const redacted: string[] = []
  const integrations = doc.settings?.integrations
  for (const [provider, key] of SECRET_FIELDS) {
    if (integrations?.[provider]?.[key] === undefined) continue
    delete integrations[provider][key]
    redacted.push(`settings.integrations.${provider}.${key}`)
  }
  return { doc, redacted }
}

const canonical = (value: unknown): string => EJSON.stringify(value, { relaxed: false })

/**
 * The org's file, written before anything is deleted. If one is already there because an interrupted run wrote it, it is
 * used again when it names this bundle and holds this org's document and every operational record still here. Otherwise
 * nothing is deleted.
 */
async function saveOrgFile(oid: Types.ObjectId, plan: OrgDropPlan, bundlePath: string): Promise<{ path: string; sha256: string; reused: boolean }> {
  const org = await db().collection('orgs').findOne({ _id: oid })
  if (!org) throw new OrgDropError('org_missing', `no org ${plan.org.id}`)
  const { doc, redacted } = withoutSecrets(org)
  const path = orgDocumentPath(bundlePath)
  const text = canonical({ format: SAVED_FORMAT, bundle: { file: basename(bundlePath), sha256: plan.bundle.sha256 }, org: doc, redacted, operational: plan.operationalDocs })
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 })
    return { path, sha256: digest(text), reused: false }
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e
  }
  const existing = await readFile(path, 'utf8')
  let was: any
  try {
    was = EJSON.parse(existing, { relaxed: false })
  } catch {
    throw new OrgDropError('saved_file_differs', `${path} exists and is not an org file: nothing was deleted`)
  }
  const savedDocs = new Set(Object.values(was?.operational ?? {}).flat().map(canonical))
  const same = was?.format === SAVED_FORMAT && was.bundle?.sha256 === plan.bundle.sha256 && canonical(was.org) === canonical(doc) &&
    Object.values(plan.operationalDocs).flat().every(d => savedDocs.has(canonical(d)))
  if (!same) throw new OrgDropError('saved_file_differs', `${path} exists and is not this org's file from this bundle: nothing was deleted`)
  return { path, sha256: digest(existing), reused: true }
}

/** Rows under the id, in any collection, as an ObjectId or as its string. */
async function rowsUnder(oid: Types.ObjectId): Promise<number> {
  const names = await collectionNames()
  const counts = await Promise.all(names.map(name => db().collection(name).countDocuments({ orgId: { $in: [oid, String(oid)] } })))
  return counts.reduce((a, b) => a + b, 0)
}

/**
 * The drop. Without `execute` it is `planOrgDrop` and nothing more. With it: the plan again, the org's file beside the
 * bundle, the proven documents by id (the data first, the operational records last), and the org only once nothing is
 * left under its id.
 */
export async function dropOrg(request: OrgDropRequest & { execute: boolean; log?: (line: string) => void | Promise<void> }): Promise<OrgDropReport> {
  const plan = await planOrgDrop(request)
  if (!request.execute) return { ...plan, execute: false, deleted: {}, left: plan.total, orgDeleted: false }

  const oid = asOrgId(plan.org.id)
  const saved = await saveOrgFile(oid, plan, request.bundlePath)
  await request.log?.(`org file: ${saved.path}${saved.reused ? ' (written by an earlier run, the same)' : ''}`)

  const deleted: Record<string, number> = {}
  const last = (name: string) => Number(plan.operational.includes(name))
  for (const name of Object.keys(plan.rows).sort((a, b) => last(a) - last(b) || a.localeCompare(b))) {
    const ids = plan.ids[name] ?? []
    let count = 0
    for (let i = 0; i < ids.length; i += 1000) {
      count += (await db().collection(name).deleteMany({ orgId: oid, _id: { $in: ids.slice(i, i + 1000) } })).deletedCount
    }
    deleted[name] = count
    await request.log?.(`${name}: ${count} deleted`)
  }

  const left = await rowsUnder(oid)
  if (left) return { ...plan, execute: true, deleted, saved, left, orgDeleted: false }
  await db().collection('orgs').deleteOne({ _id: oid })
  const orgLeft = await db().collection('orgs').countDocuments({ _id: oid })
  return { ...plan, execute: true, deleted, saved, left: orgLeft, orgDeleted: orgLeft === 0 }
}
