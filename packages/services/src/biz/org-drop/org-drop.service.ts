import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { Types } from 'mongoose'
import { mongoose } from 'db/connection'
import { assertHomeIsHere, HomeElsewhereError } from 'db/home/home'
import { bundleExclusion, verifyBundle } from '../backup/backup-bundle.service'

/**
 * Deleting an organisation for good: every row under its `orgId`, then the org itself (FR-25 §7, 2026-11-20).
 *
 * The app never deletes an org. This is for the one case its owner orders it, once its data lives elsewhere, and it can
 * remove only what a verified backup bundle already holds:
 * - the org is named twice, by slug and by id, and both must match;
 * - its home is this server (FR-20.4): the deletes go through the driver, which no write guard sees;
 * - nobody can sign in to it: every membership is switched off;
 * - nothing outside it names it: no other org, no membership of another org, no person. The one exception is
 *   `PROVENANCE_ONLY`, a record of where something came from that nothing reads;
 * - a FULL bundle of exactly this org verifies against the sha256 it was written with, and holds at least as many rows
 *   as the org holds now in each collection. A row written after the bundle stops the drop; one deleted since does not,
 *   since the bundle still holds it, which is also what lets an interrupted drop run again;
 * - a row in a collection no bundle carries stops it, unless the bundle leaves that collection out on purpose
 *   (`bundleExclusion`: operational records and node state, which are about the org and not its data).
 *
 * The people (`Identity`) are global and stay: the bundle carries them, and a restore only ever inserts a missing one.
 * The bundle does not carry the org's own document, so the drop writes it beside the bundle first.
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
  /** Collections of `rows` that a bundle leaves out on purpose (operational records, node state). */
  notBundled: string[]
  /** Documents outside the org that name it only in a `PROVENANCE_ONLY` field, and keep naming it. */
  provenance: number
}

export interface OrgDropReport extends OrgDropPlan {
  execute: boolean
  deleted: Record<string, number>
  /** The org's own document, as canonical extended JSON beside the bundle. Written before anything is deleted. */
  orgDocument?: { path: string; sha256: string }
  /** Rows still under the org's id after the drop, plus one if its document is still there. Nothing but 0 is done. */
  left: number
}

const db = () => {
  const handle = mongoose.connection.db
  if (!handle) throw new OrgDropError('not_connected', 'no database connection')
  return handle
}

function asOid(orgId: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/.test(orgId)) throw new OrgDropError('bad_id', `not an org id: ${JSON.stringify(orgId)}`)
  return new mongoose.Types.ObjectId(orgId)
}

