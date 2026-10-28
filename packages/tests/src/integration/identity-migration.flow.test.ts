import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import {
  planIdentityMigration,
  loadMigrationInput,
  executeIdentityMigration,
  rollbackIdentityMigration,
  normalizeEmail,
} from 'services/biz/identity/identity-migration.service'
import { Identity, User } from 'db/models'
import type { Types } from 'mongoose'

/**
 * Phase 1 of the multi-org sign-in: every existing `User` gets an `Identity`, grouped by email.
 * What this file holds is the set of rules that make the merge safe (see the service header):
 * a merged identity carries no password unless the operator names one, old OAuth links are
 * unverified, Microsoft links and contested links are dropped, a merge never picks a landing org,
 * and a re-run never re-points a user or links one to an identity that already exists.
 */

let regal: Types.ObjectId
let regalPz: Types.ObjectId
let acme: Types.ObjectId

async function freshOrgs() {
  regal = (await createTestOrg({ slug: `regal-${Date.now()}` } as any))._id as Types.ObjectId
  regalPz = (await createTestOrg({ slug: `regal-pz-${Date.now()}` } as any))._id as Types.ObjectId
  acme = (await createTestOrg({ slug: `acme-${Date.now()}` } as any))._id as Types.ObjectId
}

async function plan(keep?: Map<string, string>) {
  const input = await loadMigrationInput()
  return planIdentityMigration(input.users, {
    keepPassword: keep,
    existingIdentityEmails: input.existingIdentityEmails,
    existingLinks: input.existingLinks,
  })
}

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await Identity.deleteMany({}).exec()
  await User.deleteMany({}).exec()
  await freshOrgs()
})

describe('a user alone at their email', () => {
  it('becomes an identity with their own password hash, unverified links, and their org as landing', async () => {
    const u = await createTestUser(acme, {
      email: 'Solo@Example.com',
      username: 'solo',
      oauthProviders: [
        { provider: 'google', providerId: 'g-solo' },
        { provider: 'microsoft', providerId: 'ms-solo' },
      ],
    } as any)
    const hash = (await User.findById(u._id).lean().exec())!.password

    const p = await plan()
    expect(p.identities).toHaveLength(1)
    const planned = p.identities[0]
    expect(planned.email).toBe('solo@example.com')
    expect(planned.flags).toContain('microsoft-link-dropped')
    expect(planned.flags).not.toContain('multi-org')

    const run = await executeIdentityMigration(p, 'run-solo')
    expect(run).toMatchObject({ created: 1, linked: 1, failed: [] })

    const identity = await Identity.findOne({ email: 'solo@example.com' }).select('+password').lean().exec()
    expect(identity!.password).toBe(hash!)
    expect(identity!.passwordSetBy).toBe('legacy')
    expect(identity!.oauthProviders.map(l => [l.provider, l.providerId, l.verified])).toEqual([['google', 'g-solo', false]])
    expect(String(identity!.lastOrgId)).toBe(String(acme))
    expect(String((await User.findById(u._id).lean().exec())!.identityId)).toBe(String(identity!._id))
  })

  it('keeps "never activated" apart from "deactivated by an admin"', async () => {
    await createTestUser(acme, { email: 'pending@example.com', username: 'pending', isActive: false } as any)
    const gone = await createTestUser(acme, {
      email: 'gone@example.com',
      username: 'gone',
      isActive: false,
      deactivatedAt: new Date(),
    } as any)

    await executeIdentityMigration(await plan(), 'run-active')

    expect((await Identity.findOne({ email: 'pending@example.com' }).lean().exec())!.isActive).toBe(false)
    // The person is fine; their membership in this org is what an admin switched off.
    expect((await Identity.findOne({ email: 'gone@example.com' }).lean().exec())!.isActive).toBe(true)
    expect((await User.findById(gone._id).lean().exec())!.isActive).toBe(false)
  })

  it('refuses an unusable email instead of grouping it with others', async () => {
    await createTestUser(acme, { email: 'not-an-email', username: 'weird' } as any)
    const p = await plan()
    expect(p.identities).toHaveLength(0)
    expect(p.conflicts[0].reason).toContain('not a usable email')
  })
})

