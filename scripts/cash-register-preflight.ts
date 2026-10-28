/**
 * FR-21.21 — what migration `0008-cash-register-copy` would meet, and nothing written.
 *
 *   bun scripts/cash-register-preflight.ts                 every org with POS rows or unlabelled cash sales
 *   bun scripts/cash-register-preflight.ts --org regal     one org
 *   bun scripts/cash-register-preflight.ts --parity        also check the copies that already exist
 *
 * Per org: its POS rows and how many already have their document, the blockers (the migration stops
 * on any of them, before writing) and the warnings (§5.3 step 1). With `--parity`, the parity check
 * the migration ends with, over the copies already made — after the migration, or on a rehearsal.
 * Exit 1 when any org is blocked or any parity check fails.
 *
 * Read-only, so it needs no home check; it connects without building an index or creating a
 * collection, as every script that reads prod does.
 */
import { mongoose } from '../packages/db/src/connection.js'
import { config } from '../packages/config/src/index.js'
import { Org } from '../packages/db/src/models/index.js'
import { cashRegisterParity, cashRegisterPreflight } from '../packages/services/src/biz/cash-register/copy-org.js'

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

try {
  await mongoose.connect(config.mongodb.uri, { autoIndex: false, autoCreate: false })
  const db = mongoose.connection.db!
  const slug = arg('--org')
  let orgIds: string[]
  if (slug) {
    const org: any = await Org.findOne({ slug }, { _id: 1 }).lean().exec()
    if (!org) throw new Error(`no org with slug ${slug}`)
    orgIds = [String(org._id)]
  } else {
    orgIds = [...new Set([
      ...(await db.collection('postransactions').distinct('orgId')).map(String),
      ...(await db.collection('invoices').distinct('orgId', { type: 'cash_sale', 'register.origin': { $exists: false } })).map(String),
    ])].sort()
  }
  const slugs = new Map(((await Org.find({ _id: { $in: orgIds } }, { slug: 1 }).lean().exec()) as any[]).map(o => [String(o._id), o.slug]))

  let failed = false
  for (const orgId of orgIds) {
    const report = await cashRegisterPreflight(db as any, orgId)
    console.log(`\n${slugs.get(orgId) || orgId}: ${report.rows} POS row(s), ${report.copied} already copied`)
    for (const b of report.blockers) console.log(`  BLOCKER ${b.code}: ${b.message}${b.ids ? ` — ${b.ids.join(', ')}` : ''}`)
    for (const w of report.warnings) console.log(`  warning ${w.code}: ${w.message}${w.ids ? ` — ${w.ids.join(', ')}` : ''}`)
    if (report.blockers.length) failed = true
    if (args.includes('--parity') && report.copied) {
      const problems = await cashRegisterParity(db as any, orgId)
      console.log(problems.length ? `  PARITY: ${problems.length} problem(s)\n    ${problems.slice(0, 20).join('\n    ')}` : '  parity: the copies read as the rows did')
      if (problems.length) failed = true
    }
  }
  console.log(failed ? '\nBLOCKED — the migration would stop. Nothing was written.' : '\nReady — nothing blocks the copy. Nothing was written.')
  if (failed) process.exitCode = 1
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
