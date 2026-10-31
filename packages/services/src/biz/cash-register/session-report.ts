import { cashOnDeliveryOf, keptByMethod, posRowSign } from './counting.js'

/**
 * A till session's own figures, as LGR counts them: what it sold and gave back, by VAT rate and
 * by payment method, and what the drawer should hold.
 *
 * Printed after the Z-report when a session closes, because the Z-report cannot carry them: a
 * device counts only its fiscal receipts, so a till printing text receipts (a device not yet
 * fiscalized, the „Нефискален" switch) closes on a Z-report of zeros. The rows are the session's
 * till rows (`loadPosRows`) and the rules are the session journal entry's (`counting.ts`), so the
 * report and the entry never differ.
 *
 * Import-pure: the close, the reprint and their tests all build it from rows they already hold.
 */
export interface SessionReport {
  sessionNumber: string
  currency: string
  openedAt?: string
  closedAt?: string
  counts: { sales: number; stornos: number; voided: number; fiscal: number; text: number; unprinted: number }
  /** Per VAT rate: net, VAT and gross — sales less stornos. */
  vat: Array<{ rate: number; net: number; vat: number; gross: number }>
  total: number
  /**
   * What the session took per method: tendered less change (`keptByMethod`). Cash on delivery is
   * apart from the rest: a courier holds it, not the drawer. A report kept by a close before it
   * existed has no such key.
   */
  byMethod: { cash: number; card: number; other: number; cashOnDelivery?: number }
  change: number
  /** At close: the float, and the cash expected, counted and the difference. */
  drawer: { opening: number; expected?: number; counted?: number; difference?: number }
  documents?: { first: string; last: string }
  receipts?: { first: string; last: string }
  zReportNumber?: string
}

interface ClosingLine { method: string; expected: number; counted?: number; difference?: number }

const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : undefined)

/** A receipt's outcome as the journal reads it: a row from before the state was recorded has its number. */
function receiptOf(row: any): 'fiscal' | 'text' | 'unprinted' {
  const state = row.fiscal?.state
  const printed = state ? state === 'printed' : !!row.fiscalReceiptNumber
  if (!printed) return 'unprinted'
  return row.fiscal?.mode === 'text' || (!row.fiscal?.mode && !row.isFiscal) ? 'text' : 'fiscal'
}

