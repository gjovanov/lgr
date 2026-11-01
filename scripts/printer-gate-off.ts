/**
 * FR-23 (owner, 2026-11-01): the printer gate of the orgs that already exist.
 *
 * A new org is written with the gate off (`defaultOrgSettings`), and an org opts in when its sales
 * print here. ⚠ An org from before has the setting UNSET, and unset reads as ON: `regal`'s till depends
 * on that, so the reading stays and this script writes the others, one explicit value at a time.
 *
 *   bun run scripts/printer-gate-off.ts             # what it would do, nothing written
 *   bun run scripts/printer-gate-off.ts --execute
 *
 * Sets `settings.cashRegister.requireConnectedDevice: false` on every org with no active fiscal
 * device, and on `regal-pz`, which has one and whose till is still PlusMinus. It touches that one
 * path, only where it differs, and only on orgs homed here. Run it BEFORE FR-23 deploys.
 *
 * ⚠ `regal` is never touched: it is out of the plan whatever it holds, out of the write's own filter,
 * and naming it stops the script. Its gate going off silently would let a real till sell with no
 * fiscal receipt.
 */
import { mongoose } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'

/** The org whose gate this script may never change. */
export const NEVER = 'regal'
/** Off whatever it holds: a device, and a till that is not this one. */
export const ALWAYS_OFF = ['regal-pz']

const GATE = 'settings.cashRegister.requireConnectedDevice'

type Db = NonNullable<typeof mongoose.connection.db>
interface OrgRow { _id: unknown; slug?: string; settings?: { cashRegister?: { requireConnectedDevice?: boolean } } }

export interface GatePlan {
  /** Orgs whose gate goes off, and why. */
  off: Array<{ org: OrgRow; why: 'no active fiscal device' | 'named' }>
  /** Orgs already off, so nothing is written. */
  already: string[]
  /** Orgs with an active device: their gate stays as it is. */
  kept: string[]
}

/**
 * What this run would do, from the orgs and which of them hold an active device. Pure.
 * ⚠ `regal` falls in no list that writes, whatever it holds.
 */
export function planGateOff(orgs: OrgRow[], withDevice: Set<string>): GatePlan {
  const plan: GatePlan = { off: [], already: [], kept: [] }
  for (const org of orgs) {
    const slug = org.slug ?? String(org._id)
    if (org.slug === NEVER) {
      plan.kept.push(slug)
      continue
    }
    const named = ALWAYS_OFF.includes(slug)
    if (!named && withDevice.has(String(org._id))) {
      plan.kept.push(slug)
    } else if (org.settings?.cashRegister?.requireConnectedDevice === false) {
      plan.already.push(slug)
    } else {
      plan.off.push({ org, why: named ? 'named' : 'no active fiscal device' })
    }
  }
  return plan
}

export interface GateRun extends GatePlan { written: number }

/** The one write. Its filter says it again: what differs, and never `regal`, whatever the plan was. */
export async function writeGateOff(db: Db, orgId: unknown): Promise<number> {
  const r = await db.collection('orgs').updateOne(
    { _id: orgId as any, slug: { $ne: NEVER }, [GATE]: { $ne: false } },
    { $set: { [GATE]: false } },
  )
  return r.modifiedCount
}

/** `only`: these slugs and no others. Naming `regal` stops the run before anything is read. */
export async function printerGateOff(db: Db, opts: { execute: boolean; only?: string[] }): Promise<GateRun> {
  if (opts.only?.includes(NEVER)) {
    throw new Error(`Refusing to touch ${NEVER}: its till depends on the gate. Nothing was written.`)
  }
  const orgs = db.collection('orgs')
  const all = await orgs.find(
    opts.only ? { slug: { $in: opts.only } } : {},
    { projection: { slug: 1, [GATE]: 1 } },
  ).toArray() as unknown as Array<OrgRow & { _id: unknown }>
  const here = await keepHomeOrgs(all as Array<{ _id: unknown; slug?: string }>, { named: !!opts.only }) as OrgRow[]
  const active = await db.collection('fiscaldevices').distinct('orgId', { isActive: { $ne: false } })
  const plan = planGateOff(here, new Set(active.map(String)))

  let written = 0
  if (opts.execute) {
    for (const { org } of plan.off) written += await writeGateOff(db, org._id)
  }
  return { ...plan, written }
}

async function main() {
  const execute = process.argv.includes('--execute')
  const at = process.argv.indexOf('--org')
  const only = at > 0 ? String(process.argv[at + 1] ?? '').split(',').filter(Boolean) : undefined
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  // Indexes and collections are the deployed app's business, not this script's.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false })
  try {
    const run = await printerGateOff(mongoose.connection.db!, { execute, ...(only ? { only } : {}) })
    for (const { org, why } of run.off) console.log(`${execute ? 'off' : 'would turn off'}: ${org.slug} (${why})`)
    console.log(`Already off: ${run.already.join(', ') || 'none'}`)
    console.log(`Left as they are: ${run.kept.join(', ') || 'none'}`)
    console.log(execute ? `${run.written} org(s) written.` : `Dry run: nothing written. ${run.off.length} org(s) would change. --execute to write.`)
  } finally {
    await mongoose.disconnect()
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}
