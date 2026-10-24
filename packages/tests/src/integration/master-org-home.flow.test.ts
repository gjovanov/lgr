/**
 * FR-20.18 / FR-20.5 — an org created on a master is homed on that master.
 *
 * Found by running a master end to end (P1-6a): setup registered the shop's org, and the very next
 * write (its first user) was refused, "Org … is not written here: its home is global". An org with
 * no home record is global's, and nothing gave the new one a record. Before that, the master had no
 * node identity at all (`LGR_NODE_ID`), so it could not be home of anything.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { Identity, Org, OrgHome, PermissionSet, User } from 'db/models'
import { forgetAllHomes, isHomeHere } from 'db/home/home'
import { register } from 'services/biz/auth.service'
import { config } from 'config'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await clearCollections()
  ;(config.node as any).role = 'global'
  ;(config.node as any).id = undefined
  forgetAllHomes()
})

const asMaster = (id: string | null = 'master-abcdefghijklmnop') => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = id ?? undefined
  forgetAllHomes()
}

const newShop = (slug: string) => ({
  orgName: 'Kasa Shop', orgSlug: slug, email: `owner@${slug}.invalid`, username: 'owner',
  password: 'Corr3ct-Horse-Battery', firstName: 'Kasa', lastName: 'Owner',
})

describe('an org created on a master (FR-20.18)', () => {
  test('is homed on the master, so its own setup is not refused', async () => {
    asMaster()
    const { org, user } = await register(newShop('kasa-shop'))
    const home = await OrgHome.findOne({ orgId: org._id }).lean() as any
    expect(home).toMatchObject({ home: 'master-abcdefghijklmnop', epoch: 1, state: 'active' })
    expect((await Org.findById(org._id).lean() as any).homeEpochHighWater).toBe(1)
    expect(await isHomeHere(org._id)).toBe(true)
    // Everything a new org gets was written: the founder, the permission sets.
    expect(await User.exists({ _id: user._id })).toBeTruthy()
    expect(await PermissionSet.countDocuments({ orgId: org._id })).toBeGreaterThan(0)
  })

  test('on lgrai.app nothing changes: no record, global is home', async () => {
    const { org } = await register(newShop('cloud-shop'))
    expect(await OrgHome.countDocuments({ orgId: org._id })).toBe(0)
    expect(await isHomeHere(org._id)).toBe(true)
  })

  test('a master with no identity creates nothing, and says why', async () => {
    asMaster(null) // ⚠ null: an undefined argument would take the default
    const err = await captureRejection(register(newShop('nowhere-shop')))
    expect(String(err)).toContain('no node identity')
    expect(await Org.countDocuments({ slug: 'nowhere-shop' })).toBe(0)
    expect(await OrgHome.countDocuments({})).toBe(0)
    expect(await Identity.countDocuments({ email: 'owner@nowhere-shop.invalid' })).toBe(0)
  })
})
