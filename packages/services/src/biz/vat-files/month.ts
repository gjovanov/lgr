import { decodeCp1251 } from 'config/cp1251'
import {
  VatFileError, emitDeklar, emitRegister, emitVies, parseDeklar, parseRegister, parseVies,
  type VatRow, type VatViesDeclarant,
} from './codec.js'
import { DECLARED_CELLS } from './layouts.js'
import { buildVies, deklarCells, numberRows, viesRequired, withRowTotals, type DeclaredCells } from './rules.js'

/**
 * One month's filing: everything a person or a register supplies, and the one path from it to the
 * files. The gate (`scripts/compare-vat-files.ts`), the import, `generate` and the download all run
 * `generateMonthFiles`, so what the gate proves on the filed months is what the app produces.
 */

/** As the accountant's install writes them, and as the 42 filed months were accepted. */
export const VAT_FILE_NAMES = { deklar: 'DEKLAR.txt', prodagbi: 'PRODAGBI.txt', pokupki: 'POKUPKI.txt', vies: 'VIES.txt' } as const

export interface VatFile {
  name: string
  bytes: Uint8Array
}

export interface VatMonth {
  vatId: string
  name: string
  period: string
  filer: string
  /** What a person decides on the return. Everything else is computed. */
  declared: DeclaredCells
  sales: VatRow[]
  purchases: VatRow[]
  /** Needed only for a month with intra-EU supplies. */
  vies?: { declarant: VatViesDeclarant; companyAddress: string }
}

const fileNamed = (files: readonly VatFile[], name: string) => files.find(f => f.name.toUpperCase() === name.toUpperCase())

/**
 * A filed month as data. It keeps what cannot be derived, the rows and who filed, and reads no total:
 * regenerating has to arrive at those by itself, or the comparison would prove nothing.
 */
export function readFiledMonth(files: readonly VatFile[]): VatMonth {
  const required = (name: string) => {
    const file = fileNamed(files, name)
    if (!file) throw new VatFileError(`${name} is missing`)
    return file.bytes
  }
  const declaration = parseDeklar(required(VAT_FILE_NAMES.deklar))
  const vies = fileNamed(files, VAT_FILE_NAMES.vies)
  const parsedVies = vies ? parseVies(vies.bytes) : undefined
  const declared: DeclaredCells = {}
  for (const code of DECLARED_CELLS) {
    if (declaration.cells[code]) declared[code] = declaration.cells[code]
  }
  return {
    vatId: declaration.vatId,
    name: declaration.name,
    period: declaration.period,
    filer: declaration.filer,
    declared,
    sales: parseRegister('sales', required(VAT_FILE_NAMES.prodagbi)).rows,
    purchases: parseRegister('purchase', required(VAT_FILE_NAMES.pokupki)).rows,
    ...(parsedVies ? { vies: { declarant: parsedVies.declarant, companyAddress: parsedVies.company.address } } : {}),
  }
}

/** The month's files: `DEKLAR`, the two registers, and `VIES` when the month calls for one. */
export function generateMonthFiles(month: VatMonth): VatFile[] {
  const sales = numberRows(month.sales).map(row => ({ ...row, cells: withRowTotals(row.cells) }))
  const purchases = numberRows(month.purchases)
  const { vatId, name, period, filer } = month
  const files: VatFile[] = [
    { name: VAT_FILE_NAMES.deklar, bytes: emitDeklar({ vatId, name, period, filer, salesRows: sales.length, purchaseRows: purchases.length, cells: deklarCells(sales, purchases, month.declared) }) },
    { name: VAT_FILE_NAMES.prodagbi, bytes: emitRegister('sales', { vatId, period, rows: sales }) },
    { name: VAT_FILE_NAMES.pokupki, bytes: emitRegister('purchase', { vatId, period, rows: purchases }) },
  ]
  if (viesRequired(sales)) {
    if (!month.vies) throw new VatFileError('The month has intra-EU supplies and no VIES declarant')
    const company = { vatId, name, address: month.vies.companyAddress }
    files.push({ name: VAT_FILE_NAMES.vies, bytes: emitVies(buildVies(period, sales, month.vies.declarant, company)) })
  }
  return files
}

export interface VatFileComparison {
  name: string
  /** Records in the filed file. */
  records: number
  /** Records that differ. 0 means the bytes are equal. Never what differs: that is customer data. */
  differing: number
  /** The file exists on one side only. */
  only?: 'filed' | 'regenerated'
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])

const recordsOf = (bytes: Uint8Array): string[] => {
  const text = decodeCp1251(bytes)
  return text ? text.replace(/\r\n$/, '').split('\r\n') : []
}

/** Filed against regenerated, byte for byte, reporting counts only. */
export function compareFiles(filed: readonly VatFile[], regenerated: readonly VatFile[]): VatFileComparison[] {
  const names = [...new Set([...filed, ...regenerated].map(f => f.name.toUpperCase()))]
  return names.map(upper => {
    const a = fileNamed(filed, upper)
    const b = fileNamed(regenerated, upper)
    if (!a || !b) {
      const present = (a ?? b)!
      return { name: present.name, records: a ? recordsOf(a.bytes).length : 0, differing: recordsOf(present.bytes).length, only: a ? 'filed' as const : 'regenerated' as const }
    }
    const records = recordsOf(a.bytes)
    if (sameBytes(a.bytes, b.bytes)) return { name: a.name, records: records.length, differing: 0 }
    const others = recordsOf(b.bytes)
    const longest = Math.max(records.length, others.length)
    let differing = 0
    for (let i = 0; i < longest; i++) if (records[i] !== others[i]) differing++
    // A file that differs in its bytes and in no record differs in how its last record ends.
    return { name: a.name, records: records.length, differing: Math.max(differing, 1) }
  })
}

/** Stands in for a declarant the filed month does not have, so that the comparison can say so. */
const NO_DECLARANT = { declarant: { id: '', name: '', city: '', postcode: '', address: '', kind: '' }, companyAddress: '' }

/** The release's gate for one month: read what was filed, regenerate it, compare. */
export function compareFiledMonth(filed: readonly VatFile[]): VatFileComparison[] {
  const month = readFiledMonth(filed)
  return compareFiles(filed, generateMonthFiles({ ...month, vies: month.vies ?? NO_DECLARANT }))
}
