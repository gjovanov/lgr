/**
 * Backfill StockMovement.reference from the idempotency marker inside `notes`.
 *
 * Movements booked from a PlusMinus export carry their source document only as a marker in the
 * notes text — "Доставки — 2026-08-28 (stokrazp:3000016317)". `reference` promotes that to a real
 * field so it can be filtered, joined and shown in the product ledger. The marker prefix is NOT
 * always the file prefix: a 2000 КОРЕКЦИЯ marks itself `corr:` but arrives in a stokrazp_*.pdf.
 *
 *   bun run scripts/backfill-movement-reference.ts [--execute] [--org <slug>]
 *
 * Dry-run by default. Idempotent: only fills movements that have no reference yet.
 */
import mongoose from 'mongoose'

const EXECUTE = process.argv.includes('--execute')
const ORG_SLUG = (() => { const i = process.argv.indexOf('--org'); return i > 0 ? process.argv[i + 1] : undefined })()

/** Marker prefix → the file family it arrives in. */
const FILE_PREFIX: Record<string, string> = {
  stokrazp: 'stokrazp',
  corr: 'stokrazp',          // a КОРЕКЦИЯ is a стокова разписка
  sklrazp: 'sklrazp',
  sklisk: 'sklisk',
  storeOperations: 'storeOperations',
  invoicem: 'invoicem',
  salesAnalysis: 'salesAnalysis',
}

/** `(stokrazp:3000016317)` → `stokrazp_3000016317` */
export function referenceFromNotes(notes: string | undefined): string | undefined {
  const m = /\(([A-Za-z]+):([^)]+)\)/.exec(String(notes || ''))
  if (!m) return undefined
  const prefix = FILE_PREFIX[m[1]]
  const key = m[2].trim()
  return prefix && key ? `${prefix}_${key}` : undefined
}

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  await mongoose.connect(uri)
  const db = mongoose.connection.db!

  const orgFilter: Record<string, any> = {}
  if (ORG_SLUG) {
    const org = await db.collection('organizations').findOne({ slug: ORG_SLUG })
    if (!org) throw new Error(`org "${ORG_SLUG}" not found`)
    orgFilter.orgId = org._id
    console.log(`org ${ORG_SLUG} (${org._id})`)
  }

  const cursor = db.collection('stockmovements').find(
    { ...orgFilter, $or: [{ reference: { $exists: false } }, { reference: '' }, { reference: null }] },
    { projection: { notes: 1, movementNumber: 1 } },
  )

  const ops: any[] = []
  const byPrefix: Record<string, number> = {}
  let scanned = 0, noMarker = 0
  const sample: string[] = []
  for await (const m of cursor) {
    scanned++
    const reference = referenceFromNotes(m.notes)
    if (!reference) { noMarker++; continue }
    byPrefix[reference.split('_')[0]] = (byPrefix[reference.split('_')[0]] || 0) + 1
    if (sample.length < 8) sample.push(`${m.movementNumber} → ${reference}`)
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: { reference } } } })
  }

  console.log(`\nscanned ${scanned} movements without a reference`)
  console.log(`  ${ops.length} carry a marker  ·  ${noMarker} do not (manual/UI movements — left alone)`)
  for (const [p, n] of Object.entries(byPrefix).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${p}_*`)
  console.log('\nsample:'); sample.forEach(x => console.log('  ' + x))

  if (!EXECUTE) { console.log('\nDRY-RUN — re-run with --execute'); await mongoose.disconnect(); return }
  for (let i = 0; i < ops.length; i += 500) await db.collection('stockmovements').bulkWrite(ops.slice(i, i + 500))
  const left = await db.collection('stockmovements').countDocuments({ ...orgFilter, reference: { $exists: false } })
  console.log(`\n✓ wrote ${ops.length}; ${left} movements still have no reference (no marker in notes)`)
  await mongoose.disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
