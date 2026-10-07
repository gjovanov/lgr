import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { config } from 'config'
import { BackupRun, Contact, Identity, User } from 'db/models'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { inspectBundle, applyRestore } from 'services/biz/backup/backup-restore.service'
import { bundleDir, iterateBundleLines, readBundlePlain } from 'services/biz/backup/backup-bundle.service'
import { login } from 'services/biz/auth.service'

/**
 * Multi-org sign-in: the PEOPLE are in the backups.
 *
 * `Identity` is global (no `orgId`), so the per-org bundles used to leave it out. While every
 * `User` still carried its legacy password copy that did not matter. Once those copies are removed
 * (Release D), a bundle without its people restores memberships that nobody can sign in to. So
 * each org's bundle carries the people its users point at, and a restore puts back only the
 * missing ones: never deleting, never changing, never remapping a person who exists, because the
 * same person belongs to orgs the restore is not about.
 *
 * NOTE: no `.rejects` / `.resolves` (the Bun-on-Windows deadlock): failures are caught with
 * try/catch.
 */

let TMP = ''

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-people-'))
  config.upload.dir = TMP
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const DAY = '2026-10-07'
const PASSWORD = 'correct horse battery'

async function org(slug: string) {
  const o = await createTestOrg({ slug } as any)
  const orgId = String(o._id as Types.ObjectId)
  // The operator acting in the restore: an ordinary, unlinked admin.
  const admin = await createTestUser(o._id as Types.ObjectId, { email: `${slug}-admin@people.test`, role: 'admin' } as any)
  return { org: o, orgId, actor: { userId: String(admin._id), email: `${slug}-admin@people.test` } }
}

/** A person with a password of their own, a member of every org given. */
async function person(email: string, orgIds: string[]) {
  const identity: any = await Identity.create({
    email,
    password: await Bun.password.hash(PASSWORD),
    passwordSetBy: 'self',
    emailVerified: true,
    firstName: 'Ana',
    lastName: 'Petrova',
  })
  const members: any[] = []
  for (const orgId of orgIds) {
    members.push(await createTestUser(orgId as any, { email, identityId: identity._id, role: 'manager' } as any))
  }
  return { identity, members }
}

async function bundleOf(orgId: string) {
  const outcome = await runBackupForOrg(orgId, DAY, { kind: 'full' })
  expect(outcome?.status).toBe('completed')
  const run: any = await BackupRun.findOne({ orgId, date: DAY }).lean().exec()
  return { run, absolutePath: join(bundleDir(orgId), run.filename) }
}

/** The documents of one section of a bundle, parsed. */
async function section(absolutePath: string, name: string): Promise<any[]> {
  const out: any[] = []
  let current = ''
  for (const line of iterateBundleLines(await readBundlePlain(absolutePath))) {
    if (line.startsWith('{"$collection":')) { current = JSON.parse(line).$collection; continue }
    if (current === name) out.push(JSON.parse(line))
  }
  return out
}

const passwordOf = async (id: unknown) => ((await Identity.findById(id).select('+password').lean().exec()) as any)?.password

describe('the bundle carries its people', () => {
  it('includes the people its memberships point at, with their password, and nobody else', async () => {
    const a = await org('people-a')
    const b = await org('people-b')
    const ana = await person('ana@people.test', [a.orgId])
    await person('boris@people.test', [b.orgId])

    const { run, absolutePath } = await bundleOf(a.orgId)
    expect(run.collections.find((c: any) => c.name === 'Identity')?.count).toBe(1)

    const people = await section(absolutePath, 'Identity')
    expect(people.map(p => p.email)).toEqual(['ana@people.test'])
    // `password` is `select: false` on the model; a backup that honoured that would restore people
    // who cannot sign in.
    expect(people[0].password).toBe(await passwordOf(ana.identity._id))
  })

  it('carries a person who works in two orgs in both orgs\' bundles', async () => {
    const a = await org('both-a')
    const b = await org('both-b')
    await person('mila@people.test', [a.orgId, b.orgId])

    for (const o of [a, b]) {
      const { absolutePath } = await bundleOf(o.orgId)
      expect((await section(absolutePath, 'Identity')).map(p => p.email)).toEqual(['mila@people.test'])
    }
  })

  it('has no people section when no membership is linked to a person', async () => {
    const a = await org('nobody-a')
    const { run } = await bundleOf(a.orgId)
    expect(run.collections.some((c: any) => c.name === 'Identity')).toBe(false)
  })
})

