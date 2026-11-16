import { describe, it, expect } from 'bun:test'
// Import-pure modules: this file never boots Mongoose.
import {
  DOC_EMAIL_BLOCKS, DOC_EMAIL_SKIPS, EMAIL_RE, MAX_DOCS_PER_MAIL, MAX_SELECTION, NO_PARTNER, RESEND_WINDOW_MS, SINGLE_ADDRESS,
  chunkDocuments, groupByPartner, idsThatWent, isValidRecipient, planByPartner, planForOneAddress, planTotals, sendableRows, wentOut,
  type DocEmailPreviewRow, type DocEmailResult,
} from 'config/doc-email'
import { attachmentWeight, packAttachments } from 'services/biz/doc-email/pack'
import { buildEmailHtml, docEmailHtml, docEmailSubject } from 'services/biz/doc-email/body'

/**
 * The ticked documents of a list, by e-mail (2026-11-16): the parts that decide without a server.
 *
 * - how the dialog turns its lines into requests (`config/doc-email`): the two ways to address a batch, an address
 *   typed twice, ten documents to a request, what leaves the selection;
 * - how the engine packs files into mails (`services/biz/doc-email/pack`), by count and by bytes;
 * - what the covering note says (`services/biz/doc-email/body`).
 */

const row = (id: string, partner?: { id: string; name: string; email?: string }, extra: Partial<DocEmailPreviewRow> = {}): DocEmailPreviewRow => ({
  id, number: `N-${id}`, docType: 'invoice', ...(partner ? { partner } : {}), ...extra,
})

const ALFA = { id: 'p1', name: 'Alfa', email: 'office@alfa.example' }
const BETA = { id: 'p2', name: 'Beta' }

describe('the limits and the address pattern', () => {
  it('ten documents to a mail, a hundred to a selection', () => {
    expect(MAX_DOCS_PER_MAIL).toBe(10)
    expect(MAX_SELECTION).toBe(100)
  })

  it('why a document does not go: a cancelled movement after a draft, and the double click only once there is an address', () => {
    expect([...DOC_EMAIL_BLOCKS]).toEqual(['not_found', 'forbidden', 'draft', 'cancelled'])
    expect([...DOC_EMAIL_SKIPS]).toEqual(['not_found', 'forbidden', 'draft', 'cancelled', 'just_sent'])
    // A minute: the same document to the same address again inside it is a double click.
    expect(RESEND_WINDOW_MS).toBe(60_000)
  })

  it('an address is anything with one @ and a dot after it, trimmed', () => {
    expect(isValidRecipient('  someone@example.com ')).toBe(true)
    expect(EMAIL_RE.test('first.last+tag@sub.example.co.uk')).toBe(true)
    for (const bad of ['', 'nope@', '@example.com', 'two@@example.com', 'a b@example.com', null, undefined]) {
      expect(isValidRecipient(bad), String(bad)).toBe(false)
    }
  })
})

describe('to the customer or supplier', () => {
  const rows = [
    row('1', ALFA), row('2', BETA), row('3', ALFA), row('4'),
    row('5', ALFA, { blocked: 'draft' }), row('6', undefined, { blocked: 'not_found' }), row('7', BETA, { blocked: 'cancelled' }),
  ]

  it('a line per partner in the order first ticked, the partner-less documents last, the blocked ones in none', () => {
    const groups = groupByPartner(rows)
    expect(groups.map(g => [g.key, g.email, g.rows.map(r => r.id)])).toEqual([
      ['p1', 'office@alfa.example', ['1', '3']],
      ['p2', '', ['2']],
      [NO_PARTNER, '', ['4']],
    ])
    expect(sendableRows(rows).map(r => r.id)).toEqual(['1', '2', '3', '4'])
  })

  it('a line without an address stays behind; the others go', () => {
    const groups = groupByPartner(rows)
    const plan = planByPartner(groups, { p1: 'office@alfa.example' })
    expect(plan.entries.map(e => [e.to, e.rows.map(r => r.id)])).toEqual([['office@alfa.example', ['1', '3']]])
    expect(plan.unaddressed.map(r => r.id)).toEqual(['2', '4'])
    expect(plan.invalid).toEqual([])
    expect(planTotals(plan)).toEqual({ documents: 2, recipients: 1, requests: 1 })
  })

  it('an address that is none is named by its line, and nothing of that line is planned', () => {
    const plan = planByPartner(groupByPartner(rows), { p1: 'office@alfa.example', p2: 'beta-at-example', [NO_PARTNER]: ' ' })
    expect(plan.invalid).toEqual(['p2'])
    expect(plan.entries.map(e => e.to)).toEqual(['office@alfa.example'])
    expect(plan.unaddressed.map(r => r.id)).toEqual(['4'])
  })

  it('two lines typed to one address are one recipient, however it is capitalised', () => {
    const plan = planByPartner(groupByPartner(rows), { p1: 'Office@Alfa.example', p2: ' office@alfa.EXAMPLE ', [NO_PARTNER]: 'me@example.com' })
    expect(plan.entries.map(e => [e.to, e.rows.map(r => r.id)])).toEqual([
      ['Office@Alfa.example', ['1', '3', '2']],
      ['me@example.com', ['4']],
    ])
    expect(planTotals(plan)).toEqual({ documents: 4, recipients: 2, requests: 2 })
  })
})

