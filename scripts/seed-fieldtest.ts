#!/usr/bin/env bun
/**
 * `bun run scripts/seed-fieldtest.ts --org lgr-fieldtest-<name> [--seed 1] [--preset small|regal]
 *    [--server <url>] [--replace] [--execute]` — the synthetic field-test org (FR-20.112, plan T-2).
 *
 * The one data source a throwaway instance gets (FR-20.113, AC 45): shaped and sized like regal-pz,
 * invented from `--seed` by `scripts/lib/fieldtest-data.ts`. It never writes outside an org whose
 * slug is `lgr-fieldtest` or `lgr-fieldtest-<name>`, and it writes nothing without `--execute`.
 *
 * Three phases, each through the product's own paths:
 *   1. the database (MONGODB_URI): the org through `register()`, as a sign-up makes one, then its
 *      warehouse, categories, tags, products and contacts in bulk, with ids from the seed;
 *   2. the API (`--server`): goods receipts, created and confirmed, then sales invoices, created and
 *      issued, so numbering, stock and the journal are the server's own;
 *   3. the Files app (`--server`): the server's own invoice PDFs and Excel exports, uploaded.
 * Without `--server` it stops after phase 1.
 *
 * Deterministic: the same seed and preset give the same products, contacts and documents, and the
 * same ids for the warehouse, categories, products and contacts. The org and its admin are made by
 * `register()`, which picks their ids; what the server assigns (document ids, timestamps) and what
 * follows from the date (the year in a document number) is the server's.
 *
 * The admin signs in as `admin` with FIELDTEST_ADMIN_PASSWORD, or with a password this script
 * generates and writes to `.secrets/fieldtest-<org>.password` (never printed).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { Contact, Identity, Org, Product, ProductCategory, Tag, User, Warehouse } from '../packages/db/src/models/index.js'
import { register } from '../packages/services/src/biz/auth.service.js'
import { initServiceContext } from '../packages/services/src/context.js'
import { createMongoRepositories } from '../packages/dal-mongo/src/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import {
  CATEGORIES, FIELDTEST_SLUG, PRESETS, contacts as genContacts, documents as genDocuments,
  products as genProducts, stream,
} from './lib/fieldtest-data.ts'

const { values: args } = parseArgs({
  options: {
    org: { type: 'string' },
    seed: { type: 'string', default: '1' },
    preset: { type: 'string', default: 'small' },
    server: { type: 'string' },
    replace: { type: 'boolean', default: false },
    execute: { type: 'boolean', default: false },
  },
})

const slug = String(args.org ?? '')
const seed = Number(args.seed)
const presetName = String(args.preset) as keyof typeof PRESETS
const preset = PRESETS[presetName]

if (!FIELDTEST_SLUG.test(slug)) {
  console.error(`--org ${slug || '(missing)'} is not a field-test org. Only "lgr-fieldtest" and "lgr-fieldtest-<name>" can be seeded.`)
  process.exit(2)
}
if (!preset) {
  console.error(`--preset must be one of: ${Object.keys(PRESETS).join(', ')}`)
  process.exit(2)
}
if (!Number.isInteger(seed) || seed < 0) {
  console.error('--seed must be a non-negative integer')
  process.exit(2)
}

const products = genProducts(seed, preset.products)
const contacts = genContacts(seed, preset.contacts)
const { receipts, invoices } = genDocuments(seed, preset)
console.log(
  `${slug}, seed ${seed}, preset ${presetName}: ${products.length} products, ${contacts.length} contacts, ` +
    `${receipts.length} receipts, ${invoices.length} invoices, ${preset.files} files`,
)
if (!args.execute) {
  console.log('Dry run: nothing written. Pass --execute to write.')
  process.exit(0)
}

const ids = stream(seed, 'org-records')
const warehouseId = ids.objectId()
const categoryIds = CATEGORIES.map(() => ids.objectId())

// ── phase 1: the database ──────────────────────────────────────────────────────────────────────

function adminPassword(): string {
  if (process.env.FIELDTEST_ADMIN_PASSWORD) return process.env.FIELDTEST_ADMIN_PASSWORD
  const dir = join(import.meta.dir, '..', '.secrets')
  const file = join(dir, `fieldtest-${slug}.password`)
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(dir, { recursive: true })
  const generated = randomBytes(18).toString('base64url')
  writeFileSync(file, generated + '\n', { mode: 0o600 })
  console.log(`Admin password written to ${file}`)
  return generated
}

/**
 * Every document of `orgId`, in every collection that keys by org. Only ever a field-test org.
 * The bytes its Files app stored stay on disk: a throwaway instance goes with them.
 */