describe('a restore puts back missing people, and never touches present ones', () => {
  it('brings back a lost person, who can then sign in with their own password', async () => {
    const a = await org('lost-a')
    const ana = await person('ana.lost@people.test', [a.orgId])
    const { run } = await bundleOf(a.orgId)

    await Identity.deleteOne({ _id: ana.identity._id }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, a.actor)
    const row = inspection.collections.find((c: any) => c.name === 'Identity')
    expect(row).toMatchObject({ inBundle: 1, inLive: 0, missing: 1 })
    expect(await Identity.countDocuments({ _id: ana.identity._id })).toBe(0) // Inspect writes nothing

    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: a.actor,
    })
    expect(applied.status).toBe('completed')
    expect(applied.collections.find((c: any) => c.name === 'Identity')).toMatchObject({ inserted: 1, deleted: 0 })

    // The same person, under the same id, with the same password...
    expect(await Bun.password.verify(PASSWORD, String(await passwordOf(ana.identity._id)))).toBe(true)
    // ...and no session from before they were lost: a token carrying the old version is dead.
    expect(((await Identity.findById(ana.identity._id).lean().exec()) as any).tokenVersion).toBe(1)
    const signedIn = await login({ username: 'ana.lost@people.test', password: PASSWORD })
    expect(signedIn.kind).toBe('session')
    if (signedIn.kind === 'session') expect(String(signedIn.org._id)).toBe(a.orgId)
  })

  it('Replace leaves a live person exactly as they are now, and their other orgs alone', async () => {
    const a = await org('keep-a')
    const b = await org('keep-b')
    const mila = await person('mila.keep@people.test', [a.orgId, b.orgId])
    const { run } = await bundleOf(a.orgId)

    // After the backup the person changed their password, which ended their old sessions.
    const changed = await Bun.password.hash('a newer passphrase')
    await Identity.updateOne({ _id: mila.identity._id }, { $set: { password: changed }, $inc: { tokenVersion: 1 } }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, a.actor)
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'replace', confirmSlug: 'keep-a', inspectionId: String(inspection._id), actor: a.actor,
    })
    expect(applied.status).toBe('completed')

    const live: any = await Identity.findById(mila.identity._id).select('+password').lean().exec()
    expect(live.password).toBe(changed) // not the bundle's older hash
    expect(live.tokenVersion).toBe(1) // sessions the change ended stay ended
    expect(await User.countDocuments({ identityId: mila.identity._id, orgId: b.orgId })).toBe(1)
    expect(await User.countDocuments({ identityId: mila.identity._id, orgId: a.orgId })).toBe(1)
  })

  it('a remapped copy keeps its people: the copied memberships belong to the same person', async () => {
    const target = await org('remap-target')
    const origin = await org('remap-origin')
    const vera = await person('vera@people.test', [origin.orgId])
    const { absolutePath } = await bundleOf(origin.orgId)

    // Staged under the target's own backup directory, as an uploaded bundle would be.
    const { mkdirSync, copyFileSync } = await import('node:fs')
    const staged = join(bundleDir(target.orgId), 'uploads', 'from-origin.ndjson.zst')
    mkdirSync(join(bundleDir(target.orgId), 'uploads'), { recursive: true })
    copyFileSync(absolutePath, staged)

    const peopleBefore = await Identity.countDocuments({})
    const inspection: any = await inspectBundle(target.orgId, { type: 'path', path: staged }, target.actor)
    const applied: any = await applyRestore(target.orgId, { type: 'path', path: staged }, {
      mode: 'merge', remap: true, inspectionId: String(inspection._id), actor: target.actor,
    })
    expect(applied.status).toBe('completed')

    // No second record of the person was made...
    expect(await Identity.countDocuments({})).toBe(peopleBefore)
    // ...and the membership copied into the target is hers, under a new membership id.
    const copied: any = await User.findOne({ orgId: target.orgId, identityId: vera.identity._id }).lean().exec()
    expect(copied).toBeTruthy()
    expect(String(copied._id)).not.toBe(String(vera.members[0]._id))
  })

  it('refuses to make a second record of someone who now exists under another one', async () => {
    const a = await org('dup-a')
    const old = await person('iva@people.test', [a.orgId])
    const { run } = await bundleOf(a.orgId)

    // The person was removed and came back as a new record with the same address.
    await Identity.deleteOne({ _id: old.identity._id }).exec()
    const again: any = await Identity.create({ email: 'iva@people.test', firstName: 'Iva', lastName: 'Ivanova' })

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, a.actor)
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: a.actor,
    })
    expect(applied.status).toBe('completed')
    expect(await Identity.countDocuments({ email: 'iva@people.test' })).toBe(1)
    expect(await Identity.countDocuments({ _id: again._id })).toBe(1)
    expect(applied.warnings.some((w: string) => /need relinking/.test(w))).toBe(true)
  })

  it('a restore that fails part-way removes the people it added, and nobody else', async () => {
    const a = await org('undo-a')
    const b = await org('undo-b')
    const ana = await person('ana.undo@people.test', [a.orgId])
    const boris = await person('boris.undo@people.test', [b.orgId])
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Изтрит' } as any)
    const { run } = await bundleOf(a.orgId)

    await Identity.deleteOne({ _id: ana.identity._id }).exec()
    await Contact.deleteMany({ orgId: a.orgId }).exec()

    // People are restored first; then the contacts' insert fails, once, the way a full disk
    // would. The rollback's own re-insert goes through.
    const collection: any = Contact.collection
    const original = collection.insertMany
    let calls = 0
    collection.insertMany = function (this: any, ...args: any[]) {
      if (calls++ === 0) throw new Error('simulated: no space left on device')
      return original.apply(this, args)
    }

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, a.actor)
    let caught: any = null
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'merge', inspectionId: String(inspection._id), actor: a.actor,
      })
    } catch (e: any) {
      caught = e
    } finally {
      collection.insertMany = original
    }

    expect(caught?.rolledBack).toBe(true)
    expect(String(caught?.rollbackDetail)).toContain('Identity: 1 added by this restore removed')
    // Back to how it was before the restore: Ana still absent, Boris (another org) untouched.
    expect(await Identity.countDocuments({ _id: ana.identity._id })).toBe(0)
    expect(await Identity.countDocuments({ _id: boris.identity._id })).toBe(1)
  })
})
