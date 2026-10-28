/**
 * The synthetic field-test org's data (FR-20.112, plan step T-2): shaped and sized like regal-pz,
 * invented from a seed. `scripts/seed-fieldtest.ts` writes it.
 *
 * Import-pure: no database, no clock, no network. The same seed gives the same products, contacts
 * and documents, byte for byte, and each kind of record draws from its own stream, so a preset with
 * more products does not change its contacts.
 *
 * ⚠ Nothing here may come from a real customer. Names are assembled from word lists, tax numbers
 * fail the EIK check digit on purpose (no real company has one), and every e-mail address is under
 * `.invalid` (RFC 2606), which no mail server delivers to.
 */
import catalog from '../data/din-catalog.json' with { type: 'json' }
import { extractFastenerFacets, formatDinTag } from '../../packages/services/src/biz/fastener-tags.utils.ts'

export interface Preset {
  products: number
  contacts: number
  /** Goods receipts that stock the products before anything sells. */
  receipts: number
  /** Issued sales invoices. Each dispatches its own stock movement. */
  invoices: number
  /** Documents in the Files app, rendered by the product itself. */
  files: number
}

/**
 * `regal` is regal-pz's shape (FR-20.112): ~23k products, ~2k contacts, ~550 invoices, ~900 stock
 * movements (550 dispatches + 350 receipts), ~1.5k files. `small` is the same shape, for CI.
 */
export const PRESETS: Record<'small' | 'regal', Preset> = {
  small: { products: 300, contacts: 60, receipts: 20, invoices: 30, files: 24 },
  regal: { products: 23_000, contacts: 2_000, receipts: 350, invoices: 550, files: 1_500 },
}

/** The only orgs the generator writes into (FR-20.113): `lgr-fieldtest`, or `lgr-fieldtest-<name>`. */
export const FIELDTEST_SLUG = /^lgr-fieldtest(-[a-z0-9]+(-[a-z0-9]+)*)?$/

// ── randomness ─────────────────────────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and the same everywhere JavaScript runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a: turns `<seed>:<stream>` into an independent seed per kind of record. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export function stream(seed: number, name: string): Random {
  return new Random(rng(hash(`${seed}:${name}`)))
}

export class Random {
  constructor(private next: () => number) {}
  float(): number { return this.next() }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)) }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)] }
  chance(p: number): boolean { return this.next() < p }
  /** Log-uniform between `min` and `max`: prices, where most are cheap and a few are not. */
  logUniform(min: number, max: number): number { return Math.exp(Math.log(min) + this.next() * (Math.log(max) - Math.log(min))) }
  /** A 24-hex ObjectId: deterministic, unlike the driver's, which is why the ids are stable. */
  objectId(): string {
    let hex = ''
    for (let i = 0; i < 12; i++) hex += this.int(0, 255).toString(16).padStart(2, '0')
    return hex
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ── products ───────────────────────────────────────────────────────────────────────────────────

export interface CatalogRow { din: string; category: string; categoryIndex: number; description: string; iso?: string[]; en?: string[] }
const ROWS = catalog as unknown as CatalogRow[]

/** The 12 fastener categories, in the catalogue's order. */
export const CATEGORIES = [...new Map(ROWS.map(r => [r.categoryIndex, r.category])).entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([, name]) => name)

const NOUN_BY_CATEGORY: Record<number, string[]> = {
  1: ['Болт'], 2: ['Винт'], 3: ['Винт'], 4: ['Винт'], 5: ['Винт'], 6: ['Шпилка', 'Резбов прът'],
  7: ['Гайка'], 8: ['Гайка'], 9: ['Шайба'], 10: ['Щифт', 'Шплент'], 11: ['Нит'], 12: ['Пръстен'],
}
/** Categories a regal-pz catalogue is heavy in: bolts, nuts and washers outnumber rivets. */
const CATEGORY_WEIGHT: Record<number, number> = { 1: 8, 2: 5, 3: 3, 4: 3, 5: 3, 6: 2, 7: 6, 8: 2, 9: 6, 10: 2, 11: 1, 12: 1 }
const DIAMETERS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]
const LENGTHS = [6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 150, 200]
const COATINGS = ['ZN', 'ZN', 'ZN', 'BL', 'HDG', 'YELLOW ZINC', 'A2', 'A4', 'МЕСИНГ']
const STRENGTHS = ['4.8', '5.6', '8.8', '8.8', '8.8', '10.9', '12.9']
/** The DIN rows each category draws from, by weight. */
const WEIGHTED_ROWS: CatalogRow[] = ROWS.flatMap(r => Array(CATEGORY_WEIGHT[r.categoryIndex] ?? 1).fill(r))

