/**
 * FR-11.14 (#21) — the digest as HTML.
 *
 * House rule, inherited from `buildEmailHtml`: **inline-styled strings, no templating
 * engine**. Mail clients ignore stylesheets and half of modern CSS anyway, so a template
 * engine would buy nothing but a dependency. Tables and inline styles are the medium.
 *
 * Import-pure — it takes the data shape and a locale, touches no database — so the tests can
 * assert the markup without seeding anything.
 */

import {
  isSectionError,
  type DailyDigestData,
  type DigestDocumentFamily,
  type DigestMaterialBlock,
  type DigestSequenceLine,
  type Section,
} from './daily-digest.types.js'

// ── i18n ×4 (FR-11.17) ──────────────────────────────────────────────────────

export interface DigestStrings {
  subject: string
  heading: string
  forDate: string
  allClear: string
  sectionFailed: string
  none: string
  andMore: string
  generated: string

  kpis: string
  sales: string
  cashRegister: string
  purchases: string
  payments: string
  documents: string
  count: string
  total: string
  number: string
  contact: string
  status: string
  method: string

  sequence: string
  sequenceRange: string
  sequenceEmpty: string
  missingNumbers: string
  lastNumberMismatch: string

  materials: string
  sold: string
  transferred: string
  loaded: string
  product: string
  quantity: string
  value: string
  rows: string

  stock: string
  stockEmpty: string
  warehouse: string

  corrections: string
  correction: string
  writeOff: string
  manualCorrection: string
  lines: string

  undocumented: string
  undocumentedHint: string
  importedNote: string

  duplicates: string
  duplicatesHint: string
  occurrences: string

  edited: string
  action: string
  changes: string
  user: string

  ops: string
  imports: string
  completed: string
  failed: string
  created: string
  failedEmails: string
}