describe('several users at one email (the people this is for)', () => {
  it('become ONE identity with no password, unioned unverified links, and no landing org', async () => {
    const old = await createTestUser(regal, {
      email: 'goran@roomler.test',
      username: 'goran_jovanov_aniv',
      firstName: 'Goran',
      lastName: 'J',
      oauthProviders: [{ provider: 'google', providerId: 'g-goran' }],
      lastLoginAt: new Date('2026-08-01'),
    } as any)
    const live = await createTestUser(regalPz, {
      email: 'GORAN@roomler.test',
      username: 'goran_jovanov',
      firstName: 'Goran',
      lastName: 'Jovanov',
      oauthProviders: [{ provider: 'google', providerId: 'g-goran' }],
      lastLoginAt: new Date('2026-10-01'),
    } as any)

    const p = await plan()
    expect(p.identities).toHaveLength(1)
    const planned = p.identities[0]
    expect(planned.flags).toEqual(expect.arrayContaining(['multi-org', 'no-password', 'names-differ']))
    expect(planned.usernames).toEqual(['goran_jovanov', 'goran_jovanov_aniv'])

    await executeIdentityMigration(p, 'run-merge')
    const identity = await Identity.findOne({ email: 'goran@roomler.test' }).select('+password').lean().exec()
    expect(identity!.password).toBeUndefined()
    expect(identity!.lastOrgId).toBeUndefined()
    expect(identity!.lastName).toBe('Jovanov') // the most recently used account's profile
    expect(identity!.oauthProviders).toHaveLength(1)
    expect(identity!.oauthProviders[0].verified).toBe(false)
    for (const u of [old, live]) {
      expect(String((await User.findById(u._id).lean().exec())!.identityId)).toBe(String(identity!._id))
    }
  })

  it('keeps the password of the org the operator names, and only that one', async () => {
    // Random phrases, so no credential-shaped literal sits in the repository.
    const regalPhrase = crypto.randomUUID()
    const pzPhrase = crypto.randomUUID()
    await createTestUser(regal, { email: 'r@regal.test', username: 'r1', password: await Bun.password.hash(regalPhrase) } as any)
    const pz = await createTestUser(regalPz, { email: 'r@regal.test', username: 'r2', password: await Bun.password.hash(pzPhrase) } as any)

    const p = await plan(new Map([['r@regal.test', String(regalPz)]]))
    expect(p.identities[0].flags).toContain('kept-password')
    await executeIdentityMigration(p, 'run-keep')

    const identity = await Identity.findOne({ email: 'r@regal.test' }).select('+password').lean().exec()
    expect(identity!.password).toBe((await User.findById(pz._id).lean().exec())!.password!)
    expect(await Bun.password.verify(pzPhrase, identity!.password!)).toBe(true)
    expect(await Bun.password.verify(regalPhrase, identity!.password!)).toBe(false)
  })

  it('reports a keep-password that names no usable source, and merges without a password', async () => {
    await createTestUser(regal, { email: 'k@regal.test', username: 'k1' } as any)
    await createTestUser(regalPz, { email: 'k@regal.test', username: 'k2' } as any)

    const p = await plan(new Map([['k@regal.test', String(acme)]]))
    expect(p.conflicts.some(c => c.email === 'k@regal.test')).toBe(true)
    expect(p.identities[0].flags).toContain('no-password')
  })
})