async function wipe(orgId: mongoose.Types.ObjectId): Promise<void> {
  const db = mongoose.connection.db!
  // Read before the users go: a person who is a member of nothing else goes with the org.
  const identityIds = (await User.find({ orgId }).select({ identityId: 1 }).lean()).map((u: any) => u.identityId).filter(Boolean)
  for (const c of await db.listCollections().toArray()) {
    const res = await db.collection(c.name).deleteMany({ orgId })
    if (res.deletedCount) console.log(`  removed ${res.deletedCount} from ${c.name}`)
  }
  await Org.deleteOne({ _id: orgId })
  for (const id of identityIds) if (!(await User.exists({ identityId: id }))) await Identity.deleteOne({ _id: id })
}

await connectDB()
// register() provisions the org's permission sets through the repositories, as the server's own start does.
initServiceContext(await createMongoRepositories({ backend: 'mongo' }))
const password = adminPassword()
const existing = await Org.findOne({ slug }).lean()
if (existing) {
  if (!args.replace) {
    console.error(`${slug} already exists. Pass --replace to delete it and seed it again.`)
    process.exit(1)
  }
  await assertScriptHome((existing as any)._id, slug)
  console.log(`Replacing ${slug}`)
  await wipe((existing as any)._id)
}

const email = `admin@${slug}.invalid`
// This generator's own admin, left by an earlier run that stopped half-way: a member of nothing.
const orphan = await Identity.findOne({ email }).select({ _id: 1 }).lean()
if (orphan) {
  if (await User.exists({ identityId: (orphan as any)._id })) {
    console.error(`${email} is a member of another org. Nothing was written.`)
    process.exit(1)
  }
  await Identity.deleteOne({ _id: (orphan as any)._id })
}
const { org, user } = await register({
  orgName: `LGR Field Test (${slug})`,
  orgSlug: slug,
  email,
  username: 'admin',
  password,
  firstName: 'Field',
  lastName: 'Test',
  baseCurrency: 'EUR',
  locale: 'bg',
} as any)
const orgId = org._id
await assertScriptHome(orgId, slug)
// No mail reaches `.invalid`: the synthetic admin is activated here instead of by its link.
await User.updateOne({ _id: user._id }, { $set: { isActive: true } })
if ((user as any).identityId) await Identity.updateOne({ _id: (user as any).identityId }, { $set: { isActive: true } })
await Org.updateOne({ _id: orgId }, { $set: { 'settings.timezone': 'Europe/Sofia' } })

await Warehouse.create({ _id: warehouseId, orgId, name: 'Централен склад', code: 'CENTRAL', type: 'warehouse', isDefault: true, isActive: true } as any)
await ProductCategory.insertMany(CATEGORIES.map((name, i) => ({ _id: categoryIds[i], orgId, name })))
const tagValues = [...new Set(products.flatMap(p => p.tags))]
for (let i = 0; i < tagValues.length; i += 1000) {
  await Tag.insertMany(tagValues.slice(i, i + 1000).map(value => ({ orgId, type: 'product', value })), { ordered: false })
}
const categoryIdOf = new Map(CATEGORIES.map((name, i) => [name, categoryIds[i]]))
for (let i = 0; i < products.length; i += 1000) {
  await Product.insertMany(products.slice(i, i + 1000).map(p => ({
    _id: p._id, orgId, sku: p.sku, name: p.name, category: p.category, categoryId: categoryIdOf.get(p.category),
    type: 'goods', unit: p.unit, purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice, tags: p.tags, isActive: true,
  })))
}
for (let i = 0; i < contacts.length; i += 1000) {
  await Contact.insertMany(contacts.slice(i, i + 1000).map(c => ({
    _id: c._id, orgId, type: c.type, companyName: c.companyName, taxId: c.taxId, vatNumber: c.vatNumber, email: c.email,
    addresses: [{ type: 'billing', street: c.street, city: c.city, country: 'BG', isDefault: true }], isActive: true,
  })))
}
console.log(`Phase 1: org ${slug} (${orgId}), ${products.length} products, ${tagValues.length} tags, ${contacts.length} contacts`)
await disconnectDB()

if (!args.server) {
  console.log('No --server: documents and files not created.')
  process.exit(0)
}

// ── phase 2: documents, through the API ────────────────────────────────────────────────────────

