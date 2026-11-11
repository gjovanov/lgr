import { CATALOGUE, type CapabilityId, type FeatureId } from './catalogue'
import type { Grant } from './grant'
import { PRICE_LEVEL_CAPS } from './fields'

/**
 * FR-27 §2.1, §2.2 (#529) — what the role editor shows: per feature a level, None, View, Work or Full, and the
 * extras outside the levels, ticked one by one. A level is never stored: a role is its capabilities, and the editor
 * shows the largest level they contain, and any capability beyond it as a ticked extra.
 *
 *   View: opens and reads (`view`, and what a page-less read is: `browse`, `lookup`, `read`, `check`).
 *   Work: View, plus creating and editing and the feature's daily verbs.
 *   Full: Work, plus deleting and managing.
 *   Extras: what a role may hold or not on top of its level (the totals strip, Export, a storno, cost figures…).
 *
 * Import-pure.
 */
export type Level = 'none' | 'view' | 'work' | 'full'
export const LEVELS: readonly Level[] = ['none', 'view', 'work', 'full']

type Feature = (typeof CATALOGUE)[number]

const VIEW_ACTIONS = ['view', 'browse', 'lookup', 'read', 'check']
/** Extras that only read more: a role holding them with View still only reads (the summary's lines). */
const READING_EXTRAS = ['export', 'totals', 'costs']
/** FR-27.11: a price level reads a figure; it is never work. */
const reads = (action: string) => READING_EXTRAS.includes(action) || action.startsWith('price:')
const FULL_ONLY = ['delete', 'manage', 'run']

const EXTRAS: Partial<Record<FeatureId, readonly string[]>> = {
  'sales-docs': ['totals', 'import', 'export'],
  bills: ['totals'],
  // FR-27.11: "Prices it may see": the cost figures and one tick per price level.
  products: ['export', 'costs', 'price:selling', 'price:wholesale', 'price:0', 'price:1', 'price:2', 'price:3', 'price:4', 'price:5', 'price:6', 'price:7', 'price:8', 'price:9', 'price:10', 'price:other'],
  movements: ['create:transfer'],
  'cash-sales': ['storno', 'settle'],
  till: ['manage-sessions'],
  devices: ['z-report', 'sync-time', 'name-payments'],
  journal: ['post'],
  vat: ['file'],
  'payroll-runs': ['approve'],
  'payroll-people': ['reveal'],
  reports: ['export'],
  supto: ['export'],
  files: ['archives'],
  org: ['switch'],
}

/** The features the editor lists: every one but the helpers, which roles get through `withImplied`. */
export const EDITOR_FEATURES: readonly Feature[] = CATALOGUE.filter(f => f.group !== 'helpers')

const cap = (f: Feature, action: string) => `${f.id}.${action}` as CapabilityId

export interface FeatureLevels {
  view: CapabilityId[]
  work: CapabilityId[]
  full: CapabilityId[]
  extras: CapabilityId[]
}

export function levelsOf(feature: Feature): FeatureLevels {
  const actions = feature.actions as readonly string[]
  const extras = actions.filter(a => (EXTRAS[feature.id] ?? []).includes(a))
  const full = actions.filter(a => !extras.includes(a))
  const view = full.filter(a => VIEW_ACTIONS.includes(a))
  const work = full.filter(a => !FULL_ONLY.includes(a))
  return { view: view.map(a => cap(feature, a)), work: work.map(a => cap(feature, a)), full: full.map(a => cap(feature, a)), extras: extras.map(a => cap(feature, a)) }
}

/**
 * Whether the editor offers this level for the feature: a level that grants nothing beyond the one below it is not a
 * choice of its own (cash sales: Work is already everything; the ledgers: View is). None always is.
 */
export function offersLevel(feature: Feature, level: Level): boolean {
  if (level === 'none') return true
  const l = levelsOf(feature)
  if (level === 'view') return l.view.length > 0
  if (level === 'work') return l.work.length > l.view.length
  return l.full.length > l.work.length || (l.full.length > 0 && l.work.length === l.view.length && l.full.length > l.view.length)
}

const DOWN: readonly Level[] = ['full', 'work', 'view']

/**
 * The largest level the editor offers whose every capability the grant holds (an empty level never counts): the
 * radio the editor ticks, and one a person can tick to get the same. An Administrator: the largest offered.
 */
export function levelOf(feature: Feature, grant: Grant): Level {
  if (grant.all) return DOWN.find(level => offersLevel(feature, level)) ?? 'none'
  const l = levelsOf(feature)
  const holds = (caps: CapabilityId[]) => caps.length > 0 && caps.every(c => grant.caps.has(c))
  return DOWN.find(level => offersLevel(feature, level) && holds(l[level])) ?? 'none'
}