export const DIGEST_I18N: Record<string, DigestStrings> = {
  en: {
    subject: 'Daily report', heading: 'Daily report', forDate: 'for', allClear: 'Nothing to report — the day looks clean.',
    sectionFailed: 'This section could not be built', none: 'none', andMore: 'and {n} more', generated: 'Generated',
    kpis: 'Sales', sales: 'Invoices', cashRegister: 'Cash register', purchases: 'Purchases', payments: 'Payments',
    documents: 'Documents', count: 'Count', total: 'Total', number: 'No.', contact: 'Counterparty', status: 'Status', method: 'Payment',
    sequence: 'Numbering', sequenceRange: '{prefix} {min} → {max}, {n} document(s)',
    sequenceEmpty: 'no documents issued (last number: {last})',
    missingNumbers: 'absent numbers in range', lastNumberMismatch: 'counter says {counter}, the day ends at {dayMax}',
    materials: 'Materials', sold: 'Sold', transferred: 'Transferred', loaded: 'Received',
    product: 'Product', quantity: 'Qty', value: 'Value', rows: 'rows',
    stock: 'Stock at or below zero', stockEmpty: 'no products at or below zero', warehouse: 'Warehouse',
    corrections: 'Corrections and write-offs', correction: 'Correction', writeOff: 'Write-off', manualCorrection: 'Manual correction', lines: 'lines',
    undocumented: 'Sales without a stock document', undocumentedHint: 'Issued sales whose lines name a product and warehouse but moved no stock.',
    importedNote: 'imported (intentionally without a movement)',
    duplicates: 'Possible duplicates', duplicatesHint: 'Same product and quantity sold more than once — for review.', occurrences: 'times',
    edited: 'Edited after issue', action: 'Action', changes: 'Changed fields', user: 'User',
    ops: 'Imports and emails', imports: 'Imports', completed: 'completed', failed: 'failed', created: 'created',
    failedEmails: 'Failed emails',
  },
  bg: {
    subject: 'Дневен отчет', heading: 'Дневен отчет', forDate: 'за', allClear: 'Няма отклонения — денят изглежда чист.',
    sectionFailed: 'Тази секция не можа да бъде изготвена', none: 'няма', andMore: 'и още {n}', generated: 'Генериран',
    kpis: 'Продажби', sales: 'Фактури', cashRegister: 'Каса', purchases: 'Покупки', payments: 'Плащания',
    documents: 'Документи', count: 'Брой', total: 'Общо', number: '№', contact: 'Контрагент', status: 'Статус', method: 'Плащане',
    sequence: 'Номерация', sequenceRange: '{prefix} {min} → {max}, {n} документа',
    sequenceEmpty: 'без издадени документи (последен номер: {last})',
    missingNumbers: 'липсващи номера в диапазона', lastNumberMismatch: 'броячът е на {counter}, а денят завършва на {dayMax}',
    materials: 'Материали', sold: 'Продадени', transferred: 'Прехвърлени', loaded: 'Заредени',
    product: 'Артикул', quantity: 'Кол.', value: 'Стойност', rows: 'реда',
    stock: 'Наличности на или под нула', stockEmpty: 'няма артикули на или под нула', warehouse: 'Склад',
    corrections: 'Корекции и отписвания', correction: 'Корекция', writeOff: 'Отписване', manualCorrection: 'Ръчна корекция', lines: 'реда',
    undocumented: 'Продажби без складов документ', undocumentedHint: 'Издадени продажби с артикул и склад по редовете, но без движение на стока.',
    importedNote: 'импортирана (умишлено без движение)',
    duplicates: 'Съмнителни дублирания', duplicatesHint: 'Един и същ артикул с едно и също количество, продаден повече от веднъж — за преглед.', occurrences: 'пъти',
    edited: 'Редактирани след издаване', action: 'Действие', changes: 'Променени полета', user: 'Потребител',
    ops: 'Импорти и имейли', imports: 'Импорти', completed: 'успешни', failed: 'неуспешни', created: 'създадени',
    failedEmails: 'Неуспешни имейли',
  },
  de: {
    subject: 'Tagesbericht', heading: 'Tagesbericht', forDate: 'für', allClear: 'Keine Auffälligkeiten — der Tag sieht sauber aus.',
    sectionFailed: 'Dieser Abschnitt konnte nicht erstellt werden', none: 'keine', andMore: 'und {n} weitere', generated: 'Erstellt',
    kpis: 'Verkäufe', sales: 'Rechnungen', cashRegister: 'Kasse', purchases: 'Einkäufe', payments: 'Zahlungen',
    documents: 'Belege', count: 'Anzahl', total: 'Gesamt', number: 'Nr.', contact: 'Geschäftspartner', status: 'Status', method: 'Zahlung',
    sequence: 'Nummernkreis', sequenceRange: '{prefix} {min} → {max}, {n} Beleg(e)',
    sequenceEmpty: 'keine Belege ausgestellt (letzte Nummer: {last})',
    missingNumbers: 'fehlende Nummern im Bereich', lastNumberMismatch: 'Zähler steht auf {counter}, der Tag endet bei {dayMax}',
    materials: 'Material', sold: 'Verkauft', transferred: 'Umgelagert', loaded: 'Zugang',
    product: 'Artikel', quantity: 'Menge', value: 'Wert', rows: 'Zeilen',
    stock: 'Bestand auf oder unter null', stockEmpty: 'keine Artikel auf oder unter null', warehouse: 'Lager',
    corrections: 'Korrekturen und Abschreibungen', correction: 'Korrektur', writeOff: 'Abschreibung', manualCorrection: 'Manuelle Korrektur', lines: 'Zeilen',
    undocumented: 'Verkäufe ohne Lagerbeleg', undocumentedHint: 'Ausgestellte Verkäufe mit Artikel und Lager in den Positionen, aber ohne Lagerbewegung.',
    importedNote: 'importiert (bewusst ohne Bewegung)',
    duplicates: 'Mögliche Dubletten', duplicatesHint: 'Gleicher Artikel und gleiche Menge mehrfach verkauft — zur Prüfung.', occurrences: 'mal',
    edited: 'Nach Ausstellung geändert', action: 'Aktion', changes: 'Geänderte Felder', user: 'Benutzer',
    ops: 'Importe und E-Mails', imports: 'Importe', completed: 'erfolgreich', failed: 'fehlgeschlagen', created: 'erstellt',
    failedEmails: 'Fehlgeschlagene E-Mails',
  },
  mk: {
    subject: 'Дневен извештај', heading: 'Дневен извештај', forDate: 'за', allClear: 'Нема отстапувања — денот изгледа чист.',
    sectionFailed: 'Оваа секција не можеше да се изготви', none: 'нема', andMore: 'и уште {n}', generated: 'Генериран',
    kpis: 'Продажби', sales: 'Фактури', cashRegister: 'Каса', purchases: 'Набавки', payments: 'Плаќања',
    documents: 'Документи', count: 'Број', total: 'Вкупно', number: 'Бр.', contact: 'Партнер', status: 'Статус', method: 'Плаќање',
    sequence: 'Нумерација', sequenceRange: '{prefix} {min} → {max}, {n} документи',
    sequenceEmpty: 'без издадени документи (последен број: {last})',
    missingNumbers: 'недостасуваат броеви во опсегот', lastNumberMismatch: 'бројачот е на {counter}, а денот завршува на {dayMax}',
    materials: 'Материјали', sold: 'Продадени', transferred: 'Пренесени', loaded: 'Примени',
    product: 'Артикл', quantity: 'Кол.', value: 'Вредност', rows: 'редови',
    stock: 'Залихи на или под нула', stockEmpty: 'нема артикли на или под нула', warehouse: 'Склад',
    corrections: 'Корекции и отписи', correction: 'Корекција', writeOff: 'Отпис', manualCorrection: 'Рачна корекција', lines: 'редови',
    undocumented: 'Продажби без складишен документ', undocumentedHint: 'Издадени продажби со артикл и склад во ставките, но без движење на стока.',
    importedNote: 'импортирана (намерно без движење)',
    duplicates: 'Можни дупликати', duplicatesHint: 'Ист артикл со иста количина продаден повеќе од еднаш — за проверка.', occurrences: 'пати',
    edited: 'Изменети по издавање', action: 'Дејство', changes: 'Изменети полиња', user: 'Корисник',
    ops: 'Импорти и е-пошта', imports: 'Импорти', completed: 'успешни', failed: 'неуспешни', created: 'создадени',
    failedEmails: 'Неуспешни е-пораки',
  },
}