describe('to one address', () => {
  const rows = [row('1', ALFA), row('2', BETA), row('3', undefined, { blocked: 'forbidden' })]

  it('every sendable document to the address typed', () => {
    const plan = planForOneAddress(rows, ' colleague@example.com ')
    expect(plan.entries.map(e => [e.to, e.rows.map(r => r.id)])).toEqual([['colleague@example.com', ['1', '2']]])
    expect(plan.invalid).toEqual([])
  })

  it('no address: nothing to send. A bad one: invalid, and nothing planned', () => {
    expect(planForOneAddress(rows, '')).toEqual({ entries: [], unaddressed: sendableRows(rows), invalid: [] })
    expect(planForOneAddress(rows, 'colleague')).toEqual({ entries: [], unaddressed: [], invalid: [SINGLE_ADDRESS] })
  })

  it('nothing sendable is no entry, whatever the address', () => {
    expect(planForOneAddress([row('1', ALFA, { blocked: 'draft' })], 'a@example.com').entries).toEqual([])
  })
})

describe('ten documents to a request', () => {
  it('chunks in order, the rest last', () => {
    const ids = Array.from({ length: 23 }, (_, i) => i + 1)
    const chunks = chunkDocuments(ids)
    expect(chunks.map(c => c.length)).toEqual([10, 10, 3])
    expect(chunks.flat()).toEqual(ids)
    expect(chunkDocuments([])).toEqual([])
    expect(chunkDocuments([1, 2, 3], 0)).toEqual([[1], [2], [3]])
  })

  it('the button counts documents, addresses and requests', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(String(i + 1), ALFA))
    expect(planTotals(planForOneAddress(many, 'a@example.com'))).toEqual({ documents: 12, recipients: 1, requests: 2 })
  })
})

describe('what leaves the selection', () => {
  const result = (id: string, status: DocEmailResult['status'], groupId?: string): DocEmailResult => ({ id, ...(groupId ? { groupId } : {}), number: `N-${id}`, status })

  it('a document that was sent or queued went; a skipped or failed one did not', () => {
    expect(['sent', 'queued', 'skipped', 'failed'].map(status => wentOut({ status: status as any }))).toEqual([true, true, false, false])
    const rows = [row('1', ALFA), row('2', ALFA), row('3', ALFA), row('4', ALFA, { blocked: 'draft' })]
    expect(idsThatWent(rows, [result('1', 'sent'), result('2', 'failed'), result('3', 'queued')])).toEqual(['1', '3'])
  })

  it('a supplier order leaves only when every sheet of it went', () => {
    const rows = [
      row('o1', ALFA, { groupId: 'g1', docType: 'order' }), row('o1', BETA, { groupId: 'g2', docType: 'order' }),
      row('o2', ALFA, { groupId: 'g3', docType: 'order' }),
    ]
    expect(idsThatWent(rows, [result('o1', 'sent', 'g1'), result('o1', 'failed', 'g2'), result('o2', 'sent', 'g3')])).toEqual(['o2'])
    expect(idsThatWent(rows, [result('o1', 'sent', 'g1'), result('o1', 'sent', 'g2')])).toEqual(['o1'])
  })

  it('a document that was never asked for stays', () => {
    expect(idsThatWent([row('1', ALFA), row('2', BETA)], [result('1', 'sent')])).toEqual(['1'])
  })
})

describe('packing files into mails', () => {
  const MB = 1024 * 1024

  it('a file weighs what its base64 text decodes to: whole groups of three bytes', () => {
    expect([0, 1, 2, 3, 4, 6, 7].map(attachmentWeight)).toEqual([0, 3, 3, 3, 6, 6, 9])
  })

  it('by count: twelve small files are the first ten and the last two, in order', () => {
    const packing = packAttachments(Array(12).fill(1000), { maxAttachments: 10, maxBytes: 8 * MB })
    expect(packing.mails).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11]])
    expect(packing.tooLarge).toEqual([])
  })

  it('by bytes: a mail closes when the next file would not fit, and is never reordered to pack tighter', () => {
    const packing = packAttachments([3 * MB, 3 * MB, 3 * MB, 1 * MB, 6 * MB], { maxAttachments: 10, maxBytes: 8 * MB })
    expect(packing.mails).toEqual([[0, 1], [2, 3], [4]])
  })

  it('a file exactly at the cap goes alone; one over it goes nowhere, and the rest still go', () => {
    const cap = 9 * MB
    const packing = packAttachments([cap, cap + 1, 300, 600], { maxAttachments: 10, maxBytes: cap })
    expect(packing.mails).toEqual([[0], [2, 3]])
    expect(packing.tooLarge).toEqual([1])
  })

  it('no files: no mails', () => {
    expect(packAttachments([], { maxAttachments: 10, maxBytes: MB })).toEqual({ mails: [], tooLarge: [] })
  })
})

