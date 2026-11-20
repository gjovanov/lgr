import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestOrg, createTestUser } from '../helpers/factories'
import { useTempUploadDir } from '../helpers/upload-path'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { AuditLog, Contact, Identity, Org, User } from 'db/models'
import { buildBundle } from 'services/biz/backup/backup-bundle.service'
import { OrgDropError, dropOrg, orgDocumentPath, planOrgDrop } from 'services/biz/org-drop/org-drop.service'

/**
 * FR-25 §7: deleting an org for good. It removes only what a verified full bundle of the org already holds, and only
 * once nobody can sign in to it and nothing outside it points at it.
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

/** An org to drop and one to keep, a person who is a member of both, a few rows each, and a bundle of the first. */
async function fixture() {
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
  const bundle = await buildBundle(String(gone._id), { kind: 'full', date: '2026-11-20', subdir: 'pre-drop', filenameSuffix: 'pre-drop' })
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
    expect(report.notBundled).toEqual([])
    expect(report.provenance).toBe(1)
    expect(report.deleted).toEqual({})
    expect(await Contact.countDocuments({ orgId: gone._id })).toBe(2)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(1)
  })

  it('names the org twice: its id with another org\'s slug is refused, and so is a malformed id', async () => {
    const { kept, request } = await fixture()
    expect(await refusal(planOrgDrop({ ...request, expectSlug: kept.slug }))).toBe('slug_mismatch')
    expect(await refusal(planOrgDrop({ ...request, orgId: 'not-an-org-id' }))).toBe('bad_id')
    expect(await refusal(planOrgDrop({ ...request, orgId: String(new mongoose.Types.ObjectId()) }))).toBe('org_missing')
  })

  it('refuses while anyone can still sign in to it', async () => {
    const { member, request } = await fixture()
    await User.updateOne({ _id: member._id }, { $set: { isActive: true } })
    expect(await refusal(planOrgDrop(request))).toBe('active_membership')
  })

  it('refuses while another org, a membership of another org or a person points at it; a provenance field may stay', async () => {
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

    // Who set the password is history: it keeps naming the org, and nothing reads it.
    expect((await planOrgDrop(request)).provenance).toBe(1)
  })

  it('needs a verified full bundle of exactly this org, holding at least every row the org has now', async () => {
    const { gone, kept, request } = await fixture()
    expect(await refusal(planOrgDrop({ ...request, bundleSha256: '0'.repeat(64) }))).toBe('bundle_unverified')
    const other = await buildBundle(String(kept._id), { kind: 'full', date: '2026-11-20', subdir: 'pre-drop', filenameSuffix: 'other' })
    expect(await refusal(planOrgDrop({ ...request, bundlePath: other.absolutePath, bundleSha256: other.sha256 }))).toBe('bundle_of_another_org')

    await createTestContact(gone._id)
    expect(await refusal(planOrgDrop(request))).toBe('bundle_stale')
    // A row deleted since the bundle is still in it: that is no reason to stop.
    await Contact.deleteMany({ orgId: gone._id })
    expect((await planOrgDrop(request)).rows.contacts).toBeUndefined()
  })

  it('refuses rows no bundle carries: a collection without a model, an org id stored as a string', async () => {
    const { gone, request } = await fixture()
    const stray = mongoose.connection.db!.collection('org_drop_strays')
    await stray.insertOne({ orgId: gone._id })
    expect(await refusal(planOrgDrop(request))).toBe('unbundled_rows')
    await stray.deleteMany({})

    await Contact.collection.insertOne({ orgId: String(gone._id) } as any)
    expect(await refusal(planOrgDrop(request))).toBe('unbundled_rows')
    await Contact.collection.deleteMany({ orgId: String(gone._id) } as any)
  })

  it('deletes every row of the org and the org, keeps its document beside the bundle, and touches nothing else', async () => {
    const { gone, kept, person, request } = await fixture()
    const before = { kept: await Contact.countDocuments({ orgId: kept._id }), people: await Identity.countDocuments() }

    const report = await dropOrg({ ...request, execute: true })
    expect(report.left).toBe(0)
    expect(Object.values(report.deleted).reduce((a, b) => a + b, 0)).toBe(report.total)
    expect(await Org.countDocuments({ _id: gone._id })).toBe(0)
    for (const name of Object.keys(report.rows)) expect(await mongoose.connection.db!.collection(name).countDocuments({ orgId: gone._id })).toBe(0)

    // The other org, the person and their other membership are as they were.
    expect(await Org.countDocuments({ _id: kept._id })).toBe(1)
    expect(await Contact.countDocuments({ orgId: kept._id })).toBe(before.kept)
    expect(await Identity.countDocuments()).toBe(before.people)
    expect(await User.countDocuments({ identityId: person._id })).toBe(1)

    // What no bundle carries, the org's own document, is beside the bundle.
    const saved: any = mongoose.mongo.BSON.EJSON.parse(readFileSync(orgDocumentPath(request.bundlePath), 'utf8'))
    expect([String(saved._id), saved.slug]).toEqual([String(gone._id), gone.slug])
    expect(report.orgDocument?.path).toBe(orgDocumentPath(request.bundlePath))

    // Gone is gone: a second run finds no org, and never writes over the saved document.
    expect(await refusal(dropOrg({ ...request, execute: true }))).toBe('org_missing')
  })
})
