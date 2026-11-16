#!/usr/bin/env bun
/**
 * FR-25 R7: point what the books hold of a contact the first split import made a second time at the older contact
 * the store already had, and remove the second one. The rules are `scripts/lib/relink-books-contacts.ts`; the
 * matching rule that stops new ones is `contact-match.ts`.
 *
 *   bun scripts/relink-books-contacts.ts --org <slug>
 *       the dry run. Counts only, no names: the contacts the books import made, the pairs (made a second time for a
 *       company an older contact holds a number of), what is left alone and why, and what a run would change.
 *   bun scripts/relink-books-contacts.ts --org <slug> --execute --expect <pairs> [--out <dir>]
 *       writes. Refused unless `--expect` is the dry run's count of pairs. Before the first write it writes a manifest
 *       into `--out` (default: <temp>/relink-books-contacts/, outside the checkout): every pair, the analytics and
 *       journal lines it moves, and each made contact whole. It holds names and tax numbers: keep it private, and
 *       delete it once the run is accepted.
 *   bun scripts/relink-books-contacts.ts --org <slug> --undo <manifest> [--execute]
 *       takes a run back where nothing changed since: the made contacts it deleted are made again as they were (same
 *       id, same fields), and the analytics and lines it moved point at them again. A dry run without `--execute`.
 *
 * Only for an org keeping a share of split books (`settings.accounting.books.split`): a books org of its own is
 * refused. It writes only on the org's home (FR-20, P0b-6), connects without building indexes (#546), refuses to
 * write without the unique indexes of what it writes, and leaves one audit row a run, the script's own.
 * Idempotent: a second run finds no pair.
 *
 * ⚠ Run it while no import writes into the org (the books nightly, the daily documents). The next books import
 * reports the re-pointed entries `changed`, once, and writes them as they already are: the contact on a line is part
 * of an imported entry's stored hash.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AccountingAnalytic, AuditLog, Contact, JournalEntry } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import {
  RelinkError, applyRelink, manifestOf, manifestText, parseManifest, planRelink, splitOrg, undoRelink,
} from './lib/relink-books-contacts.js'

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
const slug = typeof args.org === 'string' ? args.org : ''
const execute = !!args.execute
const undoFile = typeof args.undo === 'string' ? args.undo : ''
const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)

if (!slug || args.undo === true || args.out === true || args.expect === true) {
  console.error('Required: --org <slug>. --undo names its manifest, --out a folder, --expect the dry run\'s pairs. See the header.')
  process.exit(2)
}

async function relink(org: { id: string; role: string }): Promise<number> {
  const plan = await planRelink(org.id)
  console.log(`Org ${slug} (the ${org.role} of a split) — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  if (!plan.since) {
    console.log('No books were imported into this org: nothing to relink.')
    return 0
  }
  console.log(`The books import began here at ${plan.since.toISOString()}. A contact made since, that only the books name, is the import's.\n`)

  const c = plan.counts
  row(c.partnerAnalytics, 'partner analytics point at a contact made since')
  row(c.made, 'contacts made since, so pointed at')
  row(c.noNumber, '  hold no number: never matched by name; left alone')
  row(c.noOlder, '  hold numbers no older contact holds; left alone')
  row(c.madeTwice, '    of which another made contact holds one too')
  row(c.withOlder, '  hold a number an older contact holds')
  row(c.namedElsewhere, '    named by something besides the books (a document, a file, an edit in the app); left alone')
  row(c.pairs, '    PAIRS: a second contact for the older one; relinked to it')
  for (const [types, n] of Object.entries(c.byType).sort()) row(n, `      made ${types.replace('<-', ', older ')}`)
  row(c.keepDeactivated, '      of which the older contact is deactivated')
  row(c.lookAlikes, 'left alone, sharing their name with an older contact that holds no number (a number is never matched by name)')
  console.log('')
  row(c.analytics, 'analytics to point at the older contact')
  row(c.entries, `journal entries to re-point (${c.lines} lines)`)
  row(c.pairs, 'made contacts to delete, each only when nothing names it after the re-point')

  if (!execute) {
    console.log(`\nDry run — nothing written. Re-run with --execute --expect ${c.pairs}.`)
    return 0
  }
  if (args.expect === undefined || Number(args.expect) !== c.pairs) {
    console.error(`\nRefused: --expect must be ${c.pairs} (the dry run's pairs). Nothing was written.`)
    return 2
  }
  if (!c.pairs) {
    console.log('\nNothing to relink.')
    return 0
  }

  const manifest = await manifestOf(plan, slug)
  const dir = typeof args.out === 'string' ? args.out : join(tmpdir(), 'relink-books-contacts')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `relink-books-contacts-${slug}-${manifest.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, manifestText(manifest))
  console.log(`\nManifest (holds names and tax numbers: keep it private): ${file}`)

  const result = await applyRelink(plan)
  for (const f of result.failed) console.log(`✗ ${f}`)
  console.log(`\nRe-pointed: analytics ${result.analytics} of ${c.analytics}, journal entries ${result.entries}, lines ${result.lines}`)
  console.log(`Made contacts deleted: ${result.deleted}; kept, because something still names them: ${result.kept}`)
  console.log(`The next books import into ${slug} reports the re-pointed entries as changed, once.`)
  return result.failed.length ? 1 : 0
}

async function undo(org: { id: string }): Promise<number> {
  const manifest = parseManifest(readFileSync(undoFile, 'utf8'), org.id)
  console.log(`Org ${slug}, undo of the run of ${manifest.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  const n = await undoRelink(manifest, execute)
  row(n.pairs, 'pairs in the manifest')
  row(n.contacts, execute ? 'made contacts made again' : 'made contacts to make again (the run deleted them)')
  row(n.analytics, execute ? 'analytics pointed back' : 'analytics to point back')
  row(n.lines, `${execute ? 'journal lines pointed back' : 'journal lines to point back'}, in ${n.entries} entries`)
  if (!execute) console.log(`\nDry run — nothing written. Re-run with --undo <the same manifest> --execute.`)
  return 0
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await splitOrg(slug)
  await assertScriptHome(org.id, slug)
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  if (execute) await requireUniqueIndexes([AccountingAnalytic, JournalEntry, Contact, AuditLog])
  code = undoFile ? await undo(org) : await relink(org)
} catch (e) {
  if (!(e instanceof RelinkError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