const base = String(args.server).replace(/\/+$/, '')
async function api(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const signIn = await api('POST', '/auth/login', { orgSlug: slug, username: 'admin', password })
const token: string = signIn.token
const o = `/org/${orgId}`
const suppliers = contacts.filter(c => c.type !== 'customer')
const customers = contacts.filter(c => c.type !== 'supplier')
const round2 = (n: number) => Math.round(n * 100) / 100
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
// Receipts are dated before every sale; both fall within the last ~180 days, as a live shop's do.
const span = 180

let t0 = Date.now()
for (const [n, lines] of receipts.entries()) {
  const items = lines.map(l => {
    const p = products[l.productIndex]
    return { productId: p._id, quantity: l.quantity, unitCost: p.purchasePrice, totalCost: round2(l.quantity * p.purchasePrice) }
  })
  const { stockMovement } = await api('POST', `${o}/warehouse/movement`, {
    type: 'receipt',
    date: day(span + receipts.length - n),
    toWarehouseId: warehouseId,
    contactId: suppliers[n % suppliers.length]?._id,
    lines: items,
    totalAmount: round2(items.reduce((s, i) => s + i.totalCost, 0)),
    reference: `FT-R-${String(n + 1).padStart(5, '0')}`,
  }, token)
  await api('POST', `${o}/warehouse/movement/${stockMovement.id ?? stockMovement._id}/confirm`, {}, token)
}
console.log(`Phase 2: ${receipts.length} receipts confirmed in ${Math.round((Date.now() - t0) / 1000)} s`)

t0 = Date.now()
const issued: Array<{ id: string; issueDate: string }> = []
for (const [n, inv] of invoices.entries()) {
  const lines = inv.lines.map(l => {
    const p = products[l.productIndex]
    const net = round2(l.quantity * p.sellingPrice)
    return {
      productId: p._id, description: p.name, quantity: l.quantity, unit: p.unit, unitPrice: p.sellingPrice,
      discount: 0, taxRate: 20, taxAmount: round2(net * 0.2), lineTotal: round2(net * 1.2), warehouseId,
    }
  })
  const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0))
  const taxTotal = round2(subtotal * 0.2)
  const issueDate = day(Math.round(((invoices.length - n) / invoices.length) * span))
  const { invoice } = await api('POST', `${o}/invoices`, {
    type: 'invoice',
    direction: 'outgoing',
    contactId: customers[inv.contactIndex % customers.length]._id,
    issueDate,
    dueDate: day(Math.round(((invoices.length - n) / invoices.length) * span) - 30),
    currency: 'EUR',
    lines,
    subtotal,
    taxTotal,
    total: round2(subtotal + taxTotal),
    paymentMethod: 'bank_transfer',
  }, token)
  const id = invoice.id ?? invoice._id
  await api('POST', `${o}/invoices/${id}/send`, {}, token)
  issued.push({ id, issueDate })
}
console.log(`Phase 2: ${invoices.length} invoices issued in ${Math.round((Date.now() - t0) / 1000)} s`)

// ── phase 3: files, rendered by the server and uploaded ────────────────────────────────────────

/**
 * A fifth of the files are invoice PDFs and the rest Excel exports of the outgoing register over a
 * window of one to fourteen days, so the total lands near regal-pz's (~1.5k files, ~76 MB): an
 * invoice PDF is ~200 KB, a week's export a few dozen. An export of the whole register each time
 * grew past a hundred kilobytes and took seconds to render.
 */
t0 = Date.now()
const pdfCount = Math.min(issued.length, Math.round(preset.files / 5))
const batch: Array<{ name: string; bytes: Uint8Array; docDate: string }> = []
let uploaded = 0
let bytesUploaded = 0

async function flush(): Promise<void> {
  if (!batch.length) return
  // One upload per date, as the UI uploads a day's folder.
  const byDate = new Map<string, typeof batch>()
  for (const f of batch) byDate.set(f.docDate, [...(byDate.get(f.docDate) ?? []), f])
  for (const [docDate, files] of byDate) {
    const form = new FormData()
    for (const f of files) form.append('files', new File([f.bytes], f.name))
    form.append('docDate', docDate)
    const res = await fetch(`${base}/api${o}/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
    if (!res.ok) throw new Error(`upload → ${res.status} ${(await res.text()).slice(0, 300)}`)
    uploaded += files.length
    bytesUploaded += files.reduce((s, f) => s + f.bytes.length, 0)
  }
  batch.length = 0
}

for (let i = 0; i < preset.files; i++) {
  let bytes: Uint8Array
  let name: string
  let docDate: string
  if (i < pdfCount) {
    const inv = issued[i % issued.length]
    const res = await fetch(`${base}/api${o}/invoicing/export/${inv.id}?format=pdf&locale=bg`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`invoice PDF → ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
    name = `lgr-invoice-${String(i + 1).padStart(5, '0')}.pdf`
    docDate = inv.issueDate
  } else {
    const endOffset = ((i - pdfCount) % span) + 1
    const end = day(endOffset)
    const res = await fetch(`${base}/api${o}/invoicing/export/kind/outgoing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'xlsx', mode: i % 2 ? 'compact' : 'detailed', startDate: day(endOffset + ((i * 7) % 14)), endDate: end, locale: 'bg' }),
    })
    if (!res.ok) throw new Error(`register export → ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
    name = `lgr-register-${String(i + 1).padStart(5, '0')}.xlsx`
    docDate = end
  }
  batch.push({ name, bytes, docDate })
  if (batch.length >= 50) await flush()
}
await flush()
console.log(`Phase 3: ${uploaded} files, ${(bytesUploaded / 1e6).toFixed(1)} MB, in ${Math.round((Date.now() - t0) / 1000)} s`)
console.log(`Done: ${slug} is seeded.`)
