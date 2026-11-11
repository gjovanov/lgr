#!/usr/bin/env bun
/**
 * Name the supplier of the goods receipts that were booked without one (FR-28.12, for what was booked before it),
 * so the articles they brought in have a supplier in the Products list, the Supplier filter and the order dialog.
 * See `scripts/lib/receipt-supplier-backfill.ts` for what it reads, what it writes and what it leaves alone.
 *
 *   bun scripts/backfill-receipt-suppliers.ts --org <slug> [--names]
 *       the dry run. Counts only: how many receipts name nobody, why each group is left alone, how many it would
 *       name. `--names` adds the partner names that matched no single active supplier, with their receipts, for
 *       the person who will add or fix those contacts (names of the org's partners: keep that output private).
 *   bun scripts/backfill-receipt-suppliers.ts --org <slug> --execute --expect <receipts> [--manifest <file.ndjson>] [--reason "<text>"]
 *       writes. Refused unless `--expect` equals the dry run's count. The manifest (default: the temp folder) lists
 *       every receipt and the supplier it was given, and is written before the first change.
 *   bun scripts/backfill-receipt-suppliers.ts --org <slug> --undo <manifest.ndjson> [--execute --expect <receipts>]
 *       takes a run back: a receipt loses the supplier that run gave it, unless a document claimed it since or a
 *       person gave it another one.
 *
 * It writes only on the org's home (FR-20, P0b-6). Each write is conditional on what the plan read, is read back,
 * and leaves an audit entry on the receipt under the org's owner. Run it again after adding a supplier: it is
 * idempotent, and a receipt that names a supplier is never touched.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, StockMovement } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import {
  applyReceiptSupplier, countUndoable, planReceiptSupplierBackfill, undoReceiptSupplier, type ReceiptSupplierPlan,
} from './lib/receipt-supplier-backfill.js'

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
const undoFile = args.undo ? String(args.undo) : ''
const row = (n: number, label: string) => console.log(`${String(n).padStart(6)}  ${label}`)

if (!slug || args.undo === true) { console.error('Required: --org <slug>. An undo names its manifest: --undo <file.ndjson>. See the header.'); process.exit(2) }

// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
try {
  const org: any = await Org.findOne({ slug }).select('slug ownerId').lean()
  if (!org) { console.error(`Org "${slug}" not found`); process.exit(1) }
  const orgId = String(org._id)
  await assertScriptHome(org._id, slug)
  const ownerOrRefuse = () => {
    if (!org.ownerId) { console.error(`Refused: ${slug} has no owner to record the change under.`); process.exit(2) }
    return String(org.ownerId)
  }

  if (undoFile) {
    const lines = readFileSync(undoFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const header = lines.find(l => l.kind === 'header')
    if (header?.script !== 'backfill-receipt-suppliers' || header.orgId !== orgId) {
      console.error(`Refused: ${undoFile} is not a manifest of this script for ${slug}.`)
      process.exit(2)
    }
    const entries: ReceiptSupplierPlan[] = lines.filter(l => l.kind === 'receipt')
    const undoable = await countUndoable(orgId, entries)
    console.log(`Org ${slug}, undo of the run of ${header.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
    row(entries.length, 'receipts in the manifest')
    row(undoable, 'still name the supplier that run gave them, and no document holds them')
    if (!execute) {
      console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${undoable}.`)
    } else {
      if (Number(args.expect) !== undoable) { console.error(`Refused: --expect must be ${undoable} (the dry run's count).`); process.exit(2) }
      const by = ownerOrRefuse()
      const reason = String(args.reason || `the supplier scripts/backfill-receipt-suppliers.ts wrote on ${header.at} is taken back`)
      let done = 0
      for (const e of entries) if (await undoReceiptSupplier(orgId, e, by, reason)) done++
      console.log(`\nReceipts that name no supplier again: ${done} of ${entries.length} (the rest were claimed or changed since, and are left alone)`)
    }
  } else {
    console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
    const { counts, plans, unresolved } = await planReceiptSupplierBackfill(orgId)
    row(counts.receipts, 'completed receipts name no supplier')
    row(counts.notADelivery, 'say they are no delivery (a correction, a day\'s aggregate, goods coming back): left alone')
    row(counts.notCounted, 'were rolled back or are for the record only: left alone')
    row(counts.heldByADocument, 'are held by a document, which names its own supplier: left alone')
    row(counts.noPartnerKnown, 'have their partner written nowhere in LGR: left alone')
    row(counts.unresolved, `name a partner that matched no single active supplier (${unresolved.length} names): left alone`)
    row(counts.resolved, `receipts to name their supplier (${plans.filter(p => p.source === 'notes').length} from their notes, ${plans.filter(p => p.source === 'document').length} from their document)`)

    if (unresolved.length && args.names) {
      console.log('\nPartner names that matched no single active supplier. Add the supplier, make the contact a supplier, or leave it if it is one of the org\'s own stores; then run this again:')
      for (const u of unresolved) {
        const why = u.reason === 'ambiguous' ? `${u.candidates} active suppliers share the name` : u.heldBy ? `no active supplier; the name is held by: ${u.heldBy}` : 'no contact of that name'
        console.log(`   "${u.name}" — ${why} — ${u.receipts.length} receipt(s): ${u.receipts.join(', ')}`)
      }
    } else if (unresolved.length) {
      console.log('\n(--names lists those partner names with their receipts.)')
    }

    if (!execute) {
      console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${plans.length}.`)
    } else {
      if (Number(args.expect) !== plans.length) { console.error(`Refused: --expect must be ${plans.length} (the dry run's count).`); process.exit(2) }
      const by = ownerOrRefuse()
      const at = new Date().toISOString()
      const reason = String(args.reason || 'the supplier this receipt\'s own document names (FR-28.12); scripts/backfill-receipt-suppliers.ts')
      const manifest = String(args.manifest || join(tmpdir(), `backfill-receipt-suppliers-${slug}-${at.replace(/[:.]/g, '-')}.ndjson`))
      writeFileSync(manifest, `${JSON.stringify({ kind: 'header', script: 'backfill-receipt-suppliers', org: slug, orgId, at, reason })}\n`)
      for (const p of plans) appendFileSync(manifest, `${JSON.stringify({ kind: 'receipt', ...p })}\n`)
      console.log(`\nManifest: ${manifest}`)

      let done = 0, skipped = 0, failed = 0
      for (const p of plans) {
        const wrote = await applyReceiptSupplier(orgId, p, by, reason)
        if (!wrote) { skipped++; console.log(`- ${p.movementNumber}: changed since the plan, left alone`); continue }
        const after: any = await StockMovement.findById(p.movementId).select('contactId').lean().exec()
        if (String(after?.contactId) === p.contactId) done++
        else { failed++; console.log(`✗ FAILED ${p.movementNumber}: written, but reads back otherwise`) }
      }
      console.log(`\nReceipts that now name their supplier: ${done} of ${plans.length} | left alone: ${skipped} | failed: ${failed}`)
      console.log(`To take this run back: --org ${slug} --undo ${manifest}`)
      if (failed) process.exitCode = 1
    }
  }
} finally {
  await disconnectDB()
}