describe('what the planner refuses to guess', () => {
  it('drops a provider account linked under two different emails, from both', async () => {
    await createTestUser(regal, { email: 'a@x.test', username: 'a', oauthProviders: [{ provider: 'google', providerId: 'g-shared' }] } as any)
    await createTestUser(regalPz, { email: 'b@x.test', username: 'b', oauthProviders: [{ provider: 'google', providerId: 'g-shared' }] } as any)

    const p = await plan()
    expect(p.contestedLinks).toEqual([{ provider: 'google', providerId: 'g-shared', emails: ['a@x.test', 'b@x.test'] }])
    for (const id of p.identities) {
      expect(id.oauthProviders).toHaveLength(0)
      expect(id.flags).toContain('contested-link-dropped')
    }
  })

  it('flags everyone the migration would leave with no way to sign in', async () => {
    // Microsoft was their only way in, and that link is dropped.
    await createTestUser(acme, {
      email: 'ms-only@x.test',
      username: 'ms-only',
      password: undefined,
      oauthProviders: [{ provider: 'microsoft', providerId: 'ms-1' }],
    } as any)
    // A merge without --keep-password and without any provider link.
    await createTestUser(regal, { email: 'pw@x.test', username: 'pw1' } as any)
    await createTestUser(regalPz, { email: 'pw@x.test', username: 'pw2' } as any)
    // Keeps their own password: not flagged.
    await createTestUser(acme, { email: 'fine@x.test', username: 'fine' } as any)

    const p = await plan()
    const flagged = p.identities.filter(i => i.flags.includes('no-sign-in-method')).map(i => i.email)
    expect(flagged).toEqual(['ms-only@x.test', 'pw@x.test'])
  })

  it('leaves a provider link that an existing identity already holds with that identity', async () => {
    await Identity.create({
      email: 'held@x.test',
      firstName: 'H',
      lastName: 'Eld',
      oauthProviders: [{ provider: 'google', providerId: 'g-held', verified: true }],
    })
    await createTestUser(regal, { email: 'new@x.test', username: 'new', oauthProviders: [{ provider: 'google', providerId: 'g-held' }] } as any)

    const p = await plan()
    expect(p.contestedLinks).toEqual([{ provider: 'google', providerId: 'g-held', emails: ['held@x.test', 'new@x.test'] }])
    expect(p.identities[0].oauthProviders).toHaveLength(0)
    expect(p.identities[0].flags).toContain('contested-link-dropped')

    // Without the drop, the unique provider index would refuse the whole identity.
    const run = await executeIdentityMigration(p, 'run-held')
    expect(run).toMatchObject({ created: 1, linked: 1, failed: [] })
    const held = await Identity.findOne({ email: 'held@x.test' }).lean().exec()
    expect(held!.oauthProviders.map(l => l.providerId)).toEqual(['g-held'])
  })

  it('reports a username that different people share', async () => {
    await createTestUser(regal, { email: 'admin@regal.test', username: 'admin' } as any)
    await createTestUser(acme, { email: 'admin@acme.test', username: 'admin' } as any)

    const p = await plan()
    expect(p.usernameCollisions).toEqual([{ username: 'admin', emails: ['admin@acme.test', 'admin@regal.test'] }])
  })

  it('never re-links: a second run plans nothing, and an email that already has an identity is a conflict', async () => {
    await createTestUser(acme, { email: 'once@x.test', username: 'once' } as any)
    await executeIdentityMigration(await plan(), 'run-1')

    const again = await plan()
    expect(again.alreadyLinked).toBe(1)
    expect(again.identities).toHaveLength(0)

    // A new, unlinked user at the same email (created by old code after the run) is left alone.
    const late = await createTestUser(regal, { email: 'once@x.test', username: 'once-late' } as any)
    const third = await plan()
    expect(third.conflicts.some(c => c.email === 'once@x.test' && c.userIds.includes(String(late._id)))).toBe(true)
    expect(third.identities).toHaveLength(0)
  })

  it('removes an identity whose users were all linked elsewhere after the plan, instead of leaving it empty', async () => {
    await createTestUser(acme, { email: 'race@x.test', username: 'race' } as any)
    const p = await plan()

    // Something else links the user between the plan and the execute.
    const other = await Identity.create({ email: 'race-other@x.test', firstName: 'R', lastName: 'Other' })
    await User.updateMany({ email: 'race@x.test' }, { $set: { identityId: other._id } }).exec()

    const run = await executeIdentityMigration(p, 'run-race')
    expect(run.created).toBe(0)
    expect(run.failed.map(f => f.email)).toEqual(['race@x.test'])
    expect(await Identity.countDocuments({ email: 'race@x.test' })).toBe(0)
    expect(await Identity.countDocuments({ 'migration.runId': 'run-race' })).toBe(0)
  })
})

describe('rollback and the index behind it', () => {
  it('rolls one run back: unlinks its users and deletes its identities, nothing else', async () => {
    const mine = await createTestUser(acme, { email: 'mine@x.test', username: 'mine' } as any)
    await executeIdentityMigration(await plan(), 'run-a')
    const other = await createTestUser(regal, { email: 'other@x.test', username: 'other' } as any)
    await executeIdentityMigration(await plan(), 'run-b')

    const undone = await rollbackIdentityMigration('run-a')
    expect(undone).toEqual({ removed: 1, unlinked: 1 })
    expect((await User.findById(mine._id).lean().exec())!.identityId).toBeUndefined()
    expect((await User.findById(other._id).lean().exec())!.identityId).toBeDefined()
    expect(await Identity.countDocuments({ email: 'other@x.test' })).toBe(1)
  })

  it('lets two identities without links coexist, but never two with the same provider account', async () => {
    await Identity.create({ email: 'p1@x.test', firstName: 'P', lastName: 'One' })
    await Identity.create({ email: 'p2@x.test', firstName: 'P', lastName: 'Two' })
    await Identity.create({ email: 'g1@x.test', firstName: 'G', lastName: 'One', oauthProviders: [{ provider: 'google', providerId: 'same' }] })

    let code: unknown
    try {
      await Identity.create({ email: 'g2@x.test', firstName: 'G', lastName: 'Two', oauthProviders: [{ provider: 'google', providerId: 'same' }] })
    } catch (err: any) {
      code = err?.code
    }
    expect(code).toBe(11000)
  })

  it('normalises emails the way the unique index sees them', () => {
    expect(normalizeEmail('  Mixed@Case.Example ')).toBe('mixed@case.example')
  })
})