export interface FieldtestProduct {
  _id: string
  sku: string
  name: string
  category: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  tags: string[]
}

/** A name the way a regal-pz catalogue spells one, for a fastener of `row`'s standard. */
function fastenerName(r: Random, row: CatalogRow): { name: string; noun: string } {
  const noun = r.pick(NOUN_BY_CATEGORY[row.categoryIndex] ?? ['Елемент'])
  const d = r.pick(DIAMETERS)
  const length = () => r.pick(LENGTHS.filter(l => l >= d))
  const coating = r.pick(COATINGS)
  switch (row.categoryIndex) {
    case 1: case 2:
      return { noun, name: `${noun} ${row.din} М${d}Х${length()} ${coating} ${r.pick(STRENGTHS)}` }
    case 3: case 4: case 5: case 6:
      return { noun, name: `${noun} ${row.din} М${d}Х${length()} ${coating}` }
    case 7: case 8:
      return { noun, name: `${noun} ${row.din} М${d} ${coating} кл.${r.pick(['6', '8', '10'])}` }
    case 9:
      return { noun, name: `${noun} ${row.din} М${d} ${coating}${r.chance(0.3) ? ` - ${r.pick(['А', 'Б'])}` : ''}` }
    default:
      return { noun, name: `${noun} ${row.din} Ф${Math.max(2, Math.round(d / 2))}Х${length()} ${coating}` }
  }
}

/**
 * The tags `assign-din-tags` derives from a name: the DIN reference and its variant, the ISO and EN
 * equivalents the catalogue lists for it, the dimensions, the coating and the strength class.
 */
function tagsFor(name: string, row: CatalogRow & { iso?: string[]; en?: string[] }): string[] {
  const f = extractFastenerFacets(name)
  const tags = new Set<string>()
  for (const ref of f.din) {
    tags.add(`DIN ${ref.base}`)
    if (ref.variant) tags.add(formatDinTag(ref))
  }
  for (const t of [...(row.iso ?? []), ...(row.en ?? []), ...f.iso, ...f.en, ...f.dims, ...f.coatings]) tags.add(t)
  return [...tags]
}

/** `count` products: unique Cyrillic fastener names, and the tags the catalogue derives from them. */
export function products(seed: number, count: number): FieldtestProduct[] {
  const r = stream(seed, 'products')
  const seen = new Set<string>()
  const out: FieldtestProduct[] = []
  for (let i = 0; i < count; i++) {
    let row = r.pick(WEIGHTED_ROWS)
    let { name, noun } = fastenerName(r, row)
    for (let attempt = 0; seen.has(name) && attempt < 20; attempt++) {
      row = r.pick(WEIGHTED_ROWS)
      ;({ name, noun } = fastenerName(r, row))
    }
    // A catalogue this size sells the same part in several pack sizes.
    if (seen.has(name)) name = `${name} - опак. ${r.pick([50, 100, 200, 500, 1000])} бр`
    if (seen.has(name)) name = `${name} - ${i + 1}`
    seen.add(name)
    const purchasePrice = round2(r.logUniform(0.01, 40))
    out.push({
      _id: r.objectId(),
      sku: `FT-${String(i + 1).padStart(6, '0')}`,
      name,
      category: row.category,
      unit: noun === 'Резбов прът' ? 'м' : 'бр',
      purchasePrice,
      // At least a cent above cost: rounding would otherwise sell a 0.01 part at what it cost.
      sellingPrice: Math.max(round2(purchasePrice * (1.25 + r.float() * 0.75)), round2(purchasePrice + 0.01)),
      tags: tagsFor(name, row),
    })
  }
  return out
}

// ── contacts ───────────────────────────────────────────────────────────────────────────────────

