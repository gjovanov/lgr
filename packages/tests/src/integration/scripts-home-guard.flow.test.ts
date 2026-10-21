import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { Org, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { assertAllOrgsHome, assertScriptHome, keepHomeOrgs, tenantHomeScope } from '../../../../scripts/lib/home-guard'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * `scripts/lib/home-guard.ts` (FR-20.4, plan step P0b-6): a script stops BEFORE it writes for an
 * org homed elsewhere, and a script walking every org leaves such an org out.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`) } }
const realExit = process.exit
const realError = console.error
const realLog = console.log

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  process.exit = realExit
  console.error = realError
  console.log = realLog
  await clearCollections()
  forgetAllHomes()
})

/** `process.exit` throws instead, so the test sees the code; output is captured. */
function trapExit() {
  const out: string[] = []
  process.exit = ((code?: number) => { throw new Exit(code ?? 0) }) as any
  console.error = (...a: unknown[]) => { out.push(a.join(' ')) }
  console.log = (...a: unknown[]) => { out.push(a.join(' ')) }
  return out
}

async function moveAway(orgId: unknown) {
  await OrgHome.create({ orgId, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } }).exec()
  forgetAllHomes()
}

describe('scripts/lib/home-guard', () => {
  it('everything passes while no org has moved: every org today', async () => {
    const org = await createTestOrg()
    await assertScriptHome(org._id)
    expect(await keepHomeOrgs([org] as any[])).toHaveLength(1)
    expect(await tenantHomeScope()).toEqual({})
    await assertAllOrgsHome('probe')
  })

  it('a named org homed elsewhere stops the script with exit 2 and says why', async () => {
    const org = await createTestOrg({ slug: 'away-shop' } as any)
    await moveAway(org._id)
    const out = trapExit()

    const err = await captureRejection(assertScriptHome(org._id, 'away-shop'))

    expect(err).toBeInstanceOf(Exit)
    expect((err as Exit).code).toBe(2)
    expect(out.join('\n')).toContain('away-shop is not homed on this node')
  })

  it('walking every org leaves out the ones homed elsewhere; asking for one by name stops', async () => {
    const home = await createTestOrg({ slug: 'here' } as any)
    const away = await createTestOrg({ slug: 'there' } as any)
    await moveAway(away._id)
    const out = trapExit()

    const kept = await keepHomeOrgs([home, away] as any[])
    expect(kept.map(o => String(o._id))).toEqual([String(home._id)])
    expect(out.join('\n')).toContain('Skipping 1 org(s) homed elsewhere: there')

    const err = await captureRejection(keepHomeOrgs([away] as any[], { named: true }))
    expect((err as Exit).code).toBe(2)
  })

  it('a migration over all orgs refuses once any org lives elsewhere', async () => {
    const away = await createTestOrg()
    await moveAway(away._id)
    trapExit()

    const err = await captureRejection(assertAllOrgsHome('The identity migration'))
    expect((err as Exit).code).toBe(2)
    expect(((await tenantHomeScope()) as any).orgId.$nin.map(String)).toEqual([String(away._id)])
  })
})
