#!/usr/bin/env bun
/**
 * FR-25 R3: move the documents of a customer kept by its name alone to the one contact that holds its company number
 * and carries the same name, so the sales register names the partner as the filed one does. The rules, and what is left
 * alone, are `scripts/lib/name-only-customers.ts`; the import rule that stops new ones is `matching.ts#matchContactByName`.
 *
 *   bun scripts/relink-name-only-customers.ts --org <slug>
 *       the dry run. Counts only, no names and no numbers: the name-only customers, how many are kept twice, the
 *       documents and stock movements that would move, how many of them the books file under that same contact, and
 *       what is left alone and why.
 *   bun scripts/relink-name-only-customers.ts --org <slug> --execute --expect <documents> [--out <dir>]
 *       writes. Refused unless `--expect` is the dry run's count of documents to move. Before the first write it writes a
 *       manifest into `--out` (default: <temp>/relink-name-only-customers/, outside the checkout): each twin, the contact
 *       it moves to, its documents and movements. It holds document numbers: keep it private, and delete it once the run
 *       is accepted.
 *   bun scripts/relink-name-only-customers.ts --org <slug> --undo <manifest> [--execute]
 *       takes a run back where nothing changed since: a document or movement that still names the contact the run gave it
 *       names the twin again. A dry run without `--execute`.
 *
 * It writes only on the org's home (FR-20, P0b-6), connects without building indexes (#546), refuses to write without
 * the unique indexes of what it writes, and leaves one audit row a run, the script's own. Idempotent: a second run finds
 * nothing to move. No contact is changed or deleted, and no journal entry, VAT register row or tax return is written.
 */
import { readFileSync } from 'node:fs'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, Invoice, StockMovement } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import { RepairError, orgBySlug, parseArgs, writeManifest } from './lib/repair-run.js'
import { applyNameOnlyCustomers, manifestOf, parseManifest, planNameOnlyCustomers, undoNameOnlyCustomers } from './lib/name-only-customers.js'

const args = parseArgs(process.argv.slice(2))
const slug = typeof args.org === 'string' ? args.org : ''
const execute = !!args.execute
const undoFile = typeof args.undo === 'string' ? args.undo : ''
const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)

if (!slug || args.undo === true || args.out === true || args.expect === true) {
  console.error('Required: --org <slug>. --undo names its manifest, --out a folder, --expect the dry run\'s documents. See the header.')
  process.exit(2)
}

async function relink(org: { id: string }): Promise<number> {
  const plan = await planNameOnlyCustomers(org.id)
  console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  const c = plan.counts
  row(c.nameOnly, 'customers holding no company number that outgoing documents name')
  row(c.none, '  no other contact holding a number carries the name: left alone')
  row(c.several, '  several contacts holding a number carry the name: left alone, a person chooses')
  row(c.twins, '  exactly one does: kept twice, documents to move')
  row(c.documents, `documents to move (${c.booksAgree} filed in the books under the contact they move to, ${c.notInBooks} not in the books yet)`)
  row(c.movements, 'stock movements they made, moving with them')
  for (const [k, n] of Object.entries(c.left).sort(([a], [b]) => a.localeCompare(b))) row(n, `left: ${k}`)

  if (!execute) {
    console.log(`\nDry run — nothing written. Re-run with --execute --expect ${c.documents}.`)
    return 0
  }
  if (args.expect === undefined || Number(args.expect) !== c.documents) {
    console.error(`\nRefused: --expect must be ${c.documents} (the dry run's documents to move). Nothing was written.`)
    return 2
  }
  if (!c.documents) {
    console.log('\nNothing to move.')
    return 0
  }
  const file = writeManifest(manifestOf(plan, slug), typeof args.out === 'string' ? args.out : undefined)
  console.log(`\nManifest (holds document numbers: keep it private): ${file}`)

  const result = await applyNameOnlyCustomers(plan)
  for (const f of result.failed) console.log(`✗ ${f}`)
  console.log(`\nMoved: ${result.documents} of ${c.documents} documents, of ${result.twins} customers; stock movements ${result.movements}`)
  return result.failed.length ? 1 : 0
}

async function undo(org: { id: string }): Promise<number> {
  const manifest = parseManifest(readFileSync(undoFile, 'utf8'), org.id)
  console.log(`Org ${slug}, undo of the run of ${manifest.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  const n = await undoNameOnlyCustomers(manifest, execute)
  row(n.documents, 'documents in the manifest')
  row(n.back, execute ? 'moved back' : 'to move back')
  row(n.changed, 'changed since the run; left alone')
  row(n.gone, 'whose name-only contact is gone; left alone')
  row(n.movements, execute ? 'stock movements moved back' : 'stock movements to move back')
  if (!execute) console.log('\nDry run — nothing written. Re-run with --undo <the same manifest> --execute.')
  return 0
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await orgBySlug(slug)
  await assertScriptHome(org.id, slug)
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  if (execute) await requireUniqueIndexes([Invoice, StockMovement, AuditLog])
  code = undoFile ? await undo(org) : await relink(org)
} catch (e) {
  if (!(e instanceof RepairError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
