/**
 * Idempotently upsert contacts (customers or suppliers) into an existing org from
 * a legacy "ap_*.json" export (ap_КЛИЕНТИ_* = clients, ap_ДОСТАВЧИЦИ_* = suppliers).
 *
 * Source shape (array): { ap: "КЛИЕНТИ:<name> - <legal form>", params: {
 *   АДРЕС: address, БУЛСТАТ: EIK, ГРАД: city, ИНДДС: VAT no, МОЛ?: contact person, ТЕЛЕФОН?: phone } }
 * Files are typically Windows-1251 (CP1251) encoded — auto-detected (falls back from UTF-8).
 *
 * Mapping → Contact: type (from --type), companyName (ap minus the "PREFIX:" label),
 * taxId + taxNumber ← БУЛСТАТ (falling back to the digits of ИНДДС — the form's
 * "Tax Number (EIK)" field reads taxNumber), vatNumber ← ИНДДС, phone ← ТЕЛЕФОН,
 * addresses[0] ← { street: АДРЕС, city: ГРАД (minus the "гр." label), country: BG },
 * notes ← МОЛ only (address no longer dumped into notes).
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
  const vatNumber = clean(p['ИНДДС'] || p['ИН ПО ДДС']) || undefined
  // ЕИК: БУЛСТАТ when present, else the digits of ИНДДС (BG<eik>). Goes into BOTH
  // taxId (match/search key) and taxNumber (the form's "Tax Number (EIK)" field).
  const eik = clean(p['БУЛСТАТ']) || clean(vatNumber).replace(/\D/g, '') || undefined
  const phone = clean(p['ТЕЛЕФОН']) || undefined
  const street = clean(p['АДРЕС'])
  const city = clean(p['ГРАД']).replace(/^гр\.?\s*/i, '')
  const addresses = (street || city)
    ? [{ type: 'billing', street: street || city, city: city || undefined, country: 'BG', isDefault: true }]
    : undefined
  const notes = clean(p['МОЛ']) ? `МОЛ: ${clean(p['МОЛ'])}` : undefined
  return {
    companyName, taxId: eik, taxNumber: eik, vatNumber, phone, addresses, notes,
    companyNameLower: lowerBg(companyName), taxIdLower: lowerBg(eik), vatNumberLower: lowerBg(vatNumber),
    // Upsert key must match docs created by earlier seeder versions, which set taxId
    // only from БУЛСТАТ (never derived from ИНДДС) — key on the source field.
    srcEik: clean(p['БУЛСТАТ']) || undefined,
  }
}
function matchKey(c: ReturnType<typeof mapContact>): Record<string, string> {
  if (c.srcEik) return { taxId: c.srcEik }
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
  const ops = mapped.map(({ srcEik: _key, ...c }) => ({
    updateOne: {
      filter: { orgId: org._id, type, ...matchKey({ srcEik: _key, ...c } as any) },
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
