#!/usr/bin/env bun
/**
 * FR-25a: move each contact's МОЛ out of its notes into `Contact.representative`. The rules are
 * `scripts/lib/contact-representative-backfill.ts`: only notes that are EXACTLY `МОЛ: <name>` move, a representative
 * that is set is never overwritten, any other notes are never touched.
 *
 *   bun scripts/backfill-contact-representative.ts --org <slug>
 *       the dry run. Counts only, no names: contacts with notes, how many are the МОЛ line and nothing else, how many
 *       would move, how many keep a representative of the same name (only the notes line goes), how many name
 *       someone else (left alone, both fields, for a person).
 *   bun scripts/backfill-contact-representative.ts --org <slug> --execute --expect <n> [--manifest <file.ndjson>]
 *       writes. Refused unless `--expect` is the dry run's count of contacts to change. The manifest (default: the
 *       temp folder) lists every contact and its notes line, BEFORE the first write. It holds people's names: keep it
 *       private, and delete it once the run is accepted.
 *   bun scripts/backfill-contact-representative.ts --org <slug> --undo <manifest.ndjson> [--execute --expect <n>]
 *       takes a run back where nobody changed the contact since.
 *
 * ⚠ The contact form shows `representative` only once FR-25a's UI step lands (docs/fr/FR-25a-books-schema-reconciliation.md,
 * the CRUD plan). Until then a moved МОЛ leaves the form's notes: run `--execute` after that step, or accept that.
 *
 * It writes only on the org's home (FR-20, P0b-6), connects without building indexes (#546), and leaves one audit
 * entry for the run under the org's owner. Idempotent: a second run finds nothing to move.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Contact, Org } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import {
  applyWrites, contactsWithNotes, planRepresentativeMoves, representativeWrites, undoWrites, type RepresentativeMove,
} from './lib/contact-representative-backfill.js'

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
const row = (n: number, label: string) => console.log(`${String(n).padStart(6)}  ${label}`)

if (!slug || args.undo === true || args.manifest === true) {
  console.error('Required: --org <slug>. An undo names its manifest (--undo <file.ndjson>). See the header.')
  process.exit(2)
}

// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
try {
  const org: any = await Org.findOne({ slug }).select('slug ownerId').lean()
  if (!org) { console.error(`Org "${slug}" not found`); process.exit(1) }
  const orgId = String(org._id)
  await assertScriptHome(org._id, slug)
  if (execute) await requireUniqueIndexes([Contact])
  const audit = (entityName: string, changes: Record<string, number>) => recordAuditEntry({
    orgId, userId: org.ownerId ? String(org.ownerId) : '', action: 'update', module: 'invoicing', entityType: 'contact', entityId: orgId,
    entityName, changes: Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
  } as any)

  if (undoFile) {
    const lines = readFileSync(undoFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const header = lines.find(l => l.kind === 'header')
    if (header?.script !== 'backfill-contact-representative' || header.orgId !== orgId) {
      console.error(`Refused: ${undoFile} is not a manifest of this script for ${slug}.`)
      process.exit(2)
    }
    const moves: RepresentativeMove[] = lines.filter(l => l.kind === 'move' || l.kind === 'clear')
    console.log(`Org ${slug}, undo of the run of ${header.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
    row(moves.length, 'contacts in the manifest')
    if (!execute) {
      console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${moves.length}.`)
    } else {
      if (Number(args.expect) !== moves.length) { console.error(`Refused: --expect must be ${moves.length} (the manifest's count).`); process.exit(2) }
      const done = await applyWrites(undoWrites(orgId, moves))
      await audit('МОЛ notes restored (scripts/backfill-contact-representative.ts --undo)', { restored: done })
      console.log(`\nContacts that keep their МОЛ in the notes again: ${done} of ${moves.length} (the rest changed since, and are left alone)`)
    }
  } else {
    const { moves, counts } = planRepresentativeMoves(await contactsWithNotes(orgId))
    const changing = counts.move + counts.clear
    console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
    row(counts.withNotes, 'contacts have notes')
    row(counts.otherNotes, 'hold more than the МОЛ line, or something else: left alone')
    row(counts.move, 'hold only the МОЛ line and have no representative: the name moves there, the notes line goes')
    row(counts.clear, 'hold only the МОЛ line and have that representative already: the notes line goes')
    row(counts.conflict, 'hold only the МОЛ line and have another representative: left alone, for a person')
    if (!execute) {
      console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${changing}.`)
    } else {
      if (Number(args.expect) !== changing) { console.error(`Refused: --expect must be ${changing} (the dry run's count).`); process.exit(2) }
      const at = new Date().toISOString()
      const manifest = typeof args.manifest === 'string' ? args.manifest : join(tmpdir(), `backfill-contact-representative-${slug}-${at.replace(/[:.]/g, '-')}.ndjson`)
      writeFileSync(manifest, `${JSON.stringify({ kind: 'header', script: 'backfill-contact-representative', org: slug, orgId, at })}\n`)
      for (const m of moves) if (m.kind !== 'conflict') appendFileSync(manifest, `${JSON.stringify(m)}\n`)
      console.log(`\nManifest (holds names, keep it private): ${manifest}`)
      const done = await applyWrites(representativeWrites(orgId, moves))
      await audit('МОЛ moved from notes to representative (scripts/backfill-contact-representative.ts)', { moved: counts.move, cleared: counts.clear, written: done })
      console.log(`Contacts changed: ${done} of ${changing} (the rest changed since the plan read them, and are left alone)`)
    }
  }
} finally {
  await disconnectDB()
}
