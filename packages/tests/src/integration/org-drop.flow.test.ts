import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestOrg, createTestUser } from '../helpers/factories'
import { useTempUploadDir } from '../helpers/upload-path'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { AuditLog, Contact, DigestRun, Identity, Invite, Org, OrgHome, User } from 'db/models'
import { buildBundle } from 'services/biz/backup/backup-bundle.service'
import { OrgDropError, dropOrg, orgDocumentPath, planOrgDrop } from 'services/biz/org-drop/org-drop.service'

/**
 * FR-25 §7: deleting an org for good. It removes only documents a verified full bundle of the org holds with the same
 * content, and only once nobody can sign in to it or join it and nothing outside it points at it.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */
let restoreUploads: (() => void) | undefined

beforeAll(async () => {
  await setupTestDB()
  restoreUploads = useTempUploadDir()
})

afterAll(async () => {
  restoreUploads?.()
  await teardownTestDB()
})

let n = 0
const raw = (name: string) => mongoose.connection.db!.collection(name)

/**
 * An org to drop and one to keep, a person who is a member of both, a few rows each, and a bundle of the first.
 * `setup` runs before the bundle, so whatever it adds is in it.
 */
async function fixture(setup?: (f: { gone: any; member: any }) => Promise<void>) {
  const gone: any = await createTestOrg()
  const kept: any = await createTestOrg()
  const person: any = await Identity.create({
    email: `org-drop-${++n}-${Date.now()}@example.test`, firstName: 'А', lastName: 'Б', passwordSetBy: 'admin', passwordSetByOrgId: gone._id,
  })
  const member = await createTestUser(gone._id)
  await User.updateOne({ _id: member._id }, { $set: { identityId: person._id, isActive: false, deactivatedAt: new Date() } })
  const elsewhere = await createTestUser(kept._id)
  await User.updateOne({ _id: elsewhere._id }, { $set: { identityId: person._id } })
  await createTestContact(gone._id)
  await createTestContact(gone._id)
  await createTestContact(kept._id)
  await AuditLog.create({ orgId: gone._id, action: 'update', module: 'settings', entityType: 'org', entityId: gone._id, via: 'scripts/org-drop-test' })
  await setup?.({ gone, member })
  const bundle = await buildBundle(String(gone._id), { kind: 'full', date: '2026-11-20', subdir: 'pre-drop', filenameSuffix: `pre-drop-${n}` })
  const request = { orgId: String(gone._id), expectSlug: gone.slug as string, bundlePath: bundle.absolutePath, bundleSha256: bundle.sha256 }
  return { gone, kept, person, member, elsewhere, request }
}

/** The refusal's code, after proving it was one. */
async function refusal(p: Promise<unknown>): Promise<string> {
  const error = await captureRejection(p)
  expectRejection(error, OrgDropError)
  return (error as OrgDropError).code
}

