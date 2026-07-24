/**
 * Wire legacy PlusMinus client price groups into LGR's tag-based tier pricing for one org.
 *
 * Phase 1 — TIERS: every product price tier with finalPrice > 0 (except the cost tier
 *   "Доставна цена") gets `tags: [<tier name>]`, making it resolvable for contacts that
 *   carry the same tag (resolvePrice step 4). Empty slots and the cost tier stay
 *   filterless (display-only). Tiers that already carry other filters (custom tags,
 *   contactIds, minQuantity, validity) are treated as user-managed and skipped.
 *
 * Phase 2 — CONTACTS: derives each customer's price group from the already-imported
 *   legacy invoices (tags: 'ocr-import', direction outgoing): for every line whose
 *   product matched, the candidate groups are the tiers whose finalPrice equals the
 *   line's unitPrice (4-decimal exact). The group that explains the most lines wins.
 *   A contact is tagged (`$addToSet`) only on an unambiguous win: sole top candidate,
 *   ≥ MIN_LINES explaining lines and ≥ MIN_SHARE of explainable lines — everything
 *   else is reported for manual review. A contact that already carries a different
 *   "Цена …" tag is reported as a conflict and left unchanged.
 *
 * Idempotent: re-runs produce no additional writes once tiers/tags are in place.
 *
 * Usage:
 *   bun run scripts/assign-price-group-tags.ts --org regal-pz              # dry-run
 *   bun run scripts/assign-price-group-tags.ts --org regal-pz --execute
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Product, Contact, Invoice } from '../packages/db/src/models/index.js'

const COST_TIER = 'Доставна цена'
const GROUP_TAG_RE = /^Цена( на едро| ?\d)$/
const MIN_LINES = 2
const MIN_SHARE = 0.6

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
const orgSlug = String(args.org || '')
const execute = !!args.execute
if (!orgSlug) {
  console.error('Usage: bun run scripts/assign-price-group-tags.ts --org <slug> [--execute]')
  process.exit(1)
}

const p4 = (n: number) => Math.round(n * 1e4)

await connectDB()
const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
const orgId = org._id
console.log(`Org ${orgSlug} (${orgId}) — ${execute ? 'EXECUTE' : 'DRY-RUN'}`)

// ── Phase 1: tag sales tiers with their own name ─────────────────────────────
let scanned = 0, toUpdate = 0, updated = 0, customSkipped = 0
const bulk: any[] = []
const cursor = Product.find({ orgId, 'priceTiers.0': { $exists: true } })
  .select({ priceTiers: 1 }).lean().cursor()
for await (const prod of cursor) {
  scanned++
  let changed = false
  let custom = false
  const tiers = ((prod as any).priceTiers || []).map((t: any) => {
    const hasOtherFilters =
      (Array.isArray(t.contactIds) && t.contactIds.length > 0) ||
      t.minQuantity != null || t.validFrom != null || t.validTo != null ||
      (Array.isArray(t.tags) && t.tags.length > 0 && !(t.tags.length === 1 && t.tags[0] === t.name))
    if (hasOtherFilters) { custom = true; return t }
    const desired = t.finalPrice > 0 && t.name !== COST_TIER ? [t.name] : []
    const current = Array.isArray(t.tags) ? t.tags : []
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      changed = true
      return { ...t, tags: desired }
    }
    return t
  })
  if (custom) customSkipped++
  if (changed) {
    toUpdate++
    bulk.push({ updateOne: { filter: { _id: prod._id }, update: { $set: { priceTiers: tiers } } } })
    if (execute && bulk.length >= 500) {
      const res = await Product.bulkWrite(bulk.splice(0), { ordered: false })
      updated += res.modifiedCount || 0
    }
  }
}
if (execute && bulk.length) {
  const res = await Product.bulkWrite(bulk.splice(0), { ordered: false })
  updated += res.modifiedCount || 0
}
console.log(`\nPhase 1 (tiers): scanned=${scanned} needingUpdate=${toUpdate} updated=${execute ? updated : 0} customManagedProducts=${customSkipped}`)

// ── Phase 2: derive contact price groups from imported invoices ──────────────
const invoices: any[] = await Invoice.find({
  orgId, type: 'invoice', direction: 'outgoing', tags: 'ocr-import',
}).select({ contactId: 1, invoiceNumber: 1, lines: 1 }).lean()

const productIds = new Set<string>()
for (const inv of invoices) for (const l of inv.lines || []) if (l.productId) productIds.add(String(l.productId))
const prods: any[] = await Product.find({ _id: { $in: [...productIds] } }).select({ priceTiers: 1, sellingPrice: 1 }).lean()
const prodMap = new Map(prods.map(p => [String(p._id), p]))

interface Acc { total: number; explainable: number; counts: Map<string, number>; invoices: Set<string> }
const byContact = new Map<string, Acc>()
for (const inv of invoices) {
  if (!inv.contactId) continue
  const key = String(inv.contactId)
  const acc = byContact.get(key) || { total: 0, explainable: 0, counts: new Map(), invoices: new Set() }
  byContact.set(key, acc)
  acc.invoices.add(inv.invoiceNumber)
  for (const l of inv.lines || []) {
    if (!l.productId || !(l.unitPrice > 0)) continue
    acc.total++
    const prod = prodMap.get(String(l.productId))
    if (!prod) continue
    const candidates = (prod.priceTiers || [])
      .filter((t: any) => t.finalPrice > 0 && t.name !== COST_TIER && p4(t.finalPrice) === p4(l.unitPrice))
      .map((t: any) => t.name)
    if (!candidates.length) continue
    acc.explainable++
    for (const name of candidates) acc.counts.set(name, (acc.counts.get(name) || 0) + 1)
  }
}

const contacts: any[] = await Contact.find({ _id: { $in: [...byContact.keys()] } }).select({ companyName: 1, tags: 1 }).lean()
const contactMap = new Map(contacts.map(c => [String(c._id), c]))

let assigned = 0, already = 0, conflicts = 0, undecided = 0
console.log(`\nPhase 2 (contacts): ${byContact.size} customers across ${invoices.length} imported invoices`)
for (const [cid, acc] of byContact) {
  const contact = contactMap.get(cid)
  const name = contact?.companyName || cid
  const ranked = [...acc.counts.entries()].sort((a, b) => b[1] - a[1])
  const [top, second] = ranked
  const existingGroupTags = (contact?.tags || []).filter((t: string) => GROUP_TAG_RE.test(t))
  const stats = `lines=${acc.total} explainable=${acc.explainable} candidates=${ranked.map(([n, c]) => `${n}:${c}`).join(' ') || '—'}`

  if (!top || top[1] < MIN_LINES || (second && second[1] === top[1]) || top[1] / Math.max(acc.explainable, 1) < MIN_SHARE) {
    undecided++
    console.log(`  ? ${name} — undecided (${stats})`)
    continue
  }
  const group = top[0]
  if (existingGroupTags.length && !existingGroupTags.includes(group)) {
    conflicts++
    console.log(`  ! ${name} — has [${existingGroupTags.join(', ')}], derived "${group}" (${stats}) — left unchanged`)
    continue
  }
  if (existingGroupTags.includes(group)) {
    already++
    console.log(`  = ${name} — already "${group}"`)
    continue
  }
  assigned++
  console.log(`  + ${name} → "${group}" (${stats})`)
  if (execute) await Contact.updateOne({ _id: cid }, { $addToSet: { tags: group } })
}
console.log(`\nPhase 2 summary: assigned=${execute ? assigned : 0}${execute ? '' : ` (would assign ${assigned})`} already=${already} conflicts=${conflicts} undecided=${undecided}`)

await disconnectDB()