export function digestStrings(locale?: string): DigestStrings {
  return DIGEST_I18N[(locale || 'en').slice(0, 2)] || DIGEST_I18N.en
}

// ── Markup helpers ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function fmt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}
function num(n: number, digits = 2): string {
  return (n ?? 0).toFixed(digits)
}
/** DD.MM.YYYY — the format every printed form in this system uses. */
function humanDate(iso: string): string {
  const [y, m, d] = (iso || '').split('-')
  return y ? `${d}.${m}.${y}` : iso
}

const S = {
  body: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:760px',
  h2: 'font-size:15px;margin:22px 0 6px;padding-bottom:4px;border-bottom:2px solid #8e24aa;color:#111',
  table: 'border-collapse:collapse;width:100%;margin:6px 0 10px',
  th: 'text-align:left;padding:4px 8px;background:#f4f4f6;border-bottom:1px solid #ddd;font-size:12px;color:#555',
  thR: 'text-align:right;padding:4px 8px;background:#f4f4f6;border-bottom:1px solid #ddd;font-size:12px;color:#555',
  td: 'padding:4px 8px;border-bottom:1px solid #eee;font-size:13px',
  tdR: 'padding:4px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;white-space:nowrap',
  muted: 'color:#888;font-size:12px',
  note: 'color:#666;font-size:12px;margin:2px 0 8px',
  warn: 'color:#b26a00',
  bad: 'color:#c62828',
  totalRow: 'font-weight:bold;background:#fafafa',
}

function h2(text: string): string {
  return `<h2 style="${S.h2}">${esc(text)}</h2>`
}
function moreLine(more: number, L: DigestStrings): string {
  return more > 0 ? `<div style="${S.muted}">${esc(fmt(L.andMore, { n: more }))}</div>` : ''
}
function noneLine(L: DigestStrings): string {
  return `<div style="${S.muted}">${esc(L.none)}</div>`
}