describe('dropping an org (FR-25 §7)', () => {
  it('a dry run applies every guard, says what would go, and deletes nothing', async () => {
    const { gone, request } = await fixture()
    const report = await dropOrg({ ...request, execute: false })
    expect(report.execute).toBe(false)
    expect(report.rows).toMatchObject({ contacts: 2, users: 1, auditlogs: 1 })
    expect(report.operational).toEqual([])
    expect(report.provenance).toBe(1)
    expect(report.deleted).toEqual({})
    expect(report.orgDeleted).toBe(false)
    expect(report.ids.contacts).toHaveLength(2)
    expect(await Contact.countDocuments({ orgId: gone._id })).toBe(2)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(1)
  })

  it('names the org twice, and checks the bundle\'s sha256 is one: a wrong slug, a malformed id or an empty sha256 is refused', async () => {
    const { kept, request } = await fixture()
    expect(await refusal(planOrgDrop({ ...request, expectSlug: kept.slug }))).toBe('slug_mismatch')
    expect(await refusal(planOrgDrop({ ...request, orgId: 'not-an-org-id' }))).toBe('bad_id')
    expect(await refusal(planOrgDrop({ ...request, orgId: String(new mongoose.Types.ObjectId()) }))).toBe('org_missing')
    // An empty sha256 would make the bundle check skip the file's hash.
    expect(await refusal(planOrgDrop({ ...request, bundleSha256: '' }))).toBe('bad_sha256')
    expect(await refusal(planOrgDrop({ ...request, bundleSha256: request.bundleSha256.toUpperCase() }))).toBe('bad_sha256')
  })

  it('refuses an org homed on another node', async () => {
    const { gone, request } = await fixture()
    await OrgHome.create({ orgId: gone._id, home: 'node-shop-1', epoch: 1, state: 'active' })
    expect(await refusal(planOrgDrop(request))).toBe('home_elsewhere')
  })

  it('refuses while anyone can still sign in to it or join it: a membership on or pending, an open invite', async () => {
    const on = await fixture()
    await User.updateOne({ _id: on.member._id }, { $set: { isActive: true } })
    expect(await refusal(planOrgDrop(on.request))).toBe('active_membership')

    // Switched off without a `deactivatedAt` is pending, and a password reset switches it on.
    const pending = await fixture()
    await User.collection.updateOne({ _id: pending.member._id }, { $unset: { deactivatedAt: 1 } })
    expect(await refusal(planOrgDrop(pending.request))).toBe('active_membership')

    const invited = await fixture()
    await Invite.create({ code: `drop-${++n}`, orgId: invited.gone._id, inviterId: invited.member._id, status: 'active' })
    expect(await refusal(planOrgDrop(invited.request))).toBe('open_invite')

    // An invite that has expired, or was revoked, lets nobody in.
    const closed = await fixture(async ({ gone, member }) => {
      await Invite.create({ code: `drop-${++n}`, orgId: gone._id, inviterId: member._id, status: 'active', expiresAt: new Date(Date.now() - 60_000) })
      await Invite.create({ code: `drop-${++n}`, orgId: gone._id, inviterId: member._id, status: 'revoked' })
    })
    expect((await planOrgDrop(closed.request)).rows.invites).toBe(2)
  })

  it('refuses while another org, a membership of another org, a person or a registry names it; a provenance field may stay', async () => {
    const { gone, kept, person, elsewhere, request } = await fixture()
    await Org.collection.updateOne({ _id: kept._id }, { $set: { 'settings.accounting.books': { mode: 'branch', booksOrgId: gone._id, branchCode: 'X' } } })
    expect(await refusal(planOrgDrop(request))).toBe('named_by_org')
    await Org.collection.updateOne({ _id: kept._id }, { $unset: { 'settings.accounting.books': 1 } })

    await User.collection.updateOne({ _id: elsewhere._id }, { $set: { [`orgNotes.${String(gone._id)}`]: 1 } })
    expect(await refusal(planOrgDrop(request))).toBe('named_by_membership')
    await User.collection.updateOne({ _id: elsewhere._id }, { $unset: { orgNotes: 1 } })

    await Identity.collection.updateOne({ _id: person._id }, { $set: { lastOrgId: gone._id } })
    expect(await refusal(planOrgDrop(request))).toBe('named_by_person')
    await Identity.collection.updateOne({ _id: person._id }, { $unset: { lastOrgId: 1 } })

    // A collection of no org at all, naming it in capitals: still a name.
    await raw('org_drop_registry').insertOne({ node: 'n1', serves: [String(gone._id).toUpperCase()] })
    expect(await refusal(planOrgDrop(request))).toBe('named_by_registry')
    await raw('org_drop_registry').deleteMany({})

    // Who set the password is history: it keeps naming the org, and nothing reads it.
    expect((await planOrgDrop(request)).provenance).toBe(1)
  })

  it('needs a verified full bundle of exactly this org', async () => {
    const { gone, kept, request } = await fixture()
    expect(await refusal(planOrgDrop({ ...request, bundleSha256: '0'.repeat(64) }))).toBe('bundle_unverified')
    const other = await buildBundle(String(kept._id), { kind: 'full', date: '2026-11-20', subdir: 'pre-drop', filenameSuffix: 'other' })
    expect(await refusal(planOrgDrop({ ...request, bundlePath: other.absolutePath, bundleSha256: other.sha256 }))).toBe('bundle_of_another_org')
    const delta = await buildBundle(String(gone._id), { kind: 'delta', date: '2026-11-20', subdir: 'pre-drop', filenameSuffix: 'delta' })
    expect(await refusal(planOrgDrop({ ...request, bundlePath: delta.absolutePath, bundleSha256: delta.sha256 }))).toBe('bundle_not_full')
  })

  it('holds every live row with the same content: an added, a changed or a swapped row stops it, a deleted one does not', async () => {
    const added = await fixture()
    await createTestContact(added.gone._id)
    expect(await refusal(planOrgDrop(added.request))).toBe('bundle_stale')

    const changed = await fixture()
    await Contact.collection.updateOne({ orgId: changed.gone._id }, { $set: { notes: 'written after the bundle' } })
    expect(await refusal(planOrgDrop(changed.request))).toBe('bundle_stale')

    // The count is the same, the rows are not.
    const swapped = await fixture()
    await Contact.collection.deleteOne({ orgId: swapped.gone._id })
    await createTestContact(swapped.gone._id)
    expect(await Contact.countDocuments({ orgId: swapped.gone._id })).toBe(2)
    expect(await refusal(planOrgDrop(swapped.request))).toBe('bundle_stale')

    const deleted = await fixture()
    await Contact.deleteMany({ orgId: deleted.gone._id })
    expect((await planOrgDrop(deleted.request)).rows.contacts).toBeUndefined()
  })

  it('refuses rows no bundle carries: a collection without a model, an org id stored as a string, node state', async () => {
    const { gone, request } = await fixture()
    await raw('org_drop_strays').insertOne({ orgId: gone._id })
    expect(await refusal(planOrgDrop(request))).toBe('unbundled_rows')
    await raw('org_drop_strays').deleteMany({})

    await Contact.collection.insertOne({ orgId: String(gone._id) } as never)
    expect(await refusal(planOrgDrop(request))).toBe('unbundled_rows')
    await Contact.collection.deleteMany({ orgId: String(gone._id) } as never)

    // Its home row, here: retired through its own flow, never deleted with the org.
    await OrgHome.create({ orgId: gone._id, home: 'global', epoch: 0, state: 'active' })
    expect(await refusal(planOrgDrop(request))).toBe('node_state_rows')
  })

  it('deletes every row of the org and the org, keeps its file beside the bundle without its tokens, and touches nothing else', async () => {
    const { gone, kept, person, request } = await fixture()
    await Org.collection.updateOne({ _id: gone._id }, { $set: { 'settings.integrations.googleDrive': { folderId: 'f-1', accessToken: 'secret-access', refreshToken: 'secret-refresh' } } })
    await DigestRun.collection.insertOne({ orgId: gone._id, date: '2026-11-19', claimedAt: new Date() })
    const before = { kept: await Contact.countDocuments({ orgId: kept._id }), people: await Identity.countDocuments() }

    const report = await dropOrg({ ...request, execute: true })
    expect(report.orgDeleted).toBe(true)
    expect(report.left).toBe(0)
    expect(report.operational).toEqual(['digestruns'])
    expect(report.deleted).toEqual(report.rows)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(0)
    for (const name of Object.keys(report.rows)) expect(await raw(name).countDocuments({ orgId: gone._id })).toBe(0)

    // The other org, the person and their other membership are as they were.
    expect(await Org.countDocuments({ _id: kept._id })).toBe(1)
    expect(await Contact.countDocuments({ orgId: kept._id })).toBe(before.kept)
    expect(await Identity.countDocuments()).toBe(before.people)
    expect(await User.countDocuments({ identityId: person._id })).toBe(1)

    // What no bundle carries is beside the bundle: the org's document, without its tokens, and its operational records.
    const path = orgDocumentPath(request.bundlePath)
    expect(report.saved).toMatchObject({ path, reused: false })
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('secret-access')
    expect(text).not.toContain('secret-refresh')
    const saved: any = mongoose.mongo.BSON.EJSON.parse(text)
    expect([String(saved.org._id), saved.org.slug, saved.org.settings.integrations.googleDrive.folderId]).toEqual([String(gone._id), gone.slug, 'f-1'])
    expect(saved.redacted).toEqual(['settings.integrations.googleDrive.accessToken', 'settings.integrations.googleDrive.refreshToken'])
    expect(saved.operational.digestruns).toHaveLength(1)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)

    // Gone is gone: a second run finds no org.
    expect(await refusal(dropOrg({ ...request, execute: true }))).toBe('org_missing')
  })

  it('a drop that stopped part way runs again with the same bundle, and reuses the file it wrote', async () => {
    const { gone, request } = await fixture()
    const stop = new Error('the connection dropped')
    let deletions = 0
    const error = await captureRejection(dropOrg({ ...request, execute: true, log: line => { if (line.endsWith(' deleted') && ++deletions === 1) throw stop } }))
    expect(error).toBe(stop)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(1)

    const again = await dropOrg({ ...request, execute: true })
    expect(again.saved?.reused).toBe(true)
    expect(again.orgDeleted).toBe(true)
    expect(await Contact.countDocuments({ orgId: gone._id })).toBe(0)
  })

  it('never writes over a file it did not write, and deletes nothing then', async () => {
    const { gone, request } = await fixture()
    writeFileSync(orgDocumentPath(request.bundlePath), '{"format":"something else"}')
    expect(await refusal(dropOrg({ ...request, execute: true }))).toBe('saved_file_differs')
    expect(await Contact.countDocuments({ orgId: gone._id })).toBe(2)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(1)
  })

  it('deletes only the rows it proved: one written after the check stays, and so does the org', async () => {
    const { gone, request } = await fixture()
    const report = await dropOrg({
      ...request,
      execute: true,
      log: async line => { if (line.startsWith('org file:')) await createTestContact(gone._id) },
    })
    expect(report.orgDeleted).toBe(false)
    expect(report.left).toBe(1)
    expect(await Contact.countDocuments({ orgId: gone._id })).toBe(1)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(1)
    // The late row is in no bundle, so the next run stops until a new bundle holds it.
    expect(await refusal(planOrgDrop(request))).toBe('bundle_stale')
  })
})
