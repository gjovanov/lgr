/**
 * Idempotently upsert contacts (customers or suppliers) into an existing org from
 * a legacy "ap_*.json" export (ap_КЛИЕНТИ_* = clients, ap_ДОСТАВЧИЦИ_* = suppliers).
 *
 * Source shape (array): { ap: "КЛИЕНТИ:<name> - <legal form>", params: {
 *   АДРЕС: address, БУЛСТАТ: EIK, ГРАД: city, ИНДДС: VAT no, МОЛ?: contact person, ТЕЛЕФОН?: phone } }
 * Files are typically Windows-1251 (CP1251) encoded — auto-detected (falls back from UTF-8).
 *
 * Mapping → Contact: type (from --type), companyName (ap minus the "PREFIX:" label),
 * taxId ← БУЛСТАТ, vatNumber ← ИНДДС, phone ← ТЕЛЕФОН, notes ← АДРЕС / ГРАД / МОЛ.
 * (No structured address: the schema requires postalCode, which the source lacks — the
 * street+city are preserved in notes; structure them per-contact later if needed.)
 *
 * Upsert key (idempotent): (orgId, type, taxId) when БУЛСТАТ present, else
 * (orgId, type, vatNumber) when ИНДДС present, else (orgId, type, companyName).
 *
 * Usage:
 *   bun run scripts/seed-contacts.ts --org <slug> --type customer  --file ap_КЛИЕНТИ_*.json            # dry-run
 *   bun run scripts/seed-contacts.ts --org <slug> --type supplier  --file ap_ДОСТАВЧИЦИ_*.json --execute
 *
 * Options:
 *   --org <slug>   (required) target org — must already exist
 *   --type <t>     (required) customer | supplier
 *   --file <path>  (required) ap_*.json export
 *   --execute      perform writes (default: dry-run — parses + reports, no DB)
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Contact } from '../packages/db/src/models/index.js'
import { readFileSync } from 'node:fs'
import path from 'path'

// CP1251 high range (0x80–0xFF) → Unicode, for the common Windows Cyrillic export encoding.
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ' + 'ђ‘’“”•–—�™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї' + '°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОП' + 'РСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмноп' + 'рстуфхцчшщъыьэюя'
function decodeCp1251(buf: Buffer): string {
  let s = ''
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP1251_HIGH[b - 0x80]
  return s
}
function readContactsJson(fp: string): any[] {
  const buf = readFileSync(fp)
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('�')) { try { return JSON.parse(utf8) } catch { /* fall through */ } }
  return JSON.parse(decodeCp1251(buf))
}

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
const dryRun = !args.execute
const orgSlug = args.org as string
const filePath = args.file as string
const typeArg = args.type as string
const TYPE_MAP: Record<string, string> = { customer: 'customer', client: 'customer', supplier: 'supplier', vendor: 'supplier' }
const type = TYPE_MAP[typeArg]

if (!orgSlug || !filePath || !type) {
  console.error('Required: --org <slug> --type <customer|supplier> --file <ap_*.json>')
  process.exit(2)
}

function clean(v: unknown): string { return String(v ?? '').trim() }
// Mirror the loweredFieldsPlugin (locale 'bg') — bulkWrite bypasses its hooks, so
// we maintain the *Lower search mirrors ourselves (Cyrillic-safe contact search).
const lowerBg = (v?: string) => (typeof v === 'string' && v ? v.toLocaleLowerCase('bg') : undefined)
function companyNameOf(ap: string): string {
  const i = ap.indexOf(':')
  return (i >= 0 ? ap.slice(i + 1) : ap).trim()
}
function mapContact(item: any) {
  const p = item.params || {}
  const companyName = companyNameOf(clean(item.ap))
  const taxId = clean(p['БУЛСТАТ']) || undefined
  const vatNumber = clean(p['ИНДДС'] || p['ИН ПО ДДС']) || undefined
  const phone = clean(p['ТЕЛЕФОН']) || undefined
  const notesParts = [
    clean(p['АДРЕС']) && `Адрес: ${clean(p['АДРЕС'])}`,
    clean(p['ГРАД']) && `Град: ${clean(p['ГРАД'])}`,
    clean(p['МОЛ']) && `МОЛ: ${clean(p['МОЛ'])}`,
  ].filter(Boolean)
  return {
    companyName, taxId, vatNumber, phone, notes: notesParts.join('\n') || undefined,
    companyNameLower: lowerBg(companyName), taxIdLower: lowerBg(taxId), vatNumberLower: lowerBg(vatNumber),
  }
}
function matchKey(c: ReturnType<typeof mapContact>): Record<string, string> {
  if (c.taxId) return { taxId: c.taxId }
  if (c.vatNumber) return { vatNumber: c.vatNumber }
  return { companyName: c.companyName }
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'} | type: ${type}`)
  console.log(`Org: ${orgSlug} | file: ${filePath}`)

  const raw = readContactsJson(path.resolve(filePath))
  const mapped = raw.map(mapContact).filter(c => c.companyName)
  const withEik = mapped.filter(c => c.taxId).length
  const withVat = mapped.filter(c => c.vatNumber).length
  const nameOnly = mapped.filter(c => !c.taxId && !c.vatNumber).length
  console.log(`Parsed: ${mapped.length} contacts (${raw.length} rows) | with EIK: ${withEik} | with VAT: ${withVat} | name-only key: ${nameOnly}`)
  for (const c of mapped.slice(0, 3)) console.log(`  ${c.companyName} | taxId=${c.taxId || '-'} vat=${c.vatNumber || '-'} phone=${c.phone || '-'}`)
  console.log()

  if (dryRun) { console.log('Dry run complete. Add --execute to upsert.'); return }

  await connectDB()
  console.log('Connected to MongoDB')
  const org = await Org.findOne({ slug: orgSlug })
  if (!org) { console.error(`Org "${orgSlug}" not found.`); process.exit(1) }

  const currency = org.settings?.baseCurrency || 'BGN'
  const dropUndefined = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  const ops = mapped.map(c => ({
    updateOne: {
      filter: { orgId: org._id, type, ...matchKey(c) },
      update: { $set: dropUndefined({ ...c, type, currency }), $setOnInsert: { orgId: org._id, isActive: true } },
      upsert: true,
    },
  }))

  let matched = 0, upserted = 0, modified = 0
  const BATCH = 500
  for (let i = 0; i < ops.length; i += BATCH) {
    const r = await Contact.bulkWrite(ops.slice(i, i + BATCH), { ordered: false })
    matched += r.matchedCount; upserted += r.upsertedCount; modified += r.modifiedCount
    console.log(`  ${Math.min(i + BATCH, ops.length)} / ${ops.length} (upserted ${r.upsertedCount}, modified ${r.modifiedCount})`)
  }
  const total = await Contact.countDocuments({ orgId: org._id, type })
  console.log(`\nDone. inserted ${upserted}, updated ${modified}, matched ${matched}. Total ${type} contacts in org: ${total}`)
}

await main()
await disconnectDB()
