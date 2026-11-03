import type { VatCells, VatRow, VatVies, VatViesDeclarant, VatViesRow } from './codec.js'
import { DECLARED_CELLS } from './layouts.js'

/**
 * The arithmetic of a VAT return (FR-25 §1.5, §7.1), from ППЗДДС Приложение № 12. The work of a return
 * is in its registers: on all 42 filed months every `DEKLAR` field follows from them, and
 * `scripts/compare-vat-files.ts` proves it again, byte for byte.
 */

export type DeclaredCell = (typeof DECLARED_CELLS)[number]
export type DeclaredCells = Partial<Record<DeclaredCell, number>>

/** Document types that enter a register and stay out of the return's totals. */
export const SALES_EXCLUDED: ReadonlySet<string> = new Set(['11', '12', '13', '04'])
export const PURCHASE_EXCLUDED: ReadonlySet<string> = new Set(['11', '12', '13', '94', '05'])

/** ⚠ 02-17, 02-18, 02-19 and 02-25 are outside 02-10, and 02-19 is outside 01-01 too. */
const ROW_BASE_PARTS = ['02-11', '02-12', '02-13', '02-14', '02-15', '02-16', '02-26']
const ROW_VAT_PARTS = ['02-21', '02-22', '02-23', '02-24']

/** Each cell of `DEKLAR`, and the register columns it sums. */
const FROM_SALES: Readonly<Record<string, readonly string[]>> = {
  '01-01': ['02-10'], '01-20': ['02-20'], '01-11': ['02-11'], '01-21': ['02-21'],
  '01-12': ['02-12', '02-26'], '01-22': ['02-22'], '01-23': ['02-23'], '01-13': ['02-13'], '01-24': ['02-24'],
  '01-14': ['02-14'], '01-15': ['02-15'], '01-16': ['02-16'], '01-17': ['02-17'], '01-18': ['02-18', '02-25'], '01-19': ['02-19'],
}
const FROM_PURCHASES: Readonly<Record<string, readonly string[]>> = {
  '01-30': ['03-30', '03-44'], '01-31': ['03-31'], '01-41': ['03-41'], '01-32': ['03-32'], '01-42': ['03-42'],
}

const sumCells = (cells: VatCells, codes: readonly string[]): number => codes.reduce((sum, code) => sum + (cells[code] ?? 0), 0)
const sumRows = (rows: readonly VatRow[], codes: readonly string[]): number => rows.reduce((sum, row) => sum + sumCells(row.cells, codes), 0)

const countedSales = (sales: readonly VatRow[]) => sales.filter(r => !SALES_EXCLUDED.has(r.docTypeCode))
const countedPurchases = (purchases: readonly VatRow[]) => purchases.filter(r => !PURCHASE_EXCLUDED.has(r.docTypeCode))