/** The capabilities of a feature a role holds beyond its level: shown as ticked extras. */
export function beyondLevel(feature: Feature, grant: Grant): CapabilityId[] {
  if (grant.all) return []
  const l = levelsOf(feature)
  const level = levelOf(feature, grant)
  const within = new Set(level === 'none' ? [] : l[level])
  return [...l.full, ...l.extras].filter(c => grant.caps.has(c) && !within.has(c))
}

/**
 * The helpers a feature's form reads, granted with it (FR-27 §2.5 `implies`): what the legacy permissions gave as
 * a matter of course. A role made in the editor gets them, so its pages work.
 */
/** FR-27.11.A: what writes prices sees them all: a role cannot write a figure it cannot see. */
const EVERY_PRICE: readonly CapabilityId[] = [
  'products.costs', 'products.price:selling', 'products.price:wholesale', 'products.price:0', 'products.price:1', 'products.price:2',
  'products.price:3', 'products.price:4', 'products.price:5', 'products.price:6', 'products.price:7', 'products.price:8',
  'products.price:9', 'products.price:10', 'products.price:other',
]

const IMPLIES: Partial<Record<CapabilityId, readonly CapabilityId[]>> = {
  'sales-docs.view': ['pricing.read', 'doc-import.read', 'stock-availability.check'],
  'proforma.view': ['pricing.read'],
  'bills.view': ['pricing.read', 'doc-import.read', 'products.costs'],
  'orders.view': ['pricing.read'],
  'contacts.view': ['pricing.read'],
  // FR-27.11.A: what sells sees the selling price.
  'sales-docs.create': ['stock-availability.transfer', 'doc-import.extract', 'tags.edit', 'products.price:selling'],
  'proforma.create': ['products.price:selling'],
  'till.sell': ['products.price:selling'],
  'bills.create': ['doc-import.extract', 'tags.edit'],
  'contacts.create': ['tags.edit'],
  'contacts.edit': ['tags.edit'],
  'products.view': ['pricing.read', 'doc-import.read', 'stock-availability.check', 'stock-levels.lookup'],
  'products.edit': ['tags.edit', 'doc-import.extract'],
  'warehouses.edit': ['tags.edit'],
  // FR-27.11.A: what writes prices sees every one (receipts and adjustments price their lines; the price writers set them).
  'movements.create': ['doc-import.extract', ...EVERY_PRICE],
  'price-lists.create': EVERY_PRICE,
  'price-lists.edit': EVERY_PRICE,
  'bulk-pricing.create': EVERY_PRICE,
  'bulk-pricing.edit': EVERY_PRICE,
  'opening-stock.create': EVERY_PRICE,
  'movements.create:transfer': ['products.lookup', 'warehouses.lookup', 'categories.lookup', 'stock-levels.lookup', 'pricing.read'],
  'till.view': ['pricing.read', 'contacts.lookup'],
}

export function withImplied(caps: Iterable<CapabilityId>): CapabilityId[] {
  const out = new Set(caps)
  for (const c of [...out]) for (const implied of IMPLIES[c] ?? []) out.add(implied)
  return [...out].sort()
}

/**
 * FR-27.4 §2.3 — the three lines under a role: what it can create, what it only reads, what it does not see. Feature
 * ids, in catalogue order; the screens name them.
 */
export function summarize(grant: Grant): { canCreate: FeatureId[]; readOnly: FeatureId[]; notVisible: FeatureId[]; hiddenPrices: CapabilityId[] } {
  const canCreate: FeatureId[] = []
  const readOnly: FeatureId[] = []
  const notVisible: FeatureId[] = []
  for (const f of EDITOR_FEATURES) {
    const l = levelsOf(f)
    const sees = grant.all || l.view.some(c => grant.caps.has(c))
    const works = grant.all || [...l.work, ...l.extras].some(c => !l.view.includes(c) && !reads(c.slice(c.indexOf('.') + 1)) && grant.caps.has(c))
    if (works) canCreate.push(f.id)
    else if (sees) readOnly.push(f.id)
    else notVisible.push(f.id)
  }
  return { canCreate, readOnly, notVisible, hiddenPrices: hiddenPricesOf(grant) }
}

/**
 * FR-27.11.B: what the summary says a role does not see of the prices: the cost figures and each price level it lacks,
 * for a role that reads products at all (one that reads none sees no price anyway). Catalogue order.
 */
export function hiddenPricesOf(grant: Grant): CapabilityId[] {
  if (grant.all) return []
  const readsProducts = (['products.view', 'products.lookup', 'sales-docs.view', 'till.view'] as CapabilityId[]).some(c => grant.caps.has(c))
  if (!readsProducts) return []
  return (['products.costs', ...PRICE_LEVEL_CAPS] as CapabilityId[]).filter(c => !grant.caps.has(c))
}
