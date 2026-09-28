/**
 * Parsers for the two PlusMinus spreadsheet exports the import surfaces accept.
 *
 * These layouts are FIXED, and the guards below matter more than the parsing: the same
 * filename can carry a different report depending on which operation filter was used in
 * PlusMinus, and a tree-grouped export can double-count its own sub-totals. Every parser
 * therefore validates the header row and cross-checks the item sum against the printed
 * total, and throws rather than importing something plausible-but-wrong.
 *
 * Ported from `scripts/import-cash-register-sales.ts` and `scripts/receive-stock.ts`, whose
 * abort conditions were learned the hard way during the regal-pz migration.
 */
import ExcelJS from 'exceljs'

export class XlsxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxParseError'
  }
}

/** Excel cells can hold a formula object; take the computed result when they do. */
function cellNum(v: any): number {
  if (v == null) return 0
  if (typeof v === 'object' && 'result' in v) return Number((v as any).result) || 0
  return Number(v) || 0
}

const round2 = (v: number) => +v.toFixed(2)
const round4 = (v: number) => +v.toFixed(4)

async function loadSheet(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const sheet = wb.getWorksheet(1)
  if (!sheet) throw new XlsxParseError('workbook has no sheets')
  return sheet
}

// ── salesAnalysis (cash register) ────────────────────────────────────────────

/** Rows that are group sub-totals, not items. Including them would double-count. */
const SALES_GROUP_ROWS = new Set(['СТОКИ', 'УСЛУГИ', 'МАТЕРИАЛИ', 'ПАРТНЬОРИ', 'ПРОДУКЦИЯ', 'Общо'])
const SALES_HEADER_ROW = 9 // "Артикул | Количество | Стойност | % Ст-ст | % Кол-во"

export interface SalesAnalysisRow {
  name: string
  qty: number
  /** NET value in EUR — the products' net selling prices; 20% VAT is added on top. */
  value: number
}

export interface SalesAnalysisResult {
  rows: SalesAnalysisRow[]
  totalQty: number
  totalValue: number
  /** The BUSINESS day, read from the „Период" inside the sheet. The filename only records when the
   *  export was TAKEN, which is routinely a later day — and the day is this document's identity. */
  periodStart?: string
}