/** A section that failed renders its failure inline instead of vanishing. */
function guard<T>(s: Section<T> | undefined, L: DigestStrings, render: (v: T) => string): string {
  if (s === undefined) return ''
  if (isSectionError(s)) return `<div style="${S.bad};font-size:12px">${esc(L.sectionFailed)}: ${esc(s.message)}</div>`
  return render(s as T)
}

// ── Section renderers ───────────────────────────────────────────────────────

function renderSequence(seq: DigestSequenceLine | undefined, L: DigestStrings): string {
  if (!seq) return ''
  const parts: string[] = []
  if (seq.count && seq.min && seq.max) {
    parts.push(esc(fmt(L.sequenceRange, { prefix: seq.prefix, min: seq.min, max: seq.max, n: seq.count })))
  } else {
    parts.push(esc(fmt(L.sequenceEmpty, { last: seq.lastNumber ?? '—' })))
  }
  if (seq.missing.length) {
    parts.push(`<span style="${S.bad}">${esc(L.missingNumbers)}: ${esc(seq.missing.join(', '))}</span>`)
  }
  if (seq.lastNumberMismatch) {
    parts.push(`<span style="${S.warn}">${esc(fmt(L.lastNumberMismatch, seq.lastNumberMismatch))}</span>`)
  }
  return `<div style="${S.note}">${L.sequence}: ${parts.join(' · ')}</div>`
}

function renderFamily(f: DigestDocumentFamily, title: string, L: DigestStrings): string {
  const head = `<div style="font-weight:bold;margin-top:10px">${esc(title)}</div>`
  if (!f.count) return head + renderSequence(f.sequence, L) + noneLine(L)

  const rows = f.rows.map(r => `
    <tr>
      <td style="${S.td}">${esc(r.number)}</td>
      <td style="${S.td}">${esc(r.contactName)}</td>
      <td style="${S.td}">${esc(r.status)}</td>
      <td style="${S.td}">${esc(r.paymentMethod || '')}</td>
      <td style="${S.tdR}">${num(r.total)} ${esc(r.currency)}</td>
    </tr>`).join('')

  return [
    head,
    renderSequence(f.sequence, L),
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}">${esc(L.contact)}</th>`,
    `<th style="${S.th}">${esc(L.status)}</th><th style="${S.th}">${esc(L.method)}</th>`,
    `<th style="${S.thR}">${esc(L.total)}</th></tr>`,
    rows,
    `<tr style="${S.totalRow}"><td style="${S.td}" colspan="4">${esc(L.total)} (${f.count})</td>`,
    `<td style="${S.tdR}">${num(f.total)}</td></tr>`,
    '</table>',
    moreLine(f.more, L),
  ].join('\n')
}

function renderMaterialBlock(b: DigestMaterialBlock, title: string, L: DigestStrings): string {
  const head = `<div style="font-weight:bold;margin-top:10px">${esc(title)}</div>`
  if (!b.rowCount) return head + noneLine(L)

  const rows = b.rows.map(r => `
    <tr>
      <td style="${S.td}">${esc(r.sku)}</td>
      <td style="${S.td}">${esc(r.name)}</td>
      <td style="${S.tdR}">${num(r.quantity, 3)} ${esc(r.unit)}</td>
      <td style="${S.tdR}">${num(r.value)}</td>
    </tr>`).join('')

  return [
    head,
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}">SKU</th><th style="${S.th}">${esc(L.product)}</th>`,
    `<th style="${S.thR}">${esc(L.quantity)}</th><th style="${S.thR}">${esc(L.value)}</th></tr>`,
    rows,
    // Σ quantity across products is meaningless — row count is the honest companion to Σ value.
    `<tr style="${S.totalRow}"><td style="${S.td}" colspan="2">${b.rowCount} ${esc(L.rows)}</td>`,
    `<td style="${S.tdR}"></td><td style="${S.tdR}">${num(b.totalValue)}</td></tr>`,
    '</table>',
    moreLine(b.more, L),
  ].join('\n')
}

// ── The page ────────────────────────────────────────────────────────────────

