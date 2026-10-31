import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeDesktopStub, enrollBody } from '../helpers/desktop-stub'
import { mongoose } from 'db/connection'
import { DesktopEnrollmentCode, DocFile, FiscalDevice, Identity, Invite, Org, OrgHome, User } from 'db/models'
import { forgetAllHomes, homeScope } from 'db/home/home'
import { inviteDao } from 'services/dao/invite.dao'
import { changePassword, joinOrgByInvite } from 'services/biz/identity/account.service'
import { applyAdminIdentityEdit } from 'services/biz/identity/identity.service'
import { DesktopError, enrollDesktop, mintEnrollmentCode } from 'services/biz/desktop/desktop.service'
import { markUnheldDevicesOffline } from 'services/biz/fiscal-presence.service'
import { retentionTick } from 'services/biz/retention/retention.service'
import { runMigrations } from 'migrations/runner'
import { config } from 'config'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * Writers that cross orgs consult the home too (FR-20.5, plan step P0b-3; AC 3).
 *
 * The route gate sees only routes with `:orgId`, and the write guard REFUSES a fan-out that
 * reaches an org homed elsewhere — after the first half of it already ran. So the flows that write
 * to several orgs at once skip those orgs instead: identity fan-outs, sweeps, migrations. The flows
 * that would CREATE a presence in such an org (a membership, an enrolled desktop) refuse.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const PW = 'Corr3ct-Horse-Battery'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await clearCollections()
  forgetAllHomes()
  ;(config.node as any).role = 'global'
  ;(config.node as any).id = undefined
})

/** Make an org's home a master — what a move leaves on global. Called after its data exists. */
async function moveAway(orgId: unknown) {
  await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

/** Two orgs; `away` is moved by the test once its data is in place. */
async function world() {
  return { home: await createTestOrg(), away: await createTestOrg() }
}

/** A person with a membership in each org. */
async function person(orgs: { _id: unknown }[], opts: { activeIn?: (o: any) => boolean } = {}) {
  const email = `p-${Math.random().toString(36).slice(2)}@x.test`
  const identity = await Identity.create({
    email, firstName: 'Per', lastName: 'Son', password: await Bun.password.hash(PW), passwordSetBy: 'self', isActive: true,
  })
  const members = []
  for (const o of orgs) {
    members.push(await User.create({
      email, username: `u${Math.random().toString(36).slice(2, 8)}`, firstName: 'Per', lastName: 'Son',
      role: 'member', orgId: o._id, identityId: identity._id, password: 'legacy-copy',
      isActive: opts.activeIn ? opts.activeIn(o) : true, permissions: [],
    } as any))
  }
  return { identity, members }
}

describe('homeScope()', () => {
  it('is {} on global while no org ever moved — every org today', async () => {
    await createTestOrg()
    expect(await homeScope()).toEqual({})
  })

  it('leaves out the orgs homed elsewhere; on a master, keeps only its own', async () => {
    const { home, away } = await world()
    await moveAway(away._id)
    const scope = await homeScope() as any
    expect(scope.orgId.$nin.map(String)).toEqual([String(away._id)])

    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'node-shop-1'
    forgetAllHomes()
    const mine = await homeScope() as any
    expect(mine.orgId.$in.map(String)).toEqual([String(away._id)])
    void home
  })
})

describe('identity fan-outs skip memberships of orgs homed elsewhere (AC 3)', () => {
  it('a password change succeeds, and writes no membership of an on-prem org', async () => {
    const { home, away } = await world()
    const { identity, members } = await person([home, away])
    await moveAway(away._id)

    await changePassword(identity._id, PW, 'An0ther-Horse-Battery')

    const [atHome, onPrem] = await Promise.all(members.map(m => User.findById(m._id).select('+password').lean().exec() as any))
    expect(atHome.password).not.toBe('legacy-copy')
    expect(onPrem.password).toBe('legacy-copy')
    // The person's own record changed: the change did not stop half-way.
    expect((await Identity.findById(identity._id).lean() as any).tokenVersion).toBeGreaterThan(0)
  })

  it('an admin\'s edit is mirrored into the person\'s other memberships here, not on-prem ones', async () => {
    const { home, away } = await world()
    const other = await createTestOrg()
    // Not active elsewhere, so an admin of `home` may edit them; memberships in `other` and `away`
    // are switched off.
    const { members } = await person([home, other, away], { activeIn: o => o === home })
    await moveAway(away._id)

    await applyAdminIdentityEdit(members[0] as any, String(home._id), { firstName: 'Renamed' })

    const names = await Promise.all(members.map(m => User.findById(m._id).lean().exec() as any))
    expect(names.map(n => n.firstName)).toEqual(['Per', 'Renamed', 'Per'])
  })
})

describe('no new presence in an org homed elsewhere', () => {
  it('joining by invite is refused, and the invite is not used', async () => {
    const { away } = await world()
    const inviter = await createTestUser(away._id as any)
    const invite = await inviteDao.createInvite({ orgId: String(away._id), inviterId: String(inviter._id), maxUses: 1 })
    const { identity } = await person([])
    await moveAway(away._id)

    const err = await captureRejection(joinOrgByInvite(identity._id, invite.code))

    expect((err as any)?.code).toBe('org_home_elsewhere')
    expect((await Invite.findById(invite._id).lean() as any).useCount ?? 0).toBe(0)
    expect(await User.countDocuments({ identityId: identity._id })).toBe(0)
  })

  it('a desktop enrollment is refused with 409, and the code is not consumed', async () => {
    const away = await createTestOrg()
    const admin = await createTestUser(away._id, { role: 'admin' } as any)
    const minted = await mintEnrollmentCode(String(away._id), String(admin._id), 'https://lgrai.app')
    await OrgHome.create({ orgId: away._id, home: 'node-shop-1', epoch: 1 })
    await Org.updateOne({ _id: away._id }, { $set: { homeEpochHighWater: 1 } }).exec()
    forgetAllHomes()

    const err = await captureRejection(enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any))

    expect(err).toBeInstanceOf(DesktopError)
    expect((err as any).status ?? (err as any).statusCode).toBe(409)
    expect((await DesktopEnrollmentCode.findOne({ orgId: away._id }).lean() as any).usedAt).toBeFalsy()
  })
})

