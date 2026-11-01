import type { Db } from 'mongodb'
import type { Migration, MigrationContext } from '../types.js'

/**
 * FR-23 (owner, 2026-11-01): an org prints here only if it opted in, and one with nothing to print on
 * did not.
 *
 * Every path that creates an org writes the printer gate off (`defaultOrgSettings`). An org from before
 * has it unset, and unset reads as ON, because a real till depends on that: an org left unset is
 * refused a cash invoice for want of a device it never had. So this writes `false` on every org with
 * no active fiscal device whose switch is unset, on this node's orgs only.
 *
 * An org with an active device keeps what it has, unset included: its till reads the gate. A value
 * somebody set is theirs, either way. A device that is deactivated is no device.
 *
 * Expand and contract both hold: the previous release reads `false` as the setting it always was, and
 * a till with no device simply sells. Idempotent: an org written once is no longer unset.
 */
const GATE = 'settings.cashRegister.requireConnectedDevice'

/** `orgFilter` names the org in `orgId`, for tenant data. On `orgs` it is the document's own id. */
const homeOrgs = (orgFilter: Record<string, unknown>): Record<string, unknown> => ('orgId' in orgFilter ? { _id: orgFilter.orgId } : {})

async function orgsToTurnOff(db: Db, orgFilter: Record<string, unknown>): Promise<Array<{ _id: unknown; slug?: string }>> {
  const withDevice = await db.collection('fiscaldevices').distinct('orgId', { ...orgFilter, isActive: { $ne: false } })
  const held = new Set(withDevice.map(String))
  const unset = await db.collection('orgs').find({ ...homeOrgs(orgFilter), [GATE]: { $exists: false } }, { projection: { slug: 1 } }).toArray()
  return unset.filter(o => !held.has(String(o._id))) as Array<{ _id: unknown; slug?: string }>
}

export const printerGateOff: Migration = {
  id: '0011-printer-gate-off',
  description: 'The printer gate goes off on every org with no active fiscal device whose switch is unset: unset reads as on (FR-23)',
  async preview({ db, orgFilter }: MigrationContext) {
    const orgs = await orgsToTurnOff(db, orgFilter)
    return orgs.length ? orgs.map(o => `off: ${o.slug ?? String(o._id)} (no active fiscal device)`) : ['nothing to change']
  },
  async up({ db, log, orgFilter }) {
    const orgs = await orgsToTurnOff(db, orgFilter)
    let written = 0
    for (const org of orgs) {
      // The filter says it again: only what is still unset, whatever was read above.
      const r = await db.collection('orgs').updateOne({ _id: org._id as any, [GATE]: { $exists: false } }, { $set: { [GATE]: false } })
      written += r.modifiedCount
    }
    log(`the printer gate went off on ${written} org(s) with no active fiscal device`)
  },
}