/** The org, named by its id AND its slug. Shared with the CLI's bundle command, so both refuse the same mistakes. */
export async function namedOrg(orgId: string, expectSlug: string): Promise<{ _id: Types.ObjectId; slug: string }> {
  const oid = asOid(orgId)
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

/** Drop the fields `PROVENANCE_ONLY` names for this collection, so what is left can be searched for the id. */
function withoutProvenance(collection: string, doc: Record<string, unknown>): Record<string, unknown> {
  const fields = PROVENANCE_ONLY[collection]
  if (!fields) return doc
  const copy = { ...doc }
  for (const field of fields) delete copy[field]
  return copy
}

/** Documents of `collection` matching `filter` that name `hex` anywhere: a value or a key, at any depth. */
async function naming(collection: string, filter: Record<string, unknown>, hex: string): Promise<{ naming: number; provenance: number }> {
  let count = 0
  let provenance = 0
  for await (const doc of db().collection(collection).find(filter)) {
    if (!JSON.stringify(doc).includes(hex)) continue
    if (JSON.stringify(withoutProvenance(collection, doc)).includes(hex)) count++
    else provenance++
  }
  return { naming: count, provenance }
}

/** Every guard, and what the drop would delete. Reads only. */
export async function planOrgDrop(request: OrgDropRequest): Promise<OrgDropPlan> {
  const org = await namedOrg(request.orgId, request.expectSlug)
  const oid = org._id
  const hex = String(oid)

  const active = await db().collection('users').countDocuments({ orgId: oid, isActive: { $ne: false } })
  if (active) throw new OrgDropError('active_membership', `${org.slug} has ${active} membership(s) still switched on: switch them off first`)

  const others = await naming('orgs', { _id: { $ne: oid } }, hex)
  if (others.naming) throw new OrgDropError('named_by_org', `${others.naming} other org(s) name ${org.slug}: a split, a branch or a link would be left pointing at nothing`)
  const memberships = await naming('users', { orgId: { $ne: oid } }, hex)
  if (memberships.naming) throw new OrgDropError('named_by_membership', `${memberships.naming} membership(s) of other orgs name ${org.slug}`)
  const people = await naming('identities', {}, hex)
  if (people.naming) throw new OrgDropError('named_by_person', `${people.naming} person record(s) name ${org.slug} in a field something reads (a last org, a link)`)

  // What lies under its id, in every collection there is, with or without a model.
  const models = new Map<string, string>()
  for (const [name, model] of Object.entries(mongoose.models)) if (model.schema.path('orgId')) models.set(model.collection.name, name)
  const names = (await db().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort()
  const rows: Record<string, number> = {}
  const notBundled: string[] = []
  for (const name of names) {
    const asString = await db().collection(name).countDocuments({ orgId: hex })
    if (asString) throw new OrgDropError('unbundled_rows', `${name} holds ${asString} row(s) whose orgId is the id as a string: no bundle carries them`)
    const count = await db().collection(name).countDocuments({ orgId: oid })
    if (!count) continue
    const model = models.get(name)
    if (!model) throw new OrgDropError('unbundled_rows', `${name} holds ${count} row(s) of ${org.slug} and no model: no bundle carries them`)
    if (bundleExclusion(model)) notBundled.push(name)
    rows[name] = count
  }

  const verified = await verifyBundle(request.bundlePath, request.bundleSha256)
  if (!verified.ok || !verified.manifest) throw new OrgDropError('bundle_unverified', `the bundle does not verify: ${verified.problems.slice(0, 2).join('; ')}`)
  const manifest = verified.manifest
  if (manifest.orgId !== hex) throw new OrgDropError('bundle_of_another_org', `the bundle is of org ${manifest.orgId} (${manifest.orgSlug}), not ${hex}`)
  if (manifest.kind !== 'full') throw new OrgDropError('bundle_not_full', `the bundle is a ${manifest.kind} one: only a full bundle holds everything`)
  for (const [name, count] of Object.entries(rows)) {
    if (notBundled.includes(name)) continue
    const held = manifest.collections.find(c => c.collection === name)?.count ?? 0
    if (count > held) throw new OrgDropError('bundle_stale', `${name}: ${count} row(s) now, ${held} in the bundle: take a new bundle`)
  }

  const total = Object.values(rows).reduce((a, b) => a + b, 0)
  return {
    org: { id: hex, slug: org.slug },
    bundle: { path: request.bundlePath, sha256: request.bundleSha256, documentCount: verified.documentCount, createdAt: manifest.createdAt },
    rows,
    total,
    notBundled,
    provenance: others.provenance + memberships.provenance + people.provenance,
  }
}

/** Where the org's own document goes: beside the bundle, named after it. */
export const orgDocumentPath = (bundlePath: string) => `${bundlePath.replace(/\.ndjson\.zst$/, '')}-org.json`

/**
 * The drop. Without `execute` it is `planOrgDrop` and nothing more. With it: the guards again, the org's document beside
 * the bundle (never over an existing file), every row under its id, then the org, then a count of what is left.
 */
export async function dropOrg(request: OrgDropRequest & { execute: boolean; log?: (line: string) => void }): Promise<OrgDropReport> {
  const plan = await planOrgDrop(request)
  if (!request.execute) return { ...plan, execute: false, deleted: {}, left: plan.total + 1 }

  const oid = asOid(plan.org.id)
  const org = await db().collection('orgs').findOne({ _id: oid })
  const text = mongoose.mongo.BSON.EJSON.stringify(org, { relaxed: false })
  const path = orgDocumentPath(request.bundlePath)
  await writeFile(path, text, { flag: 'wx' })
  const orgDocument = { path, sha256: createHash('sha256').update(text).digest('hex') }
  request.log?.(`org document: ${path}`)

  const deleted: Record<string, number> = {}
  for (const name of Object.keys(plan.rows)) {
    deleted[name] = (await db().collection(name).deleteMany({ orgId: oid })).deletedCount
    request.log?.(`${name}: ${deleted[name]} deleted`)
  }
  await db().collection('orgs').deleteOne({ _id: oid })

  let left = (await db().collection('orgs').countDocuments({ _id: oid }))
  for (const name of (await db().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.'))) {
    left += await db().collection(name).countDocuments({ orgId: { $in: [oid, plan.org.id] } })
  }
  return { ...plan, execute: true, deleted, orgDocument, left }
}
