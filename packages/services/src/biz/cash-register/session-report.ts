import { cashOnDeliveryOf, keptByMethod, posRowSign, receiptTookMoney, refundGaveMoney, stornoUnproved } from './counting.js'
import { roundCents } from 'config/pos-totals'
import { apportion, grossByRate } from './receipt-lines.js'

/**
 * A till session's own figures, as LGR counts them: what it sold and gave back, by VAT rate and
 * by payment method, and what the drawer should hold.
 *
 * Printed after the Z-report when a session closes, because the Z-report cannot carry them: a
 * device counts only its fiscal receipts, so a till printing text receipts (a device not yet
 * fiscalized, the „Нефискален" switch) closes on a Z-report of zeros. The rows are the session's
 * till rows (`loadPosRows`) and the rules are the session journal entry's (`counting.ts`), so the
 * report and the entry never differ. But for one thing, on purpose: the money of a payment on an
 * invoice (FR-23). Its receipt is on the device and its cash is in the drawer, so the report counts
 * it, and the Z-report agrees; the entry does not, because the invoice's payment posted it. A refund's
 * storno on a credit note is the same money going back: it counts negative here, and its credit
 * note's payment posted it.
 *
 * Import-pure: the close, the reprint and their tests all build it from rows they already hold.
 */
export interface SessionReport {
  sessionNumber: string
  currency: string
  openedAt?: string
  closedAt?: string
  counts: { sales: number; stornos: number; voided: number; fiscal: number; text: number; unprinted: number; payments?: number; refunds?: number }
  /** Per VAT rate: net, VAT and gross — sales less stornos. The rates' gross adds up to `total` (`rowByRate`). */
  vat: Array<{ rate: number; net: number; vat: number; gross: number }>
  total: number
  /**
   * What the session took per method: tendered less change (`keptByMethod`). Cash on delivery is
   * apart from the rest: a courier holds it, not the drawer. A report kept by a close before it
   * existed has no such key.
   */
  byMethod: { cash: number; card: number; other: number; cashOnDelivery?: number }
  change: number
  /**
   * At close: the float, and the cash expected, counted and the difference. `onDevice`: whether the fiscal
   * device has the float (#473), from a session that owed it. Without it a Z's cash reads short by the float.
   */
  drawer: { opening: number; onDevice?: boolean; expected?: number; counted?: number; difference?: number }
  documents?: { first: string; last: string }
  receipts?: { first: string; last: string }
  zReportNumber?: string
  /**
   * What each kind of receipt came to, signed like `total`, which they add up to. Only the fiscal part
   * moves a device's counters: it is what a Z should show, and a text receipt moves none. A report kept
   * by a close before it existed has no such key.
   */
  amounts?: { fiscal: number; text: number; unprinted: number }
  /**
   * What the device's Z answered (`session.zReport`), beside its number, as the device's. Nothing compares
   * it with LGR's: no fiscalized unit has proven what these figures hold. Only the VAT groups with
   * something on them. A driver with no figures has none of this.
   */
  deviceZ?: { fmTotal?: number; turnover: Array<{ group: string; amount: number }> }
}

interface ClosingLine { method: string; expected: number; counted?: number; difference?: number }

const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const toCents = (n: unknown) => Math.round((Number(n) || 0) * 100)
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : undefined)

type ByRate = Map<number, { gross: number; vat: number }>

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0)

/**
 * A row's money per VAT rate, in cents: the gross as its device was given it, and the VAT as the session's
 * journal entry books it. A line's own net and VAT are each rounded on their own and can miss the document by
 * a cent: a valve at 17.8952 net is 17.90 + 3.58 = 21.48 by its line, 21.47 by its receipt. Summed by line, a
 * report printed its rate's gross a cent away from its total (2026-11-06).
 *
 * One rate takes the row's total and VAT as they stand. Several take `grossByRate`: the total shared out in the
 * lines' proportions, the one rule a device is given (`linesOnDevice`, which prints those lines only when they
 * come to it exactly) and a storno is charged against (`printedByRate`), so a sale returned in parts comes back
 * to zero, rate by rate. The VAT is taken out of each rate's gross the device's way where that comes to the row's
 * VAT; otherwise the row's VAT is shared out in those proportions, so the rates still add up to what the entry
 * books. ⚠ A document's VAT can itself be a cent off what its device took out (#554); the report follows the
 * document. Where nothing can be shared (a negative line), the lines' own figures stand, as before.
 */