/** The report of a session from its till rows, oldest first; `closing` once it is closed. */
export function buildSessionReport(
  session: any,
  rows: any[],
  opts: { closing?: ClosingLine[]; zReportNumber?: string } = {},
): SessionReport {
  const counts = { sales: 0, stornos: 0, voided: 0, fiscal: 0, text: 0, unprinted: 0 }
  const vat = new Map<number, { net: number; vat: number }>()
  const byMethod = { cash: 0, card: 0, other: 0, cashOnDelivery: 0 }
  let total = 0
  let change = 0
  const numbers: string[] = []
  const receipts: string[] = []

  for (const row of rows) {
    // Every document the session numbered is in its range, a voided storno too.
    if (row.transactionNumber) numbers.push(String(row.transactionNumber))
    const sign = posRowSign(row)
    const reversal = row.type === 'storno' || row.type === 'return'
    if (!sign) {
      // A storno whose receipt failed reverses nothing; anything else unsigned is not a sale.
      if (reversal) counts.voided++
      continue
    }
    if (reversal) counts.stornos++
    else counts.sales++
    counts[receiptOf(row)]++

    for (const l of row.lines || []) {
      const rate = Number(l.taxRate) || 0
      const acc = vat.get(rate) || { net: 0, vat: 0 }
      // A till row's line total is net; its tax is beside it.
      acc.net += sign * (Number(l.lineTotal) || 0)
      acc.vat += sign * (Number(l.taxAmount) || 0)
      vat.set(rate, acc)
    }
    const kept = keptByMethod(row)
    const courier = cashOnDeliveryOf(row)
    byMethod.cash += sign * kept.cash
    byMethod.card += sign * kept.card
    byMethod.other += sign * (kept.other - courier)
    byMethod.cashOnDelivery += sign * courier
    total += sign * (Number(row.total) || 0)
    if (sign > 0) change += Number(row.changeDue) || 0
    if (row.fiscalReceiptNumber) receipts.push(String(row.fiscalReceiptNumber))
  }

  const cash = opts.closing?.find((l) => l.method === 'cash')
  return {
    sessionNumber: session.sessionNumber,
    currency: session.currency || 'EUR',
    openedAt: iso(session.openedAt),
    closedAt: iso(session.closedAt),
    counts,
    vat: [...vat.entries()]
      .sort(([a], [b]) => b - a)
      .map(([rate, a]) => ({ rate, net: cents(a.net), vat: cents(a.vat), gross: cents(a.net + a.vat) })),
    total: cents(total),
    byMethod: { cash: cents(byMethod.cash), card: cents(byMethod.card), other: cents(byMethod.other), cashOnDelivery: cents(byMethod.cashOnDelivery) },
    change: cents(change),
    drawer: {
      opening: cents(session.openingBalance),
      ...(cash ? { expected: cents(cash.expected), counted: cents(cash.counted ?? 0), difference: cents(cash.difference ?? 0) } : {}),
    },
    ...(numbers.length ? { documents: { first: numbers[0], last: numbers[numbers.length - 1] } } : {}),
    ...(receipts.length ? { receipts: { first: receipts[0], last: receipts[receipts.length - 1] } } : {}),
    ...(opts.zReportNumber ? { zReportNumber: opts.zReportNumber } : {}),
  }
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: 'SESSION REPORT', opened: 'Opened', closed: 'Closed', sales: 'Sales', stornos: 'Stornos', voided: 'Voided',
    fiscal: 'Fiscal receipts', text: 'Text receipts', unprinted: 'Not printed', vat: 'VAT', net: 'Net', gross: 'Gross',
    total: 'TOTAL', cash: 'Cash', card: 'Card', other: 'Other', cod: 'Cash on delivery', change: 'Change given', opening: 'Opening float',
    expected: 'Expected cash', counted: 'Counted', difference: 'Difference', documents: 'Documents', receipts: 'Receipts',
    z: 'Z-report No.',
  },
  bg: {
    title: 'ОТЧЕТ ЗА СЕСИЯ', opened: 'Отворена', closed: 'Затворена', sales: 'Продажби', stornos: 'Сторно', voided: 'Анулирани',
    fiscal: 'Фискални бонове', text: 'Служебни бонове', unprinted: 'Неотпечатани', vat: 'ДДС', net: 'Основа', gross: 'Сума',
    total: 'ОБЩО', cash: 'В брой', card: 'Карта', other: 'Други', cod: 'Наложен платеж', change: 'Върнато ресто', opening: 'Начална сума',
    expected: 'Очаквано в брой', counted: 'Преброено', difference: 'Разлика', documents: 'Документи', receipts: 'Бонове',
    z: 'Z-отчет №',
  },
  de: {
    title: 'SITZUNGSBERICHT', opened: 'Geöffnet', closed: 'Geschlossen', sales: 'Verkäufe', stornos: 'Stornos', voided: 'Ungültig',
    fiscal: 'Fiskalbelege', text: 'Textbelege', unprinted: 'Nicht gedruckt', vat: 'MwSt', net: 'Netto', gross: 'Brutto',
    total: 'GESAMT', cash: 'Bar', card: 'Karte', other: 'Sonstige', cod: 'Nachnahme', change: 'Rückgeld', opening: 'Anfangsbestand',
    expected: 'Erwartetes Bargeld', counted: 'Gezählt', difference: 'Differenz', documents: 'Belege', receipts: 'Bons',
    z: 'Z-Bericht Nr.',
  },
  mk: {
    title: 'ИЗВЕШТАЈ ЗА СЕСИЈА', opened: 'Отворена', closed: 'Затворена', sales: 'Продажби', stornos: 'Сторно', voided: 'Поништени',
    fiscal: 'Фискални сметки', text: 'Службени сметки', unprinted: 'Неотпечатени', vat: 'ДДВ', net: 'Основица', gross: 'Износ',
    total: 'ВКУПНО', cash: 'Готовина', card: 'Картичка', other: 'Друго', cod: 'При достава', change: 'Вратен кусур', opening: 'Почетна сума',
    expected: 'Очекувана готовина', counted: 'Избројано', difference: 'Разлика', documents: 'Документи', receipts: 'Сметки',
    z: 'Z-извештај бр.',
  },
}

