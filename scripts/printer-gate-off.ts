/**
 * FR-23 (owner, 2026-11-01): the one org a migration cannot decide for.
 *
 * `0011-printer-gate-off` turns the printer gate off on every org with no active fiscal device whose
 * switch is unset, on every node. What is left is an org that HAS a device and is not printing here
 * yet: `regal-pz`, whose till is still PlusMinus. Nothing in the data says that, so it is a named step.
 * Unset reads as ON, so left alone, a cash invoice there would need an LGR device.
 *
 *   bun run scripts/printer-gate-off.ts             # what it would do, nothing written
 *   bun run scripts/printer-gate-off.ts --execute
 *
 * Sets `settings.cashRegister.requireConnectedDevice: false` on the orgs in `ALWAYS_OFF`, that one path,
 * only where it differs, and only on orgs homed here.
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
  /** Orgs whose gate goes off. */
  off: OrgRow[]
  /** Orgs already off, so nothing is written. */
  already: string[]
  /** Everything else: its gate stays as it is. */
  kept: string[]
}

/**
 * What this run would do. Pure. ⚠ `regal` falls in no list that writes, whatever it holds, and an org
 * this script does not name stays as it is: that is `0011-printer-gate-off`'s, which reads the data.
 */
export function planGateOff(orgs: OrgRow[]): GatePlan {
  const plan: GatePlan = { off: [], already: [], kept: [] }
  for (const org of orgs) {
    const slug = org.slug ?? String(org._id)
    if (org.slug === NEVER || !ALWAYS_OFF.includes(slug)) plan.kept.push(slug)
    else if (org.settings?.cashRegister?.requireConnectedDevice === false) plan.already.push(slug)
    else plan.off.push(org)
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
  const plan = planGateOff(here)

  let written = 0
  if (opts.execute) {
    for (const org of plan.off) written += await writeGateOff(db, org._id)
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
    for (const org of run.off) console.log(`${execute ? 'off' : 'would turn off'}: ${org.slug}`)
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