/** Half away from zero: a value and its reversal round to the same size. */
function roundCents(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

/** A sales row's 02-10 and 02-20, from its parts. A blank row stays blank. */
export function withRowTotals(cells: VatCells): VatCells {
  const { '02-10': _base, '02-20': _vat, ...parts } = cells
  const base = sumCells(parts, ROW_BASE_PARTS)
  const vat = sumCells(parts, ROW_VAT_PARTS)
  return { ...parts, ...(base ? { '02-10': base } : {}), ...(vat ? { '02-20': vat } : {}) }
}

/**
 * Rows by date, numbered 1..n with no gaps. The annex asks for the numbers; the date order is the
 * vendor's, in all 42 filed months. Within a day a row keeps the place it had.
 */
export function numberRows<T extends VatRow>(rows: readonly T[]): T[] {
  return [...rows]
    .sort((a, b) => a.docDate.getTime() - b.docDate.getTime() || a.rowNo - b.rowNo)
    .map((row, i) => ({ ...row, rowNo: i + 1 }))
}

/**
 * A cancelled document's row (Приложение № 12): blank in its own period, and the original values
 * with the opposite sign in a later one.
 */
export function annulledCells(original: VatCells, originalPeriod: string, period: string): VatCells {
  if (period === originalPeriod) return {}
  return Object.fromEntries(Object.entries(original).map(([code, cents]) => [code, -cents]))
}

/**
 * `DEKLAR`'s cells from the registers, and from the few cells a person decides.
 *
 * 01-43 lists no document types to leave out, unlike every other total. 01-71 defaults to what 01-50
 * leaves after 01-70: tax payable is either set off or paid, and in all 42 filed months it was paid.
 *
 * ⚠ 01-60 is written as a positive amount, like 01-80 to 01-82 it divides. No filed month has a
 * refund, so that one sign is the annex's reading and unproven by the gate.
 */
export function deklarCells(sales: readonly VatRow[], purchases: readonly VatRow[], declared: DeclaredCells = {}): VatCells {
  const cells: VatCells = {}
  const put = (code: string, cents: number) => { if (cents) cells[code] = cents }

  const inSales = countedSales(sales)
  const inPurchases = countedPurchases(purchases)
  for (const [code, columns] of Object.entries(FROM_SALES)) put(code, sumRows(inSales, columns))
  for (const [code, columns] of Object.entries(FROM_PURCHASES)) put(code, sumRows(inPurchases, columns))
  put('01-43', sumRows(purchases, ['03-43']))
  for (const code of DECLARED_CELLS) put(code, declared[code] ?? 0)

  // 01-33 is held in hundredths, so 42 × 33 is in hundredths of a cent.
  const credit = (cells['01-41'] ?? 0) + roundCents(((cells['01-42'] ?? 0) * (cells['01-33'] ?? 0)) / 100) + (cells['01-43'] ?? 0)
  const output = cells['01-20'] ?? 0
  put('01-40', credit)
  put('01-50', Math.max(output - credit, 0))
  put('01-60', Math.max(credit - output, 0))
  put('01-71', Math.max((cells['01-50'] ?? 0) - (cells['01-70'] ?? 0), 0))
  return cells
}

/** The three VIES columns and the sales cell each comes from. A ВОП alone never calls for a VIES. */
const VIES_COLUMNS = { goods: '02-15', triangular: '02-25', services: '02-17' } as const

/** Does the month need a VIES declaration? On disk: the 9 months with a non-zero 02-15, and no others. */
export function viesRequired(sales: readonly VatRow[]): boolean {
  return countedSales(sales).some(r => Object.values(VIES_COLUMNS).some(code => r.cells[code]))
}

/** One row per recipient, in the order the register first names them. */
export function viesRows(sales: readonly VatRow[]): VatViesRow[] {
  const byPartner = new Map<string, VatViesRow>()
  for (const row of countedSales(sales)) {
    if (!Object.values(VIES_COLUMNS).some(code => row.cells[code])) continue
    const entry = byPartner.get(row.partnerVat) ?? { rowNo: byPartner.size + 1, partnerVat: row.partnerVat, goods: 0, triangular: 0, services: 0 }
    entry.goods += row.cells[VIES_COLUMNS.goods] ?? 0
    entry.triangular += row.cells[VIES_COLUMNS.triangular] ?? 0
    entry.services += row.cells[VIES_COLUMNS.services] ?? 0
    byPartner.set(row.partnerVat, entry)
  }
  return [...byPartner.values()]
}

export function buildVies(
  period: string,
  sales: readonly VatRow[],
  declarant: VatViesDeclarant,
  company: VatVies['company'],
): VatVies {
  const rows = viesRows(sales)
  const goods = rows.reduce((sum, r) => sum + r.goods, 0)
  const total = rows.reduce((sum, r) => sum + r.goods + r.triangular + r.services, 0)
  return { period, declarant, company, total, goods, rows }
}

export function isVatPeriod(period: string): boolean {
  return /^\d{4}(0[1-9]|1[0-2])$/.test(period)
}

/** A month's first and last day, at UTC midnight. */
export function periodBounds(period: string): { from: Date; to: Date } {
  const year = Number(period.slice(0, 4)), month = Number(period.slice(4, 6))
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 0)) }
}

/** The filed files carry leva up to 2025 and euro from 2026, in the same layout. */
export function vatCurrency(period: string): 'BGN' | 'EUR' {
  return period < '202601' ? 'BGN' : 'EUR'
}