describe('the covering note', () => {
  const invoice = { invoiceNumber: 'INV-00042', issueDate: new Date('2026-11-16T00:00:00Z'), total: 120, currency: 'EUR' }

  it('one invoice reads as the single route has always worded it', () => {
    expect(buildEmailHtml({ title: 'Invoice', invoice, orgName: 'Example Ltd', message: 'Line one\nLine <two>', locale: 'en' })).toBe([
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">',
      '<p>Hello,</p>',
      '<p>Please find attached <strong>Invoice INV-00042</strong>.</p>',
      '<p>Line one<br>Line &lt;two&gt;</p>',
      '<table style="border-collapse:collapse;margin:12px 0">',
      '<tr><td style="padding:2px 12px 2px 0;color:#666">Date</td><td>2026-11-16</td></tr>',
      '<tr><td style="padding:2px 12px 2px 0;color:#666">Total</td><td><strong>120.00 EUR</strong></td></tr>',
      '</table>',
      '<p>Kind regards,<br>Example Ltd</p>',
      '</div>',
    ].join('\n'))
  })

  it('the subject is the document, or how many there are, in the mail\'s language', () => {
    const one = [{ title: 'Фактура', number: 'INV-00042' }]
    const three = [...one, { title: 'Фактура', number: 'INV-00043' }, { title: 'Кредитно известие', number: 'INV-00044' }]
    expect(docEmailSubject({ documents: one, orgName: 'Пример ООД', locale: 'bg' })).toBe('Фактура INV-00042 — Пример ООД')
    expect(docEmailSubject({ documents: three, orgName: 'Пример ООД', locale: 'bg' })).toBe('3 документа — Пример ООД')
    expect(docEmailSubject({ documents: three, orgName: 'Example Ltd', locale: 'en' })).toBe('3 documents — Example Ltd')
    expect(docEmailSubject({ documents: three, orgName: 'Beispiel GmbH', locale: 'de-DE' })).toBe('3 Dokumente — Beispiel GmbH')
    expect(docEmailSubject({ documents: three, orgName: 'Пример ДООЕЛ', locale: 'mk' })).toBe('3 документи — Пример ДООЕЛ')
    // A language the note does not speak falls back to English, as the single route's does.
    expect(docEmailSubject({ documents: three, orgName: 'X', locale: 'fr' })).toBe('3 documents — X')
    expect(docEmailSubject({ documents: one, orgName: 'N'.repeat(300) }).length).toBe(200)
  })

  it('several documents are a short list of type, number, date and total, above the person\'s message', () => {
    const html = docEmailHtml({
      documents: [
        { title: 'Invoice', number: 'INV-00042', date: '2026-11-16T10:00:00Z', total: '120.00 EUR' },
        { title: 'Purchase Order', number: 'ORDO-00007', date: null },
      ],
      orgName: 'Example <Ltd>',
      message: 'See you & thanks',
      locale: 'en',
    })
    expect(html).toContain('<p>Please find attached 2 documents:</p>')
    expect(html).toContain('<strong>INV-00042</strong>')
    expect(html).toContain('2026-11-16')
    expect(html).toContain('120.00 EUR')
    expect(html).toContain('<strong>ORDO-00007</strong>')
    expect(html).toContain('<p>See you &amp; thanks</p>')
    expect(html).toContain('Example &lt;Ltd&gt;')
    // The list comes first, the message under it.
    expect(html.indexOf('ORDO-00007')).toBeLessThan(html.indexOf('See you'))
  })

  it('one document that is no invoice is a sentence, and states no total it does not have', () => {
    const html = docEmailHtml({ documents: [{ title: 'Поръчка за доставка', number: 'ORDO-00007', date: '2026-11-16' }], orgName: 'Пример ООД', locale: 'bg' })
    expect(html).toContain('<p>Прикачено ще намерите <strong>Поръчка за доставка ORDO-00007</strong>.</p>')
    expect(html).toContain('2026-11-16')
    expect(html).not.toContain('Общо')
  })
})