const STEMS = ['Метал', 'Строй', 'Техно', 'Инвест', 'Агро', 'Транс', 'Бул', 'Евро', 'Пром', 'Електро', 'Инженеринг', 'Монтаж', 'Хидро', 'Дърво', 'Авто']
const ENDINGS = ['', 'кс', 'тех', 'консулт', 'трейд', 'сервиз', 'груп', 'про', 'плюс']
const FORMS = ['ООД', 'ЕООД', 'ЕООД', 'АД', 'ЕТ']
const CITIES = ['София', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора', 'Плевен', 'Сливен', 'Добрич', 'Шумен', 'Перник', 'Хасково']
const STREETS = ['ул. Индустриална', 'бул. България', 'ул. Шипка', 'ул. Опълченска', 'бул. Цар Освободител', 'ул. Васил Левски']

/**
 * A 9-digit ЕИК's check digit: Σ dᵢ·i (i = 1..8) mod 11; on 10, Σ dᵢ·(i+2) mod 11; on 10 again, 0.
 */
function eikCheckDigit(d: number[]): number {
  let check = d.reduce((s, x, i) => s + x * (i + 1), 0) % 11
  if (check === 10) {
    check = d.reduce((s, x, i) => s + x * (i + 3), 0) % 11
    if (check === 10) check = 0
  }
  return check
}

/** A 9-digit ЕИК whose check digit is deliberately WRONG, so it is no real company's. */
export function syntheticEik(r: Random): string {
  const digits = Array.from({ length: 8 }, () => r.int(0, 9))
  // valid + 1..9, mod 10, is never the valid digit.
  return digits.join('') + String((eikCheckDigit(digits) + 1 + r.int(0, 8)) % 10)
}

/** Whether a 9-digit ЕИК has a valid check digit. */
export function eikIsValid(eik: string): boolean {
  if (!/^\d{9}$/.test(eik)) return false
  const d = eik.split('').map(Number)
  return eikCheckDigit(d.slice(0, 8)) === d[8]
}

export interface FieldtestContact {
  _id: string
  type: 'customer' | 'supplier' | 'both'
  companyName: string
  taxId: string
  vatNumber: string
  email: string
  city: string
  street: string
}

export function contacts(seed: number, count: number): FieldtestContact[] {
  const r = stream(seed, 'contacts')
  const out: FieldtestContact[] = []
  for (let i = 0; i < count; i++) {
    const form = r.pick(FORMS)
    const base = `${r.pick(STEMS)}${r.pick(ENDINGS)}`
    const companyName = form === 'ЕТ' ? `ЕТ ${base} ${i + 1}` : `${base} ${i + 1} ${form}`
    const eik = syntheticEik(r)
    const roll = r.float()
    out.push({
      _id: r.objectId(),
      type: roll < 0.75 ? 'customer' : roll < 0.95 ? 'supplier' : 'both',
      companyName,
      taxId: eik,
      vatNumber: `BG${eik}`,
      email: `contact-${i + 1}@fieldtest.invalid`,
      city: r.pick(CITIES),
      street: `${r.pick(STREETS)} ${r.int(1, 200)}`,
    })
  }
  return out
}

// ── documents ──────────────────────────────────────────────────────────────────────────────────

export interface FieldtestLine { productIndex: number; quantity: number }
export interface FieldtestInvoice { contactIndex: number; lines: FieldtestLine[] }

/** One line per product, quantities summed: a document never lists a product twice. */
function merged(lines: FieldtestLine[]): FieldtestLine[] {
  const by = new Map<number, number>()
  for (const l of lines) by.set(l.productIndex, (by.get(l.productIndex) ?? 0) + l.quantity)
  return [...by.entries()].map(([productIndex, quantity]) => ({ productIndex, quantity }))
}

/**
 * The documents, in the order they are booked: every receipt, then every invoice.
 *
 * The receipts are derived FROM the invoices, so each product an invoice sells has come in first,
 * with margin: a sale never fails the stock check and never drives a level below zero. On top of
 * that each receipt brings in a few products nothing sells yet, as a real delivery does.
 */
export function documents(seed: number, preset: Preset): { receipts: FieldtestLine[][]; invoices: FieldtestInvoice[] } {
  const ri = stream(seed, 'invoices')
  const invoices: FieldtestInvoice[] = Array.from({ length: preset.invoices }, () => ({
    contactIndex: ri.int(0, preset.contacts - 1),
    lines: merged(Array.from({ length: ri.int(1, 8) }, () => ({ productIndex: ri.int(0, preset.products - 1), quantity: ri.int(1, 20) }))),
  }))

  const sold = new Map<number, number>()
  for (const inv of invoices) for (const l of inv.lines) sold.set(l.productIndex, (sold.get(l.productIndex) ?? 0) + l.quantity)

  const rr = stream(seed, 'receipts')
  const receipts: FieldtestLine[][] = Array.from({ length: Math.max(1, preset.receipts) }, () => [])
  let k = 0
  for (const [productIndex, quantity] of [...sold.entries()].sort((a, b) => a[0] - b[0])) {
    receipts[k++ % receipts.length].push({ productIndex, quantity: quantity + rr.int(10, 200) })
  }
  for (const lines of receipts) {
    for (let n = rr.int(1, 5); n > 0; n--) lines.push({ productIndex: rr.int(0, preset.products - 1), quantity: rr.int(50, 500) })
  }
  return { receipts: receipts.map(merged), invoices }
}
