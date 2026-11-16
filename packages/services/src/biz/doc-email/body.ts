/**
 * The covering note of a mailed document (FR-10), and of several mailed together (2026-11-16).
 *
 * The documents themselves are the attachments, so the note is four paragraphs of text: no templating engine enters
 * the codebase for it. One table of phrases for every kind of document, in the four languages the forms print in.
 *
 * Import-pure.
 */

interface BodyPhrases {
  greeting: string
  attached: string
  regards: string
  date: string
  total: string
  /** „3 документа": the count of a mail that carries several, as its subject and its first line say it. */
  documents: (n: number) => string
}

export const EMAIL_BODY_I18N: Record<string, BodyPhrases> = {
  en: { greeting: 'Hello,', attached: 'Please find attached', regards: 'Kind regards,', date: 'Date', total: 'Total', documents: n => `${n} documents` },
  bg: { greeting: 'Здравейте,', attached: 'Прикачено ще намерите', regards: 'С уважение,', date: 'Дата', total: 'Общо', documents: n => `${n} документа` },
  de: { greeting: 'Guten Tag,', attached: 'Anbei finden Sie', regards: 'Mit freundlichen Grüßen,', date: 'Datum', total: 'Gesamt', documents: n => `${n} Dokumente` },
  mk: { greeting: 'Здраво,', attached: 'Во прилог ќе најдете', regards: 'Со почит,', date: 'Датум', total: 'Вкупно', documents: n => `${n} документи` },
}

function phrases(locale?: string): BodyPhrases {
  return EMAIL_BODY_I18N[(locale || 'en').slice(0, 2)] || EMAIL_BODY_I18N.en
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A deliberately minimal covering note — the document itself is the attachment. No new
 * templating engine enters the codebase for four paragraphs of text.
 *
 * ⚠ FR-10's own, moved here from the export controller as it was: one invoice's mail reads the same from the
 * single route and from a batch of one.
 */
export function buildEmailHtml(opts: {
  title: string
  invoice: any
  orgName: string
  message?: string
  locale?: string
}): string {
  const L = EMAIL_BODY_I18N[(opts.locale || 'en').slice(0, 2)] || EMAIL_BODY_I18N.en
  const inv = opts.invoice
  const issued = inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : ''
  const total = `${Number(inv.total || 0).toFixed(2)} ${esc(inv.currency || '')}`.trim()

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">',
    `<p>${esc(L.greeting)}</p>`,
    `<p>${esc(L.attached)} <strong>${esc(opts.title)} ${esc(inv.invoiceNumber)}</strong>.</p>`,
    opts.message ? `<p>${esc(opts.message).replace(/\n/g, '<br>')}</p>` : '',
    '<table style="border-collapse:collapse;margin:12px 0">',
    issued ? `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(L.date)}</td><td>${esc(issued)}</td></tr>` : '',
    `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(L.total)}</td><td><strong>${total}</strong></td></tr>`,
    '</table>',
    `<p>${esc(L.regards)}<br>${esc(opts.orgName)}</p>`,
    '</div>',
  ].filter(Boolean).join('\n')
}

/** One document of a mail, as the note names it. */
export interface MailedDocument {
  /** What it is, in the mail's language, as a mail of this one document names it: „Поръчка за доставка". */
  title: string
  /** What a list of several calls it, when that is another word (an invoice: „Фактура", where `title` is the single route's). */
  listTitle?: string
  number: string
  date?: Date | string | null
  /** With its currency („120.00 EUR"). A document that states no total leaves it out. */
  total?: string
}

function day(date: MailedDocument['date']): string {
  if (!date) return ''
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** What the mail is called when the person typed no subject: the document, or how many there are. */
export function docEmailSubject(opts: { documents: readonly MailedDocument[]; orgName: string; locale?: string }): string {
  const [first] = opts.documents
  const what = opts.documents.length === 1 && first ? `${first.title} ${first.number}` : phrases(opts.locale).documents(opts.documents.length)
  return `${what} — ${opts.orgName}`.slice(0, 200)
}

/**
 * The note of a mail of any kind of document: one document as a sentence (as `buildEmailHtml` words an invoice), or
 * several as a short list of type, number, date and total, with the person's message under it.
 */
export function docEmailHtml(opts: { documents: readonly MailedDocument[]; orgName: string; message?: string; locale?: string }): string {
  const L = phrases(opts.locale)
  const message = opts.message ? `<p>${esc(opts.message).replace(/\n/g, '<br>')}</p>` : ''
  const label = 'padding:2px 12px 2px 0;color:#666'
  const [first] = opts.documents

  if (opts.documents.length === 1 && first) {
    const issued = day(first.date)
    const rows = [
      issued ? `<tr><td style="${label}">${esc(L.date)}</td><td>${esc(issued)}</td></tr>` : '',
      first.total ? `<tr><td style="${label}">${esc(L.total)}</td><td><strong>${esc(first.total)}</strong></td></tr>` : '',
    ].filter(Boolean)
    return [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">',
      `<p>${esc(L.greeting)}</p>`,
      `<p>${esc(L.attached)} <strong>${esc(first.title)} ${esc(first.number)}</strong>.</p>`,
      message,
      ...(rows.length ? ['<table style="border-collapse:collapse;margin:12px 0">', ...rows, '</table>'] : []),
      `<p>${esc(L.regards)}<br>${esc(opts.orgName)}</p>`,
      '</div>',
    ].filter(Boolean).join('\n')
  }

  const cell = 'padding:2px 12px 2px 0'
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">',
    `<p>${esc(L.greeting)}</p>`,
    `<p>${esc(L.attached)} ${esc(L.documents(opts.documents.length))}:</p>`,
    '<table style="border-collapse:collapse;margin:12px 0">',
    ...opts.documents.map(d => [
      '<tr>',
      `<td style="${label}">${esc(d.listTitle ?? d.title)}</td>`,
      `<td style="${cell}"><strong>${esc(d.number)}</strong></td>`,
      `<td style="${cell}">${esc(day(d.date))}</td>`,
      `<td style="text-align:right">${d.total ? esc(d.total) : ''}</td>`,
      '</tr>',
    ].join('')),
    '</table>',
    message,
    `<p>${esc(L.regards)}<br>${esc(opts.orgName)}</p>`,
    '</div>',
  ].filter(Boolean).join('\n')
}
