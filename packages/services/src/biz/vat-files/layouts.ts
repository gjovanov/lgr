/**
 * The NRA's file layouts, as data (FR-25 §7.1, §7.2): ППЗДДС Приложение № 12 for DEKLAR, PRODAGBI and
 * POKUPKI, Приложение № 15 for VIES. Every field carries the annex's own code, in file order.
 *
 * Import-pure, like everything in this folder except `vat-return.service.ts`: a unit test boots nothing.
 */

export type FieldKind =
  /** Left-aligned, padded with spaces. */
  | 'text'
  /** Right-aligned digits. Unset is blank; a zero prints, because a row count is a required field. */
  | 'count'
  /** Right-aligned `12.34` or `-12.34`, held as integer cents. A zero is blank, or printed where `zero` says. */
  | 'money'

export interface FieldDef {
  code: string
  width: number
  kind: FieldKind
  /** VIES prints a zero as `0.00`. In the registers and DEKLAR a zero is blank, in all 42 filed months. */
  zero?: 'printed'
}

export type Layout = readonly FieldDef[]

const text = (code: string, width: number): FieldDef => ({ code, width, kind: 'text' })
const count = (code: string, width: number): FieldDef => ({ code, width, kind: 'count' })
const money = (code: string, width = 15): FieldDef => ({ code, width, kind: 'money' })
const printedMoney = (code: string): FieldDef => ({ code, width: 12, kind: 'money', zero: 'printed' })

export const DEKLAR_LAYOUT: Layout = [
  text('00-01', 15), // VAT id
  text('00-02', 50), // name
  text('00-03', 6), // period, YYYYMM
  text('00-04', 50), // who files
  count('00-05', 15), // sales rows
  count('00-06', 15), // purchase rows
  ...['01-01', '01-20', '01-11', '01-21', '01-12', '01-22', '01-23', '01-13', '01-24', '01-14', '01-15', '01-16', '01-17', '01-18', '01-19',
    '01-30', '01-31', '01-41', '01-32', '01-42', '01-43'].map(c => money(c)),
  money('01-33', 4), // чл. 73(5) coefficient, `0.00` to `1.00`: hundredths, so it reads like cents
  ...['01-40', '01-50', '01-60', '01-70', '01-71', '01-80', '01-81', '01-82'].map(c => money(c)),
]

/** The ten leading fields of a register's record, by what they hold. */
export interface RegisterCodes {
  vatId: string
  period: string
  branch: string
  rowNo: string
  docTypeCode: string
  docNumber: string
  docDate: string
  partnerVat: string
  partnerName: string
  description: string
  /** The trailing two-character code (чл. 163а, чл. 167а, call-off stock). */
  code: string
}

export type VatSide = 'sales' | 'purchase'

export const REGISTER_CODES: Record<VatSide, RegisterCodes> = {
  sales: {
    vatId: '02-00', period: '02-01', branch: '02-02', rowNo: '02-03', docTypeCode: '02-04', docNumber: '02-05',
    docDate: '02-06', partnerVat: '02-07', partnerName: '02-08', description: '02-09', code: '02-27',
  },
  // ⚠ Not a slip: in POKUPKI the annex numbers the VAT id 03-02 and the period 03-01.
  purchase: {
    vatId: '03-02', period: '03-01', branch: '03-03', rowNo: '03-04', docTypeCode: '03-05', docNumber: '03-06',
    docDate: '03-07', partnerVat: '03-08', partnerName: '03-09', description: '03-10', code: '03-45',
  },
}

function registerLead(c: RegisterCodes): FieldDef[] {
  return [
    text(c.vatId, 15), text(c.period, 6), count(c.branch, 4), count(c.rowNo, 15), text(c.docTypeCode, 2), text(c.docNumber, 20),
    text(c.docDate, 10), text(c.partnerVat, 15), text(c.partnerName, 50), text(c.description, 30),
  ]
}

/** The value cells of a register's record, in file order. The annex's order, not numeric. */
export const SALES_CELLS = ['02-10', '02-20', '02-11', '02-21', '02-12', '02-26', '02-22', '02-23', '02-13', '02-24', '02-14', '02-15', '02-16', '02-17', '02-18', '02-19', '02-25'] as const
export const PURCHASE_CELLS = ['03-30', '03-31', '03-41', '03-32', '03-42', '03-43', '03-44'] as const

export const REGISTER_LAYOUT: Record<VatSide, Layout> = {
  sales: [...registerLead(REGISTER_CODES.sales), ...SALES_CELLS.map(c => money(c)), text(REGISTER_CODES.sales.code, 2)],
  purchase: [...registerLead(REGISTER_CODES.purchase), ...PURCHASE_CELLS.map(c => money(c)), text(REGISTER_CODES.purchase.code, 2)],
}

/** The cells of DEKLAR a person decides. Everything else on the return is arithmetic (§1.5). */
export const DECLARED_CELLS = ['01-33', '01-70', '01-80', '01-81', '01-82'] as const

/**
 * VIES records, by the three letters each starts with. The annex numbers a record's fields 1..n, so
 * a field's code here is `<record>-<n>`. In a TXT file the first field is the record's own code.
 */
export const VIES_LAYOUT = {
  VHR: [text('VHR-1', 3), text('VHR-2', 7), count('VHR-3', 5)],
  VDR: [text('VDR-1', 3), text('VDR-2', 15), text('VDR-3', 150), text('VDR-4', 50), text('VDR-5', 4), text('VDR-6', 150), text('VDR-7', 1)],
  VTR: [text('VTR-1', 3), text('VTR-2', 15), text('VTR-3', 150), text('VTR-4', 200)],
  TTR: [text('TTR-1', 3), printedMoney('TTR-2'), printedMoney('TTR-3')],
  VIR: [text('VIR-1', 3), count('VIR-2', 5), text('VIR-3', 15), printedMoney('VIR-4'), printedMoney('VIR-5'), printedMoney('VIR-6'), text('VIR-7', 7)],
  CHR: [text('CHR-1', 3), count('CHR-2', 5)],
  COS: [text('COS-1', 3), count('COS-2', 5), text('COS-3', 15), count('COS-4', 1), text('COS-5', 15), text('COS-6', 7)],
} as const satisfies Record<string, Layout>

export type ViesRecord = keyof typeof VIES_LAYOUT

export const layoutWidth = (layout: Layout): number => layout.reduce((sum, f) => sum + f.width, 0)