function rowByRate(row: any): ByRate {
  const lines: ByRate = new Map()
  for (const l of row.lines || []) {
    const rate = Number(l.taxRate) || 0
    const acc = lines.get(rate) || { gross: 0, vat: 0 }
    // A till row's line total is net; its tax is beside it.
    acc.gross += toCents(l.lineTotal) + toCents(l.taxAmount)
    acc.vat += toCents(l.taxAmount)
    lines.set(rate, acc)
  }
  const rates = [...lines.keys()]
  if (!rates.length) return lines
  const total = toCents(row.total)
  const tax = row.taxTotal === undefined || row.taxTotal === null ? sum(rates.map((r) => lines.get(r)!.vat)) : toCents(row.taxTotal)
  if (rates.length === 1) return new Map([[rates[0], { gross: total, vat: tax }]])

  const shares = grossByRate({ total: row.total, lines: rates.map((r) => ({ taxRate: r, lineTotal: lines.get(r)!.gross / 100 })) })
  if (!shares) return lines
  const gross = rates.map((r) => toCents(shares.find((s) => s.rate === r)!.gross))
  const device = rates.map((r, i) => toCents(roundCents((gross[i] / 100) * r / (100 + r))))
  const vat = sum(device) === tax ? device : apportion(device, tax) ?? apportion(rates.map((r) => lines.get(r)!.vat), tax)
  if (!vat) return lines
  return new Map(rates.map((r, i) => [r, { gross: gross[i], vat: vat[i] }]))
}

/** A receipt's outcome as the journal reads it: a row from before the state was recorded has its number. */
function receiptOf(row: any): 'fiscal' | 'text' | 'unprinted' {
  const state = row.fiscal?.state
  const printed = state ? state === 'printed' : !!row.fiscalReceiptNumber
  if (!printed) return 'unprinted'
  return row.fiscal?.mode === 'text' || (!row.fiscal?.mode && !row.isFiscal) ? 'text' : 'fiscal'
}

/** What the report shows of a Z's answer: nothing, from a driver that read no figures out of it. */
function deviceZOf(z: any): SessionReport['deviceZ'] {
  const hasTotal = z?.fmTotal !== undefined && z?.fmTotal !== null
  if (!hasTotal && !z?.turnover?.length) return undefined
  return {
    ...(hasTotal ? { fmTotal: z.fmTotal } : {}),
    turnover: (z.turnover || []).filter((t: any) => t.amount).map((t: any) => ({ group: t.group, amount: t.amount })),
  }
}

/**
 * The report of a session from its till rows, oldest first. Its closing lines and its Z are the session's
 * where it has them, so that one closed before it kept a report rebuilds like any other.
 */
export function buildSessionReport(
  session: any,
  rows: any[],
  opts: { closing?: ClosingLine[]; zReportNumber?: string } = {},
): SessionReport {
  const counts: SessionReport['counts'] = { sales: 0, stornos: 0, voided: 0, fiscal: 0, text: 0, unprinted: 0 }
  const vat: ByRate = new Map()
  const byMethod = { cash: 0, card: 0, other: 0, cashOnDelivery: 0 }
  const amounts = { fiscal: 0, text: 0, unprinted: 0 }
  let total = 0
  let change = 0
  const numbers: string[] = []
  const receipts: string[] = []

  for (const row of rows) {
    // Every document the session numbered is in its range, a voided storno too.
    if (row.transactionNumber) numbers.push(String(row.transactionNumber))
    const payment = row.type === 'payment_receipt'
    const refund = row.type === 'payment_storno'
    const sign = payment ? (receiptTookMoney(row) ? 1 : 0) : refund ? (refundGaveMoney(row) ? -1 : 0) : posRowSign(row)
    const reversal = row.type === 'storno' || row.type === 'return'
    if (!sign) {
      // A storno whose receipt failed reverses nothing, and a receipt that failed took nothing;
      // anything else unsigned is not a sale.
      if ((reversal && !stornoUnproved(row)) || ((payment || refund) && row.status === 'cancelled')) counts.voided++
      continue
    }
    if (reversal) counts.stornos++
    else if (payment) counts.payments = (counts.payments || 0) + 1
    else if (refund) counts.refunds = (counts.refunds || 0) + 1
    else counts.sales++
    counts[receiptOf(row)]++

    // A payment's receipt counts here too: the device's day has it, per VAT group.
    for (const [rate, share] of rowByRate(row)) {
      const acc = vat.get(rate) || { gross: 0, vat: 0 }
      acc.gross += sign * share.gross
      acc.vat += sign * share.vat
      vat.set(rate, acc)
    }
    const kept = keptByMethod(row)
    const courier = cashOnDeliveryOf(row)
    byMethod.cash += sign * kept.cash
    byMethod.card += sign * kept.card
    byMethod.other += sign * (kept.other - courier)
    byMethod.cashOnDelivery += sign * courier
    total += sign * (Number(row.total) || 0)
    amounts[receiptOf(row)] += sign * (Number(row.total) || 0)
    if (sign > 0) change += Number(row.changeDue) || 0
    if (row.fiscalReceiptNumber) receipts.push(String(row.fiscalReceiptNumber))
  }

  const closing: ClosingLine[] | undefined = opts.closing ?? session.closingBreakdown
  const zReportNumber: string | undefined = opts.zReportNumber ?? session.zReportNumber
  const cash = closing?.find((l) => l.method === 'cash')
  const deviceZ = deviceZOf(session.zReport)
  return {
    sessionNumber: session.sessionNumber,
    currency: session.currency || 'EUR',
    openedAt: iso(session.openedAt),
    closedAt: iso(session.closedAt),
    counts,
    vat: [...vat.entries()]
      .sort(([a], [b]) => b - a)
      .map(([rate, a]) => ({ rate, net: (a.gross - a.vat) / 100, vat: a.vat / 100, gross: a.gross / 100 })),
    total: cents(total),
    byMethod: { cash: cents(byMethod.cash), card: cents(byMethod.card), other: cents(byMethod.other), cashOnDelivery: cents(byMethod.cashOnDelivery) },
    change: cents(change),
    drawer: {
      opening: cents(session.openingBalance),
      ...(session.deviceFloat ? { onDevice: session.deviceFloat.state === 'registered' } : {}),
      ...(cash ? { expected: cents(cash.expected), counted: cents(cash.counted ?? 0), difference: cents(cash.difference ?? 0) } : {}),
    },
    ...(numbers.length ? { documents: { first: numbers[0], last: numbers[numbers.length - 1] } } : {}),
    ...(receipts.length ? { receipts: { first: receipts[0], last: receipts[receipts.length - 1] } } : {}),
    ...(zReportNumber ? { zReportNumber } : {}),
    amounts: { fiscal: cents(amounts.fiscal), text: cents(amounts.text), unprinted: cents(amounts.unprinted) },
    ...(deviceZ ? { deviceZ } : {}),
  }
}