export async function parseSalesAnalysis(buffer: Buffer): Promise<SalesAnalysisResult> {
  const sheet = await loadSheet(buffer)
  const header = String(sheet.getRow(SALES_HEADER_ROW).getCell(1).text ?? '').trim()
  if (header !== 'Артикул') {
    throw new XlsxParseError(
      `Unexpected header at row ${SALES_HEADER_ROW}: "${header}" (expected "Артикул") — this is not a salesAnalysis export`,
    )
  }

  // The title block above the table carries „Период: DD.MM.YYYY - …": the day the register covers.
  let period = ''
  for (let r = 1; r < SALES_HEADER_ROW && !period; r++) {
    for (let c = 1; c <= 6 && !period; c++) {
      const m = /(?:Период|ПЕРИОД)\s*:?\s*(.+)/.exec(String(sheet.getRow(r).getCell(c).text ?? ''))
      if (m) period = m[1]
    }
  }

  const rows: SalesAnalysisRow[] = []
  /** Rows whose quantity CELL was empty — not zero. See the residual rule below. */
  const blankQty: SalesAnalysisRow[] = []
  let totalQty = 0
  let totalValue = 0
  sheet.eachRow((row, rn) => {
    if (rn <= SALES_HEADER_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name) return
    const raw = row.getCell(2).value
    const qty = cellNum(raw)
    const value = cellNum(row.getCell(3).value)
    if (name === 'Общо') { totalQty = qty; totalValue = value; return }
    if (SALES_GROUP_ROWS.has(name)) return
    const item = { name, qty, value }
    rows.push(item)
    if (raw == null) blankQty.push(item)
  })

  const sum = (pick: (r: SalesAnalysisRow) => number) => rows.reduce((s, r) => s + pick(r), 0)
  const sumV = sum(r => r.value)

  /**
   * A RETURN can arrive with its quantity cell left EMPTY rather than negative.
   *
   * 2026-09-28's register prints „СВРЕДЛО - Ф16.5" with a value of -11.25 and a „% Кол-во" of
   * -0.07 — one unit's share of the day, negative — but no number in the quantity column. Read as
   * zero, the items then sum to 1450 against an „Общо" of 1449 and the whole day's till sales are
   * refused over a single missing minus sign.
   *
   * So a blank quantity is UNKNOWN, not zero, and the document itself supplies it: the residual
   * that makes the items reproduce the printed „Общо". That is a derivation, not a guess, and it
   * is only allowed to run when it cannot be ambiguous —
   *   · exactly ONE row may have a blank quantity (with two, the split between them is unknowable);
   *   · the value column must already reconcile, so the residual is the only thing in doubt;
   *   · the residual must agree in sign with that row's own value — a negative value is a return,
   *     and a positive residual would mean the arithmetic works for the wrong reason.
   * Anything else still fails the cross-check below, exactly as before.
   */
  if (blankQty.length === 1 && Math.abs(sumV - totalValue) <= 0.05) {
    const [item] = blankQty
    const residual = round2(totalQty - sum(r => r.qty))
    if (residual !== 0 && Math.sign(residual) === Math.sign(item.value)) item.qty = residual
  }

  // Guard against layout drift / tree sub-groups double-counting: the item sum must
  // reproduce the "Общо" row.
  const sumQ = sum(r => r.qty)
  if (Math.abs(sumV - totalValue) > 0.05 || Math.abs(sumQ - totalQty) > 0.05) {
    throw new XlsxParseError(
      `Cross-check failed: items sum ${round2(sumV)}/${round2(sumQ)} vs Общо ${totalValue}/${totalQty} — unrecognised group rows`,
    )
  }
  return { rows, totalQty, totalValue, periodStart: bgDate(period) }
}

// ── storeOperations (goods receipts) ─────────────────────────────────────────

const OPS_HEADER_ROW = 9 // "Име | Мярка | Количество | Цена | Стойност"

export interface StoreOperationsRow {
  name: string
  unit: string
  qty: number
  price: number
  value: number
}

export interface StoreOperationsResult {
  rows: StoreOperationsRow[]
  totalQty: number
  /** The `Склад:` header value, verbatim (may be "ОБЕКТИ:СКЛАД - 1" or "Всички складове"). */
  warehouse: string
  /** The `Операция:` header value — must be "Доставки" for a receipt import. */
  operation: string
  /** Start of the `Период:` range, as YYYY-MM-DD. */
  periodStart?: string
}