export function digestSubject(data: DailyDigestData): string {
  const L = digestStrings(data.locale)
  return `${L.subject} — ${data.orgName} — ${humanDate(data.date)}`
}

export function renderDigestHtml(data: DailyDigestData): string {
  const L = digestStrings(data.locale)
  const out: string[] = [`<div style="${S.body}">`]

  out.push(`<h1 style="font-size:18px;margin:0 0 2px">${esc(L.heading)}</h1>`)
  out.push(`<div style="${S.muted}">${esc(data.orgName)} · ${esc(L.forDate)} ${esc(humanDate(data.date))}</div>`)

  // An empty day still sends: silence is itself the signal that the day was clean.
  if (data.allClear) {
    out.push(`<p style="margin:16px 0;padding:10px 12px;background:#f1f8e9;border-left:4px solid #7cb342">${esc(L.allClear)}</p>`)
  }

  out.push(guard(data.kpis, L, k => [
    h2(L.kpis),
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}"></th><th style="${S.thR}">${esc(L.count)}</th><th style="${S.thR}">${esc(L.total)}</th></tr>`,
    `<tr><td style="${S.td}">${esc(L.sales)}</td><td style="${S.tdR}">${k.salesCount}</td><td style="${S.tdR}">${num(k.salesTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.cashRegister)}</td><td style="${S.tdR}">${k.cashCount}</td><td style="${S.tdR}">${num(k.cashTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.purchases)}</td><td style="${S.tdR}">${k.purchaseCount}</td><td style="${S.tdR}">${num(k.purchaseTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.payments)}</td><td style="${S.tdR}">${k.paymentsCount}</td><td style="${S.tdR}">${num(k.paymentsTotal)} ${esc(k.currency)}</td></tr>`,
    '</table>',
    k.byMethod.length
      ? `<div style="${S.note}">${k.byMethod.map(m => `${esc(m.method)}: ${num(m.amount)}`).join(' · ')}</div>`
      : '',
  ].join('\n')))

  out.push(guard(data.documents, L, d => [
    h2(L.documents),
    renderFamily(d.sales, L.sales, L),
    renderFamily(d.cash, L.cashRegister, L),
    d.purchases.count
      ? `<div style="${S.note}">${esc(L.purchases)}: ${d.purchases.count} · ${num(d.purchases.total)}</div>`
      : '',
  ].join('\n')))

  out.push(guard(data.materials, L, m => [
    h2(L.materials),
    renderMaterialBlock(m.sold, L.sold, L),
    renderMaterialBlock(m.transferred, L.transferred, L),
    renderMaterialBlock(m.loaded, L.loaded, L),
  ].join('\n')))

  out.push(guard(data.stock, L, s => {
    if (!s.count) return h2(L.stock) + `<div style="${S.muted}">${esc(L.stockEmpty)}</div>`
    const rows = s.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.sku)}</td>
        <td style="${S.td}">${esc(r.name)}</td>
        <td style="${S.td}">${esc(r.warehouseName)}</td>
        <td style="${S.tdR};${r.quantity < 0 ? S.bad : ''}">${num(r.quantity, 3)}</td>
      </tr>`).join('')
    return [
      h2(`${L.stock} (${s.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">SKU</th><th style="${S.th}">${esc(L.product)}</th>`,
      `<th style="${S.th}">${esc(L.warehouse)}</th><th style="${S.thR}">${esc(L.quantity)}</th></tr>`,
      rows, '</table>', moreLine(s.more, L),
    ].join('\n')
  }))

  out.push(guard(data.corrections, L, c => {
    if (!c.count) return h2(L.corrections) + noneLine(L)
    const label = (k: string) => k === 'correction' ? L.correction : k === 'writeOff' ? L.writeOff : L.manualCorrection
    const rows = c.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.movementNumber)}</td>
        <td style="${S.td}">${esc(label(r.kind))}</td>
        <td style="${S.tdR}">${r.lineCount} ${esc(L.lines)}</td>
        <td style="${S.tdR};${r.quantity < 0 ? S.bad : ''}">${num(r.quantity, 3)}</td>
        <td style="${S.tdR}">${num(r.value)}</td>
      </tr>`).join('')
    return [
      h2(`${L.corrections} (${c.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}"></th>`,
      `<th style="${S.thR}"></th><th style="${S.thR}">${esc(L.quantity)}</th><th style="${S.thR}">${esc(L.value)}</th></tr>`,
      rows, '</table>', moreLine(c.more, L),
    ].join('\n')
  }))

  out.push(guard(data.undocumentedSales, L, u => {
    if (!u.count) return h2(L.undocumented) + noneLine(L)
    const rows = u.rows.map(r => `
      <tr${r.imported ? ' style="color:#999"' : ''}>
        <td style="${S.td}">${esc(r.number)}</td>
        <td style="${S.td}">${esc(r.type)}${r.imported ? ` <span style="${S.muted}">(${esc(L.importedNote)})</span>` : ''}</td>
        <td style="${S.tdR}">${num(r.total)}</td>
      </tr>`).join('')
    return [
      h2(`${L.undocumented} (${u.count})`),
      `<div style="${S.note}">${esc(L.undocumentedHint)}</div>`,
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}"></th><th style="${S.thR}">${esc(L.total)}</th></tr>`,
      rows, '</table>', moreLine(u.more, L),
    ].join('\n')
  }))

  out.push(guard(data.duplicates, L, d => {
    if (!d.count) return h2(L.duplicates) + noneLine(L)
    const rows = d.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.name)}</td>
        <td style="${S.tdR}">${num(r.quantity, 3)}</td>
        <td style="${S.tdR}">${r.occurrences} ${esc(L.occurrences)}</td>
        <td style="${S.td}">${esc(r.documents.join(', '))}</td>
      </tr>`).join('')
    return [
      h2(`${L.duplicates} (${d.count})`),
      `<div style="${S.note}">${esc(L.duplicatesHint)}</div>`,
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.product)}</th><th style="${S.thR}">${esc(L.quantity)}</th>`,
      `<th style="${S.thR}">${esc(L.occurrences)}</th><th style="${S.th}">${esc(L.documents)}</th></tr>`,
      rows, '</table>', moreLine(d.more, L),
    ].join('\n')
  }))

  out.push(guard(data.editedAfterIssue, L, e => {
    if (!e.count) return h2(L.edited) + noneLine(L)
    const rows = e.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.entityName)}</td>
        <td style="${S.td}">${esc(r.action)}</td>
        <td style="${S.tdR}">${r.changeCount}</td>
        <td style="${S.td}">${esc(r.userName)}</td>
      </tr>`).join('')
    return [
      h2(`${L.edited} (${e.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}">${esc(L.action)}</th>`,
      `<th style="${S.thR}">${esc(L.changes)}</th><th style="${S.th}">${esc(L.user)}</th></tr>`,
      rows, '</table>', moreLine(e.more, L),
    ].join('\n')
  }))

  out.push(guard(data.ops, L, o => {
    if (!o.tasks.length && !o.failedEmailCount) return h2(L.ops) + noneLine(L)
    const tasks = o.tasks.map(t =>
      `<div style="${S.note}">${esc(t.type)}: ${t.completed} ${esc(L.completed)}, ${t.failed} ${esc(L.failed)}` +
      (t.created ? `, ${t.created} ${esc(L.created)}` : '') + '</div>').join('')
    const emails = o.failedEmailCount
      ? [
        `<div style="${S.note};${S.bad}">${esc(L.failedEmails)}: ${o.failedEmailCount}</div>`,
        ...o.failedEmails.map(e => `<div style="${S.muted}">${esc(e.to)} — ${esc(e.error)}</div>`),
      ].join('')
      : ''
    return h2(L.ops) + tasks + emails
  }))

  out.push(`<hr style="border:0;border-top:1px solid #eee;margin:20px 0 8px">`)
  out.push(`<div style="${S.muted}">${esc(data.orgName)} · ${esc(L.generated)} ${esc(data.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(data.timezone)}</div>`)
  out.push('</div>')

  return out.filter(Boolean).join('\n')
}