export const SESSION_REPORT_LABELS: Record<string, Record<string, string>> = {
  en: {
    title: 'SESSION REPORT', opened: 'Opened', closed: 'Closed', sales: 'Sales', payments: 'Invoice payments', refunds: 'Credit note refunds', stornos: 'Stornos', voided: 'Voided',
    fiscal: 'Fiscal receipts', text: 'Text receipts', unprinted: 'Not printed', vat: 'VAT', net: 'Net', gross: 'Gross',
    total: 'TOTAL', cash: 'Cash', card: 'Card', other: 'Other', cod: 'Cash on delivery', change: 'Change given', opening: 'Opening float',
    expected: 'Expected cash', counted: 'Counted', difference: 'Difference', documents: 'Documents', receipts: 'Receipts',
    z: 'Z-report No.', deviceZ: 'On the device', fmTotal: 'FM total', vatGroup: 'VAT group', notOnDevice: 'Not on the device',
  },
  bg: {
    title: 'ОТЧЕТ ЗА СЕСИЯ', opened: 'Отворена', closed: 'Затворена', sales: 'Продажби', payments: 'Плащания по фактури', refunds: 'Върнато по кр. известия', stornos: 'Сторно', voided: 'Анулирани',
    fiscal: 'Фискални бонове', text: 'Служебни бонове', unprinted: 'Неотпечатани', vat: 'ДДС', net: 'Основа', gross: 'Сума',
    total: 'ОБЩО', cash: 'В брой', card: 'Карта', other: 'Други', cod: 'Наложен платеж', change: 'Върнато ресто', opening: 'Начална сума',
    expected: 'Очаквано в брой', counted: 'Преброено', difference: 'Разлика', documents: 'Документи', receipts: 'Бонове',
    z: 'Z-отчет №', deviceZ: 'По устройството', fmTotal: 'Общо ФП', vatGroup: 'ДДС група', notOnDevice: 'Не е на устройството',
  },
  de: {
    title: 'SITZUNGSBERICHT', opened: 'Geöffnet', closed: 'Geschlossen', sales: 'Verkäufe', payments: 'Rechnungszahlungen', refunds: 'Gutschrift-Erstattungen', stornos: 'Stornos', voided: 'Ungültig',
    fiscal: 'Fiskalbelege', text: 'Textbelege', unprinted: 'Nicht gedruckt', vat: 'MwSt', net: 'Netto', gross: 'Brutto',
    total: 'GESAMT', cash: 'Bar', card: 'Karte', other: 'Sonstige', cod: 'Nachnahme', change: 'Rückgeld', opening: 'Anfangsbestand',
    expected: 'Erwartetes Bargeld', counted: 'Gezählt', difference: 'Differenz', documents: 'Belege', receipts: 'Bons',
    z: 'Z-Bericht Nr.', deviceZ: 'Laut Gerät', fmTotal: 'Summe FS', vatGroup: 'MwSt-Gruppe', notOnDevice: 'Nicht auf dem Gerät',
  },
  mk: {
    title: 'ИЗВЕШТАЈ ЗА СЕСИЈА', opened: 'Отворена', closed: 'Затворена', sales: 'Продажби', payments: 'Плаќања по фактури', refunds: 'Вратено по кр. известув.', stornos: 'Сторно', voided: 'Поништени',
    fiscal: 'Фискални сметки', text: 'Службени сметки', unprinted: 'Неотпечатени', vat: 'ДДВ', net: 'Основица', gross: 'Износ',
    total: 'ВКУПНО', cash: 'Готовина', card: 'Картичка', other: 'Друго', cod: 'При достава', change: 'Вратен кусур', opening: 'Почетна сума',
    expected: 'Очекувана готовина', counted: 'Избројано', difference: 'Разлика', documents: 'Документи', receipts: 'Сметки',
    z: 'Z-извештај бр.', deviceZ: 'Според уредот', fmTotal: 'Вкупно ФМ', vatGroup: 'ДДВ група', notOnDevice: 'Не е на уредот',
  },
}