function bgDate(raw: string): string | undefined {
  const m = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(raw || '')
  if (!m) return undefined
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

/** Value after the first colon on a labelled header row. */
function headerValue(sheet: any, rowNumber: number): string {
  const text = String(sheet.getRow(rowNumber).getCell(1).text ?? '').trim()
  const idx = text.indexOf(':')
  return idx >= 0 ? text.slice(idx + 1).trim() : ''
}

export async function parseStoreOperations(buffer: Buffer): Promise<StoreOperationsResult> {
  const sheet = await loadSheet(buffer)

  const warehouse = headerValue(sheet, 2)
  const period = headerValue(sheet, 3)
  const operation = headerValue(sheet, 4)

  // The same filename carries different reports depending on the PlusMinus operation
  // filter — importing a "Продажби" export as receipts would invent stock.
  if (operation !== 'Доставки') {
    throw new XlsxParseError(
      `This export is "Операция: ${operation || '?'}" — only "Доставки" (goods receipts) can be imported here`,
    )
  }

  const h1 = String(sheet.getRow(OPS_HEADER_ROW).getCell(1).text ?? '').trim()
  const h3 = String(sheet.getRow(OPS_HEADER_ROW).getCell(3).text ?? '').trim()
  if (h1 !== 'Име' || h3 !== 'Количество') {
    throw new XlsxParseError(`Unexpected headers at row ${OPS_HEADER_ROW}: "${h1}" / "${h3}" — layout drift`)
  }

  const rows: StoreOperationsRow[] = []
  let totalQty = 0
  sheet.eachRow((row, rn) => {
    if (rn <= OPS_HEADER_ROW) return
    const name = String(row.getCell(1).text ?? '').trim()
    if (!name) return
    const qty = cellNum(row.getCell(3).value)
    if (name === 'Всичко') { totalQty = qty; return }
    rows.push({
      name,
      unit: String(row.getCell(2).text ?? '').trim(),
      qty,
      price: cellNum(row.getCell(4).value),
      value: cellNum(row.getCell(5).value),
    })
  })

  const sumQ = rows.reduce((s, r) => s + r.qty, 0)
  if (totalQty && Math.abs(sumQ - totalQty) > 0.05) {
    throw new XlsxParseError(`Cross-check failed: items sum ${round2(sumQ)} vs Всичко ${totalQty}`)
  }

  return { rows, totalQty, warehouse, operation, periodStart: bgDate(period) }
}

// ── sniffing ─────────────────────────────────────────────────────────────────

export type SpreadsheetKind = 'salesAnalysis' | 'storeOperations'

export interface ParsedSpreadsheet {
  kind: SpreadsheetKind
  salesAnalysis?: SalesAnalysisResult
  storeOperations?: StoreOperationsResult
  /** Human-readable rendering for the review step's text panel. */
  text: string
}

/**
 * Identify and parse a PlusMinus export from its header row, so a user can drop either
 * file on either page and get a precise message rather than a mis-parse. The two layouts
 * are unambiguous: salesAnalysis starts its table with "Артикул", storeOperations with "Име".
 */
export async function parseSpreadsheet(buffer: Buffer): Promise<ParsedSpreadsheet> {
  const sheet = await loadSheet(buffer)
  const salesHeader = String(sheet.getRow(SALES_HEADER_ROW).getCell(1).text ?? '').trim()
  const opsHeader = String(sheet.getRow(OPS_HEADER_ROW).getCell(1).text ?? '').trim()

  if (salesHeader === 'Артикул') {
    const parsed = await parseSalesAnalysis(buffer)
    return {
      kind: 'salesAnalysis',
      salesAnalysis: parsed,
      text: renderRowsAsText(
        `salesAnalysis — ${parsed.rows.length} items, net total ${round2(parsed.totalValue)}`,
        ['Артикул', 'Количество', 'Стойност'],
        parsed.rows.map(r => [r.name, r.qty, r.value]),
      ),
    }
  }

  if (opsHeader === 'Име') {
    const parsed = await parseStoreOperations(buffer)
    return {
      kind: 'storeOperations',
      storeOperations: parsed,
      text: renderRowsAsText(
        `storeOperations — Операция: ${parsed.operation}, Склад: ${parsed.warehouse}, ${parsed.rows.length} items`,
        ['Име', 'Мярка', 'Количество', 'Цена', 'Стойност'],
        parsed.rows.map(r => [r.name, r.unit, r.qty, r.price, r.value]),
      ),
    }
  }

  throw new XlsxParseError(
    `Unrecognised spreadsheet: row ${SALES_HEADER_ROW} starts with "${salesHeader || '(empty)'}" — expected a salesAnalysis ("Артикул") or storeOperations ("Име") export`,
  )
}

// ── shared helpers ───────────────────────────────────────────────────────────

export { round2, round4 }

/**
 * A readable text rendering of a parsed sheet, so the review step's "extracted text" panel
 * shows something meaningful for spreadsheet sources too.
 */
export function renderRowsAsText(title: string, headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [title, '', headers.join('\t')]
  for (const r of rows) lines.push(r.map(String).join('\t'))
  return lines.join('\n')
}