/**
 * The report as lines for a text receipt: 28 characters, the width every till receipt keeps
 * (`formatNonFiscalLines`), in the org's language, times on `timeZone`'s clock.
 */
export function formatSessionReport(report: SessionReport, locale = 'en', timeZone = 'Europe/Sofia'): string[] {
  const l = LABELS[locale] || LABELS.en
  const W = 28
  const sep = '-'.repeat(W)
  const money = (n: number) => n.toFixed(2)
  const lr = (left: string, right: string) => {
    const room = W - right.length - 1
    const head = left.length > room ? left.slice(0, room) : left
    return head + ' '.repeat(Math.max(1, W - head.length - right.length)) + right
  }
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s
  const when = (at?: string) => (at
    ? new Date(at).toLocaleString(`${locale}-${locale.toUpperCase()}`, { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '')

  const lines = [center(l.title), sep, report.sessionNumber]
  if (report.openedAt) lines.push(lr(l.opened, when(report.openedAt)))
  if (report.closedAt) lines.push(lr(l.closed, when(report.closedAt)))
  lines.push(sep)
  lines.push(lr(l.sales, String(report.counts.sales)))
  lines.push(lr(l.stornos, String(report.counts.stornos)))
  if (report.counts.voided) lines.push(lr(l.voided, String(report.counts.voided)))
  lines.push(lr(l.fiscal, String(report.counts.fiscal)))
  lines.push(lr(l.text, String(report.counts.text)))
  if (report.counts.unprinted) lines.push(lr(l.unprinted, String(report.counts.unprinted)))
  lines.push(sep)
  for (const v of report.vat) {
    lines.push(`${l.vat} ${v.rate}%`)
    lines.push(lr(` ${l.net}`, money(v.net)))
    lines.push(lr(` ${l.vat}`, money(v.vat)))
    lines.push(lr(` ${l.gross}`, money(v.gross)))
  }
  lines.push(lr(`${l.total} ${report.currency}`, money(report.total)))
  lines.push(sep)
  lines.push(lr(l.cash, money(report.byMethod.cash)))
  lines.push(lr(l.card, money(report.byMethod.card)))
  if (report.byMethod.other) lines.push(lr(l.other, money(report.byMethod.other)))
  if (report.byMethod.cashOnDelivery) lines.push(lr(l.cod, money(report.byMethod.cashOnDelivery)))
  if (report.change) lines.push(lr(l.change, money(report.change)))
  lines.push(sep)
  lines.push(lr(l.opening, money(report.drawer.opening)))
  if (report.drawer.expected !== undefined) lines.push(lr(l.expected, money(report.drawer.expected)))
  if (report.drawer.counted !== undefined) lines.push(lr(l.counted, money(report.drawer.counted)))
  if (report.drawer.difference !== undefined) lines.push(lr(l.difference, money(report.drawer.difference)))
  if (report.documents || report.receipts || report.zReportNumber) lines.push(sep)
  if (report.documents) {
    lines.push(l.documents)
    lines.push(` ${report.documents.first}`)
    if (report.documents.last !== report.documents.first) lines.push(` ${report.documents.last}`)
  }
  if (report.receipts) lines.push(lr(l.receipts, `${report.receipts.first}-${report.receipts.last}`))
  if (report.zReportNumber) lines.push(lr(l.z, report.zReportNumber))
  return lines.map((s) => s.slice(0, W))
}