/**
 * The report as lines for a text receipt: 28 characters, the width every till receipt keeps
 * (`formatNonFiscalLines`), in the org's language, times on `timeZone`'s clock.
 */
export function formatSessionReport(report: SessionReport, locale = 'en', timeZone = 'Europe/Sofia'): string[] {
  const l = SESSION_REPORT_LABELS[locale] || SESSION_REPORT_LABELS.en
  const W = 28
  const sep = '-'.repeat(W)
  const money = (n: number) => n.toFixed(2)
  const lr = (left: string, right: string) => {
    const room = W - right.length - 1
    const head = left.length > room ? left.slice(0, room) : left
    return head + ' '.repeat(Math.max(1, W - head.length - right.length)) + right
  }
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s
  // A kind of receipt: its count beside its name, its amount at the right. A name is never cut: past the
  // width the amount takes a line of its own.
  const kind = (label: string, count: number, amount: number | undefined) => {
    if (amount === undefined) return [lr(label, String(count))]
    const left = `${label} ${count}`
    return left.length + 1 + money(amount).length <= W ? [lr(left, money(amount))] : [lr(label, String(count)), lr('', money(amount))]
  }
  // One short shape in every language: `02.11.2026 г., 13:20` left a label 7 characters, „Затворе".
  const when = (at?: string) => {
    if (!at) return ''
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
    const part = (type: string) => parts.find((p) => p.type === type)?.value
    return `${part('day')}.${part('month')}.${part('year')} ${part('hour')}:${part('minute')}`
  }

  const lines = [center(l.title), sep, report.sessionNumber]
  if (report.openedAt) lines.push(lr(l.opened, when(report.openedAt)))
  if (report.closedAt) lines.push(lr(l.closed, when(report.closedAt)))
  lines.push(sep)
  lines.push(lr(l.sales, String(report.counts.sales)))
  if (report.counts.payments) lines.push(lr(l.payments, String(report.counts.payments)))
  if (report.counts.refunds) lines.push(lr(l.refunds, String(report.counts.refunds)))
  lines.push(lr(l.stornos, String(report.counts.stornos)))
  if (report.counts.voided) lines.push(lr(l.voided, String(report.counts.voided)))
  lines.push(...kind(l.fiscal, report.counts.fiscal, report.amounts?.fiscal))
  lines.push(...kind(l.text, report.counts.text, report.amounts?.text))
  if (report.counts.unprinted) lines.push(...kind(l.unprinted, report.counts.unprinted, report.amounts?.unprinted))
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
  if (report.drawer.onDevice === false) lines.push(` ${l.notOnDevice}`)
  if (report.drawer.expected !== undefined) lines.push(lr(l.expected, money(report.drawer.expected)))
  if (report.drawer.counted !== undefined) lines.push(lr(l.counted, money(report.drawer.counted)))
  if (report.drawer.difference !== undefined) lines.push(lr(l.difference, money(report.drawer.difference)))
  if (report.documents || report.receipts || report.zReportNumber || report.deviceZ) lines.push(sep)
  if (report.documents) {
    lines.push(l.documents)
    lines.push(` ${report.documents.first}`)
    if (report.documents.last !== report.documents.first) lines.push(` ${report.documents.last}`)
  }
  if (report.receipts) lines.push(lr(l.receipts, `${report.receipts.first}-${report.receipts.last}`))
  if (report.zReportNumber) lines.push(lr(l.z, report.zReportNumber))
  if (report.deviceZ) {
    lines.push(l.deviceZ)
    if (report.deviceZ.fmTotal !== undefined) lines.push(lr(` ${l.fmTotal}`, money(report.deviceZ.fmTotal)))
    for (const t of report.deviceZ.turnover) lines.push(lr(` ${l.vatGroup} ${t.group}`, money(t.amount)))
  }
  return lines.map((s) => s.slice(0, W))
}
