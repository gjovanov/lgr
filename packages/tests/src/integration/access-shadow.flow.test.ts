import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { AccessShadowDiff, Org } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { accessModelOf, flushShadowDiffs, forgetAccessModel, shadowAccess } from 'services/biz/access/shadow'

/**
 * FR-27 §4 step 2 (#529) — shadow mode: an org in `shadow` counts each answer the new evaluator would give
 * differently from the legacy rules, and nothing else changes. The evaluator agrees with the legacy rules on every
 * route (`access-differential.flow`), so a difference is made here by telling `shadowAccess` the opposite answer.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => {
  await setupTestDB()
  // The buffer is per process: an earlier file's `roles` org may have left a difference in it (a role the
  // test gave caps its stored legacy projection lacks). Start from an empty one.
  await flushShadowDiffs()
  await clearCollections()
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ROUTE = '/api/org/:orgId/invoices'
const accountant = { id: 'u1', role: 'accountant', permissions: [...DEFAULT_ROLE_PERMISSIONS.accountant] }
/** `shadowAccess` returns at once; its comparison follows the org lookup. */
const settle = () => new Promise(r => setTimeout(r, 50))

async function orgIn(model?: 'shadow' | 'legacy') {
  const org = await createTestOrg()
  if (model) await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': model } }).exec()
  forgetAccessModel(String(org._id))
  return String(org._id)
}

describe('FR-27 shadow mode', () => {
  it('an org that never set it is legacy, and the switch is read from settings.access.model', async () => {
    expect(await accessModelOf(await orgIn())).toBe('legacy')
    expect(await accessModelOf(await orgIn('shadow'))).toBe('shadow')
  })

  it('counts an answer the evaluator would give differently: one row per route and answer, with a count', async () => {
    const orgId = await orgIn('shadow')
    // The accountant reads invoices: the evaluator allows. Told the legacy rules refused, it is a difference.
    shadowAccess(accountant, orgId, 'GET', ROUTE, true)
    shadowAccess(accountant, orgId, 'GET', ROUTE, true)
    await settle()
    expect(await flushShadowDiffs()).toBe(1)

    const rows: any[] = await AccessShadowDiff.find({ org: orgId }).lean()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ method: 'GET', route: ROUTE, role: 'accountant', legacy: 'refuse', evaluator: 'allow', count: 2 })
  })

  it('counts nothing where they agree, nor for an org that is not in shadow', async () => {
    const shadowed = await orgIn('shadow')
    const legacy = await orgIn('legacy')
    shadowAccess(accountant, shadowed, 'GET', ROUTE, false)
    shadowAccess(accountant, legacy, 'GET', ROUTE, true)
    await settle()
    expect(await flushShadowDiffs()).toBe(0)
    expect(await AccessShadowDiff.countDocuments({})).toBe(0)
  })
})
