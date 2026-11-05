#!/usr/bin/env bun
/**
 * Deactivate the analytics and contacts the GUI export's damage left in a books org (FR-25 §9): names
 * holding U+FFFD that nothing points at. See `scripts/lib/books-leftovers.ts` for exactly what it plans.
 *
 *   bun scripts/deactivate-books-leftovers.ts --org regal-acc [--list <private file.tsv>]
 *       the dry run: counts only, and the analytics by root. `--list` writes the planned rows to a file.
 *   bun scripts/deactivate-books-leftovers.ts --org regal-acc --execute --expect-analytics <n> --expect-contacts <m> \
 *       [--backup <file.ndjson>] [--reason "<text>"]
 *
 * It refuses to write without both counts equal to the dry run's, and on a node that is not the org's home
 * (FR-20, P0b-6). Before the first write every row it will touch goes to an NDJSON backup. Each write is
 * conditional on what the plan read, and afterwards nothing outside the plan may point at a row it
 * deactivated. The audit rows are the org's, under its owner.
 *
 * It connects without building indexes or collections: a checkout ahead of the deployed app must not
 * create its indexes on prod. It writes documents only.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AccountingAnalytic, Contact, Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { applyBooksLeftovers, BROKEN, planBooksLeftovers, pointersFromOutside } from './lib/books-leftovers.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const slug = args.org ? String(args.org) : ''
const execute = !!args.execute
const reason = String(args.reason || 'FR-25 §9: a name the GUI export broke (U+FFFD); the archive spells it right, and nothing points at this row; scripts/deactivate-books-leftovers.ts')

if (!slug) { console.error('Required: --org <slug>. See the header.'); process.exit(2) }

async function main(): Promise<number> {
  const org: any = await Org.findOne({ slug }).select('slug ownerId').lean()
  if (!org) { console.error(`Org "${slug}" not found`); return 1 }
  await assertScriptHome(org._id, slug)
  console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const plan = await planBooksLeftovers(org._id)
  for (const [k, n] of Object.entries(plan.counts)) console.log(`${String(n).padStart(6)}  ${k}`)
  const byRoot: Record<string, number> = {}
  for (const a of plan.analytics) {
    const root = a.root.includes(BROKEN) ? '(a root the export broke)' : a.root
    byRoot[root] = (byRoot[root] ?? 0) + 1
  }
  if (plan.analytics.length) console.log(`\nAnalytics to deactivate, by root: ${Object.entries(byRoot).map(([r, n]) => `${r} ${n}`).join(', ')}`)
  if (args.list) {
    writeFileSync(String(args.list), [
      ...plan.analytics.map(a => `analytic\t${a.id}\t${a.path}`),
      ...plan.contacts.map(c => `contact\t${c.id}\t${c.name}`),
    ].join('\n') + '\n')
    console.log(`Planned rows: ${args.list}`)
  }

  if (!execute) {
    console.log(`\nDry-run — nothing written. Re-run with --execute --expect-analytics ${plan.analytics.length} --expect-contacts ${plan.contacts.length}.`)
    return 0
  }
  if (Number(args['expect-analytics']) !== plan.analytics.length || Number(args['expect-contacts']) !== plan.contacts.length) {
    console.error(`Refused: --expect-analytics must be ${plan.analytics.length} and --expect-contacts ${plan.contacts.length} (the dry run's counts).`)
    return 2
  }
  if (!org.ownerId) { console.error(`Refused: ${slug} has no owner to record the change under.`); return 2 }

  const backup = String(args.backup || join(tmpdir(), `deactivate-books-leftovers-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`))
  writeFileSync(backup, `${JSON.stringify({ kind: 'header', script: 'deactivate-books-leftovers', org: slug, at: new Date(), reason })}\n`)
  for (const doc of await AccountingAnalytic.find({ _id: { $in: plan.analytics.map(a => a.id) } }).lean().exec()) appendFileSync(backup, `${JSON.stringify({ collection: 'accountinganalytics', doc })}\n`)
  for (const doc of await Contact.find({ _id: { $in: plan.contacts.map(c => c.id) } }).lean().exec()) appendFileSync(backup, `${JSON.stringify({ collection: 'contacts', doc })}\n`)
  console.log(`\nBackup: ${backup}`)

  const result = await applyBooksLeftovers(plan, org.ownerId, reason)
  for (const f of result.failed) console.log(`✗ FAILED ${f}`)
  console.log(`\nDeactivated: analytics ${result.analytics} of ${plan.analytics.length}, contacts ${result.contacts} of ${plan.contacts.length} | failed: ${result.failed.length}`)

  const outside = await pointersFromOutside(plan)
  for (const o of outside) console.log(`✗ POINTED AT ${o}`)
  console.log(`Pointers from outside the plan, after the run: ${outside.length}`)
  return result.failed.length || outside.length ? 1 : 0
}

await connectDB({ readOnly: true })
let code = 1
try {
  code = await main()
} finally {
  await disconnectDB()
}
process.exit(code)
