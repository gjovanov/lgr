/**
 * FR-25 R3 (2026-11-25): the rules of the group costs page (`GroupCostsView.vue`), where the accountant overrides a goods
 * group's average cost from a day on. The shadow's cost of sales is each group's daily average replayed from the books;
 * an override restates it at the start of its day, for a write-off or a loss the average does not show. Import-pure:
 * `unit/group-costs-page.test.ts`.
 */

/** An override as the API answers it. */
export interface CostOverride {
  id: string
  analyticId: string
  /** The group's path now; none when its analytic is gone. */
  path?: string
  name?: string
  /** A group switched off posts no sale at all, override or not. */
  active: boolean
  /** `YYYY-MM-DD` */
  from: string
  /** EUR a unit. */
  unitCost: number
  reason: string
  createdBy?: { id: string; name: string }
  updatedBy?: { id: string; name: string }
  createdAt: string
  updatedAt: string
}

/** A group at the start of a day, every other override applied: what the dialog shows beside the unit it asks for. */
export interface GroupAverage {
  analyticId: string
  path: string
  day: string
  quantity?: number
  unitCost?: number
  override?: CostOverride
}

/**
 * Where the org stands: it keeps no books, it is a store of a split (the home keeps the company's overrides), or it is
 * the home of its books.
 */
export type BooksPlace = 'none' | 'store' | 'home'

export function booksPlaceOf(org: { id?: string; settings?: any } | null | undefined): BooksPlace {
  const books = org?.settings?.accounting?.books
  if (books?.mode !== 'books') return 'none'
  const home = books.split?.homeOrgId
  return home && org?.id && String(home) !== String(org.id) ? 'store' : 'home'
}

/** The first day an override may name: the books are in leva before it. */
export const FIRST_DAY = '2026-01-01'
/** The decimals a unit keeps: a piece of a fastener costs fractions of a cent. */
export const UNIT_DECIMALS = 6
export const REASON_MAX = 500

export interface OverrideForm {
  analyticId: string | null
  from: string | null
  unitCost: number | null
  reason: string
}

/** What keeps Save off: the message keys of what the form lacks, none when it can be sent. */
export function formProblems(f: OverrideForm): string[] {
  const out: string[] = []
  if (!f.analyticId) out.push('accounting.groupCosts.needGroup')
  if (!f.from || !/^\d{4}-\d{2}-\d{2}$/.test(f.from)) out.push('accounting.groupCosts.needDay')
  else if (f.from < FIRST_DAY) out.push('accounting.groupCosts.badDay')
  if (f.unitCost === null || !Number.isFinite(f.unitCost) || f.unitCost < 0) out.push('accounting.groupCosts.needUnitCost')
  const reason = f.reason.trim()
  if (!reason || reason.length > REASON_MAX) out.push('accounting.groupCosts.needReason')
  return out
}

/** The body of a new override, or of a change (its group and day are never changed). */
export function createBody(f: OverrideForm): { analyticId: string; from: string; unitCost: number; reason: string } {
  return { analyticId: f.analyticId!, from: f.from!, unitCost: f.unitCost!, reason: f.reason.trim() }
}

export function updateBody(f: OverrideForm, expected: string): { unitCost: number; reason: string; expected: string } {
  return { unitCost: f.unitCost!, reason: f.reason.trim(), expected }
}

/** A refusal the page says in its own words; any other is the server's message. */
export function writeErrorKey(code: string | undefined): string | null {
  switch (code) {
    case 'row_changed': return 'accounting.groupCosts.rowChanged'
    case 'override_exists': return 'accounting.groupCosts.exists'
    case 'not_a_goods_group': return 'accounting.groupCosts.notAGoodsGroup'
    case 'bad_day': return 'accounting.groupCosts.badDay'
    case 'not_books_home': return 'accounting.groupCosts.notHome'
    case 'not_a_books_org': return 'accounting.groupCosts.notBooks'
    default: return null
  }
}

/** Who changed the override last, and when. */
export function lastChangeOf(o: Pick<CostOverride, 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'>): { name: string; at: string } {
  const who = o.updatedBy ?? o.createdBy
  return { name: who?.name ?? '', at: o.updatedBy ? o.updatedAt : o.createdAt }
}

/**
 * The override against the replayed average, as a share of it: −0.2 for a fifth less. None without an average, or
 * with an average of nothing.
 */
export function changeOf(unitCost: number | null | undefined, average: number | null | undefined): number | null {
  if (unitCost === null || unitCost === undefined || average === null || average === undefined || !(average > 0)) return null
  return unitCost / average - 1
}

/** The overrides, the latest day first and, on one day, by the group's path. */
export function sortOverrides(list: readonly CostOverride[]): CostOverride[] {
  return [...list].sort((a, b) => b.from.localeCompare(a.from) || String(a.path ?? '').localeCompare(String(b.path ?? ''), 'bg'))
}