describe('sweeps and migrations filter by home (AC 3)', () => {
  // FR-24.46: the boot-time reset is gone; the presence sweep that replaces it keeps the same scope.
  it('the unheld-device sweep touches no device of an org whose home is elsewhere', async () => {
    const { home, away } = await world()
    const base = { manufacturer: 'eltrade', connectionType: 'browser', isActive: true, status: 'online' }
    await FiscalDevice.collection.insertMany([
      { ...base, orgId: home._id, name: 'here', deviceNumber: 'ED000001' },
      { ...base, orgId: away._id, name: 'there', deviceNumber: 'ED000002' },
    ])
    await moveAway(away._id)

    expect(await markUnheldDevicesOffline()).toBe(1)

    const st = async (orgId: unknown) => (await FiscalDevice.findOne({ orgId }).lean() as any).status
    expect(await st(home._id)).toBe('offline')
    expect(await st(away._id)).toBe('online')
  })

  it('retention strips only the home orgs\' settled compare summaries', async () => {
    const { home, away } = await world()
    const doc = { status: 'committed', compareSummary: { lines: 1 }, filename: 'x.pdf' }
    await DocFile.collection.insertMany([{ ...doc, orgId: home._id }, { ...doc, orgId: away._id }])
    await moveAway(away._id)

    await retentionTick()

    const has = async (orgId: unknown) => !!(await DocFile.findOne({ orgId }).lean() as any).compareSummary
    expect(await has(home._id)).toBe(false)
    expect(await has(away._id)).toBe(true)
  })

  it('a migration given homeScope() touches only the orgs whose home is here', async () => {
    const { home, away } = await world()
    const db = mongoose.connection.db!
    await db.collection('mig_probe').insertMany([{ orgId: home._id }, { orgId: away._id }])
    await moveAway(away._id)

    await runMigrations({
      db,
      orgFilter: await homeScope(),
      migrations: [{
        id: '0001-probe', description: 'probe',
        async up(ctx) { await ctx.db.collection('mig_probe').updateMany({ ...ctx.orgFilter }, { $set: { done: true } }) },
      }],
    })

    const done = async (orgId: unknown) => !!(await db.collection('mig_probe').findOne({ orgId }))?.done
    expect(await done(home._id)).toBe(true)
    expect(await done(away._id)).toBe(false)
  })
})
