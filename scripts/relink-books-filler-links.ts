#!/usr/bin/env bun
/**
 * FR-25 R7: put right the partner links the first split import made on a number that is no number. A partner
 * abroad carries a number typed to fill the box, several share one, and each of them was linked to the one contact
 * of the store that held it: another partner's. The rules are `scripts/lib/books-filler-links.ts`; the matching rule
 * that stops new ones is `contact-match.ts`.
 *
 *   bun scripts/relink-books-filler-links.ts --org <slug>
 *       the dry run. Counts only, no names and no numbers: the partner analytics linked to a contact, how today's
 *       rule agrees with them, the ones left alone and why, the wrong ones, and what a run would give each.
 *   bun scripts/relink-books-filler-links.ts --org <slug> --execute --expect <wrong> [--out <dir>]
 *       writes. Refused unless `--expect` is the dry run's count of wrong links. Before the first write it writes a
 *       manifest into `--out` (default: <temp>/relink-books-filler-links/, outside the checkout): every link, what it
 *       gets, the journal lines it moves, and each contact it makes. It holds names and tax numbers: keep it
 *       private, and delete it once the run is accepted.
 *   bun scripts/relink-books-filler-links.ts --org <slug> --undo <manifest> [--execute]
 *       takes a run back where nothing changed since: the analytics and lines it moved point at the contact they
 *       pointed at before, and a contact it made goes when nothing names it after that. A dry run without
 *       `--execute`.
 *
 * Only for an org keeping a share of split books (`settings.accounting.books.split`): a books org of its own is
 * refused. It writes only on the org's home (FR-20, P0b-6), connects without building indexes (#546), refuses to
 * write without the unique indexes of what it writes, and leaves one audit row a run, the script's own.
 * Idempotent: a second run finds nothing wrong.
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
import { RelinkError, splitOrg } from './lib/relink-books-contacts.js'
import { applyFillerLinks, manifestOf, manifestText, parseManifest, planFillerLinks, undoFillerLinks } from './lib/books-filler-links.js'

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
  console.error('Required: --org <slug>. --undo names its manifest, --out a folder, --expect the dry run\'s wrong links. See the header.')
  process.exit(2)
}

async function relink(org: { id: string; role: string }): Promise<number> {
  const plan = await planFillerLinks(org.id)
  console.log(`Org ${slug} (the ${org.role} of a split) — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const c = plan.counts
  row(c.partnerAnalytics, 'partner analytics are linked to a contact')
  row(c.byNumber, '  that holds a number of theirs')
  row(c.byName, '  of their exact name (they have no number)')
  row(c.dangling, '  that is gone; left alone')
  row(c.unexplained, '  that today\'s rule would not pick, with no filler to explain the link (renamed or retyped since?); left alone')
  row(c.noOwner, '  on a filler, and the contact is no other partner\'s (theirs, renamed since?); left alone')
  row(c.wrong, `  WRONG: on a filler, to a contact that is another partner's (${c.holders} such contacts)`)
  row(c.repoint, '    today\'s rule finds a contact of their own: pointed at it')
  row(c.create, '    none is found and the org\'s entries book on them: a contact is made, as the journal import makes one')
  row(c.unlink, '    none is found and nothing books on them: the link is removed')
  console.log('')
  row(c.entries, `journal entries to re-point (${c.lines} lines)`)

  if (!execute) {
    console.log(`\nDry run — nothing written. Re-run with --execute --expect ${c.wrong}.`)
    return 0
  }
  if (args.expect === undefined || Number(args.expect) !== c.wrong) {
    console.error(`\nRefused: --expect must be ${c.wrong} (the dry run's wrong links). Nothing was written.`)
    return 2
  }
  if (!c.wrong) {
    console.log('\nNothing to put right.')
    return 0
  }

  const manifest = manifestOf(plan, slug)
  const dir = typeof args.out === 'string' ? args.out : join(tmpdir(), 'relink-books-filler-links')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `relink-books-filler-links-${slug}-${manifest.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, manifestText(manifest))
  console.log(`\nManifest (holds names and tax numbers: keep it private): ${file}`)

  const result = await applyFillerLinks(plan)
  for (const f of result.failed) console.log(`✗ ${f}`)
  console.log(`\nPut right: analytics ${result.analytics} of ${c.wrong}, journal entries ${result.entries}, lines ${result.lines}`)
  console.log(`Contacts made: ${result.created}; links removed: ${result.unlinked}`)
  console.log(`The next books import into ${slug} reports the re-pointed entries as changed, once.`)
  return result.failed.length ? 1 : 0
}

async function undo(org: { id: string }): Promise<number> {
  const manifest = parseManifest(readFileSync(undoFile, 'utf8'), org.id)
  console.log(`Org ${slug}, undo of the run of ${manifest.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  const n = await undoFillerLinks(manifest, execute)
  row(n.links, 'links in the manifest')
  row(n.analytics, execute ? 'analytics pointed back' : 'analytics to point back')
  row(n.lines, `${execute ? 'journal lines pointed back' : 'journal lines to point back'}, in ${n.entries} entries`)
  row(n.contacts, execute ? 'contacts the run made, removed' : 'contacts the run made, to remove')
  row(n.kept, 'contacts the run made that something names by now; kept')
  row(n.gone, 'links whose former contact is gone; left alone')
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
