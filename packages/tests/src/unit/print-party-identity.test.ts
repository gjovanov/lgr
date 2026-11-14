import { describe, it, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { buildCompanionHtml, type CompanionDocData } from 'reporting/pdf/companion-doc.pdf'
import { generateCompanionDocXLSX } from 'reporting/excel/companion-doc.excel'

/**
 * FR-25a §3.5 / §3.7: what a printed document says of its two parties beyond their names and numbers, the МОЛ
 * (`Org.representative`, `Contact.representative`) and the place of issue (`Org.placeOfIssue`, the fallback of the
 * document's own `placeOfTransaction`).
 *
 * ⚠ Printed documents are legal paperwork. A document whose org and contact set none of these must print EXACTLY as
 * before, byte for byte. The hashes in `BEFORE` were taken from the renderers before FR-25a touched them, over a
 * matrix of the documents they print (a sales invoice and its copy, a bill, a note, a draft proforma, a cash sale,
 * both companions, in all four languages between them). A deliberate change to one of these forms updates its hash
 * here, in the same commit: the failure prints the new one.
 *
 * Fake data only.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const ORG = {
  name: 'ПРИМЕР ТЕСТ ООД',
  taxNumber: '000000017',
  vatNumber: 'BG000000017',
  phone: '+359 000 000 000',
  website: 'example.test',
  logo: 'data:image/png;base64,AAAA',
  addresses: [{ type: 'billing', street: 'ул. Тестова 1', city: 'Тестоград', postalCode: '1000', country: 'BG', isDefault: true }],
  bankDetails: [{ bankName: 'Тестова банка', iban: 'BG00TEST00000000000000', swift: 'TESTBGSF', currency: 'EUR', isDefault: true }],
}

const CONTACT = {
  companyName: 'КЛИЕНТ ПРОБА ЕООД',
  taxId: '000000025',
  vatNumber: 'BG000000025',
  addresses: [{ type: 'billing', street: 'бул. Пробен 2', city: 'Пробоград', country: 'BG', isDefault: true }],
}

const LINES = [
  { description: 'Болт тестов М8', quantity: 10, unit: 'pcs', unitPrice: 1.5, taxRate: 20, lineTotal: 15 },
  { description: 'Шайба проба', quantity: 2.5, unit: 'kg', unitPrice: 4, discount: 1, taxRate: 20, lineTotal: 9 },
]

const BASE = {
  invoiceNumber: 'INV-2026-00001',
  issueDate: new Date('2026-03-21T10:00:00Z'),
  currency: 'EUR',
  subtotal: 24,
  taxTotal: 4.8,
  total: 28.8,
  lines: LINES,
  paymentMethod: 'bank_transfer',
  preparedBy: 'Оператор Тест',
  notes: 'Словом : двадесет и осем евро и 80 цента, Данъчна основа 24.00 €\nДоставка до обекта',
}

/** The documents the invoice form prints, each with the locale it is printed in. */
const INVOICES: Record<string, { invoice: Record<string, unknown>; locale: string }> = {
  'sales invoice, with its place (bg)': { invoice: { type: 'invoice', direction: 'outgoing', status: 'sent', placeOfTransaction: 'Тестоград' }, locale: 'bg' },
  'sales invoice, no place (en)': { invoice: { type: 'invoice', direction: 'outgoing', status: 'paid' }, locale: 'en' },
  'bill (bg)': { invoice: { type: 'invoice', direction: 'incoming', status: 'received', invoiceNumber: 'BILL-2026-00003' }, locale: 'bg' },
  'credit note (de)': {
    invoice: { type: 'credit_note', direction: 'outgoing', status: 'sent', invoiceNumber: 'CN-2026-00002', placeOfTransaction: 'Пробоград', relatedInvoiceRef: { number: 'INV-2026-00001', issueDate: new Date('2026-03-01T10:00:00Z') } },
    locale: 'de',
  },
  'draft proforma (mk)': { invoice: { type: 'proforma', direction: 'outgoing', status: 'draft', invoiceNumber: 'DRF-PRF-2026-00004' }, locale: 'mk' },
  'cash sale (bg)': { invoice: { type: 'cash_sale', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-2026-00005', paymentMethod: 'cash', register: { unp: 'TS000001-0001-0000001' } }, locale: 'bg' },
}

function invoiceHtml(name: string, org: Record<string, unknown> = ORG, contact: Record<string, unknown> = CONTACT, invoice: Record<string, unknown> = {}) {
  const fx = INVOICES[name]
  const out = buildInvoiceHtml({ ...BASE, ...fx.invoice, ...invoice } as any, org as any, contact as any, undefined, {
    locale: fx.locale,
    footerText: 'тел.: +359 000 000 000   example.test',
  })
  return `${out.css}\n${out.html}`
}

function companion(kind: CompanionDocData['kind'], locale: string, parties: { recipient?: object; supplier?: object } = {}): CompanionDocData {
  return {
    kind,
    number: kind === 'certificate' ? 'CERT-2026-00007' : 'PPP-2026-00011',
    date: new Date('2026-08-07T10:00:00Z'),
    recipient: { name: 'КЛИЕНТ ПРОБА ЕООД', city: 'Пробоград', address: 'бул. Пробен 2', taxId: '000000025', ...parties.recipient },
    supplier: { name: 'ПРИМЕР ТЕСТ ООД', city: 'Тестоград', address: 'ул. Тестова 1', taxId: '000000017', ...parties.supplier },
    lines: [{ name: 'Болт тестов М8', unit: 'pcs', quantity: 10 }, { name: 'Шайба проба', unit: 'kg', quantity: 2.5, note: 'серт. 1' }],
    sourceDocs: [{ label: 'Фактура', number: 'INV-2026-00001', date: new Date('2026-08-07T10:00:00Z') }],
    additionalInfo: 'Доставка до обекта',
    preparedBy: 'Оператор Тест, 1111',
    logo: 'data:image/png;base64,AAAA',
    footerText: 'тел.: +359 000 000 000   example.test',
    locale,
  }
}

const COMPANIONS: Record<string, [CompanionDocData['kind'], string]> = {
  'certificate (bg)': ['certificate', 'bg'],
  'handover protocol (en)': ['ppprotocol', 'en'],
}

function companionHtml(name: string, parties?: { recipient?: object; supplier?: object }) {
  const [kind, locale] = COMPANIONS[name]
  const out = buildCompanionHtml(companion(kind, locale, parties))
  return `${out.css}\n${out.html}`
}

/** The worksheet's cells as text: the file itself carries its creation time. */
async function companionSheet(name: string, parties?: { recipient?: object; supplier?: object }) {
  const [kind, locale] = COMPANIONS[name]
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await generateCompanionDocXLSX(companion(kind, locale, parties)) as any)
  const rows: string[] = []
  wb.worksheets[0].eachRow({ includeEmpty: true }, (row, n) => {
    rows.push(`${n}: ${JSON.stringify((row.values as any[]).slice(1))}`)
  })
  return rows.join('\n')
}

/** Taken from the renderers at f846390d, before FR-25a (the same under any time zone: every date is at 10:00 UTC). */
const BEFORE: Record<string, string> = {
  'invoice: sales invoice, with its place (bg)': 'ec49551d3166df080942615f324e04ea6b1f58101a980523a4479e8512e37153',
  'invoice: sales invoice, no place (en)': '92549c5aafa3d62d21d886501f36862a4a50317c412c096eb8aed5c7b16063f2',
  'invoice: bill (bg)': '99d74a3aefcbd375f592a448be2dd464b1eaafc8a09704bf7373d2771d5ac4f8',
  'invoice: credit note (de)': 'c9f5673449a013184030a80780238cd1c65065a5526b54e8996880db8de481cf',
  'invoice: draft proforma (mk)': '5f7d3ea7602050e8c2fed652c441e7e7e13b026a2ae9448e3deb007a8aef97c5',
  'invoice: cash sale (bg)': '9f57f059092743401a278ab9a6156ad5ebba6754310ee2ef4974177ed017c937',
  'companion: certificate (bg)': 'fe77da939126a88a0e55fe60eb43c35764ee727050e87990e27a1f9c0b376413',
  'sheet: certificate (bg)': 'd51cf1b8fa0e7416406ee488150af298b7d8fea6d63b617e9476d04134bb7cdb',
  'companion: handover protocol (en)': '073f57cd55f4268ad5523cf972b2f6725589dccd0fae0ebe599bd6f6065723c1',
  'sheet: handover protocol (en)': '699fb60609388606190d75f8b33ce85594f0565b5ae67bd4619288eaa4fe3b07',
}

describe('a document that names no МОЛ and no place of issue prints exactly as before FR-25a', () => {
  for (const name of Object.keys(INVOICES)) {
    it(`the invoice form: ${name}`, () => {
      expect(sha(invoiceHtml(name))).toBe(BEFORE[`invoice: ${name}`])
    })
  }
  for (const name of Object.keys(COMPANIONS)) {
    it(`the companion form: ${name}`, () => {
      expect(sha(companionHtml(name))).toBe(BEFORE[`companion: ${name}`])
    })
    it(`the companion worksheet: ${name}`, async () => {
      expect(sha(await companionSheet(name))).toBe(BEFORE[`sheet: ${name}`])
    })
  }
})

describe('…and so does one whose fields are there but say nothing', () => {
  // A cleared field, whitespace, and the activity code, which no document prints.
  const org = { ...ORG, representative: '  ', placeOfIssue: '', activityCode: '47.52' }
  const contact = { ...CONTACT, representative: '' }

  for (const name of Object.keys(INVOICES)) {
    it(`the invoice form: ${name}`, () => {
      expect(sha(invoiceHtml(name, org, contact))).toBe(BEFORE[`invoice: ${name}`])
    })
  }
  for (const name of Object.keys(COMPANIONS)) {
    const blank = { recipient: { representative: '' }, supplier: { representative: ' ' } }
    it(`the companion form and its worksheet: ${name}`, async () => {
      expect(sha(companionHtml(name, blank))).toBe(BEFORE[`companion: ${name}`])
      expect(sha(await companionSheet(name, blank))).toBe(BEFORE[`sheet: ${name}`])
    })
  }
})

/** A party row of the parties table, as the form flattens it: the recipient's half, then the supplier's. */
const partyRow = (key: string, left: string, right: string) =>
  `<td class="k">${key}</td><td class="v">${left}</td>\n<td class="gap"></td>\n<td class="k">${key}</td><td class="v">${right}</td>`

describe('the place of issue: the document\'s own place wins, the company\'s stands in for none', () => {
  it('a document with no place prints the company\'s', () => {
    const html = invoiceHtml('sales invoice, no place (en)', { ...ORG, placeOfIssue: '  Testville ' })
    expect(html).toContain('<td>Place of transaction: Testville</td>')
  })

  it('a document with a place prints its own, never the company\'s', () => {
    const html = invoiceHtml('sales invoice, with its place (bg)', { ...ORG, placeOfIssue: 'Другоград' })
    expect(html).toContain('<td>Място на сделката: Тестоград</td>')
    expect(html).not.toContain('Другоград')
    expect(invoiceHtml('credit note (de)', { ...ORG, placeOfIssue: 'Anderswo' })).not.toContain('Anderswo')
  })

  it('a bill is its supplier\'s document: the company\'s place never stands in for where the supplier issued it', () => {
    expect(invoiceHtml('bill (bg)', { ...ORG, placeOfIssue: 'Тестоград' })).not.toContain('Място на сделката')
    expect(invoiceHtml('bill (bg)', { ...ORG, placeOfIssue: 'Тестоград' }, CONTACT, { placeOfTransaction: 'Пробоград' }))
      .toContain('<td>Място на сделката: Пробоград</td>')
  })

  it('a document whose place is blank takes the company\'s; neither prints nothing', () => {
    expect(invoiceHtml('cash sale (bg)', { ...ORG, placeOfIssue: 'Тестоград' }, CONTACT, { placeOfTransaction: '   ' }))
      .toContain('<td>Място на сделката: Тестоград</td>')
    expect(invoiceHtml('cash sale (bg)')).not.toContain('Място на сделката')
  })
})

describe('the МОЛ closes each party\'s block', () => {
  const org = { ...ORG, representative: ' Лице Издател ' }
  const contact = { ...CONTACT, representative: 'Лице Клиент' }

  it('on a sales document the company is the supplier, on the right, and the customer on the left: in both copies', () => {
    const html = invoiceHtml('sales invoice, with its place (bg)', org, contact)
    const row = partyRow('МОЛ', 'Лице Клиент', 'Лице Издател')
    expect(html.split(row).length - 1).toBe(2)
    // after the VAT number, the last row of the block
    expect(html.indexOf(row)).toBeGreaterThan(html.indexOf('<td class="k">ИН по ДДС</td>'))
    expect(html.indexOf(row)).toBeLessThan(html.indexOf('<table class="lines">'))
  })

  it('on a bill the company is the recipient, on the left', () => {
    expect(invoiceHtml('bill (bg)', org, contact)).toContain(partyRow('МОЛ', 'Лице Издател', 'Лице Клиент'))
  })

  it('a party with none leaves its half empty', () => {
    expect(invoiceHtml('sales invoice, no place (en)', org)).toContain(partyRow('Representative', '', 'Лице Издател'))
    expect(invoiceHtml('credit note (de)', ORG, contact)).toContain(partyRow('Vertreter', 'Лице Клиент', ''))
    expect(invoiceHtml('draft proforma (mk)', org)).toContain(partyRow('Застапник', '', 'Лице Издател'))
  })

  it('is printed as text, never as markup', () => {
    expect(invoiceHtml('bill (bg)', { ...ORG, representative: 'Лице <b>&</b>' })).toContain('Лице &lt;b&gt;&amp;&lt;/b&gt;')
  })

  it('on both companion forms and their worksheets', async () => {
    const parties = { recipient: { representative: 'Лице Клиент' }, supplier: { representative: 'Лице Издател' } }
    expect(companionHtml('certificate (bg)', parties)).toContain(partyRow('МОЛ', 'Лице Клиент', 'Лице Издател'))
    expect(companionHtml('handover protocol (en)', { supplier: { representative: 'Лице Издател' } }))
      .toContain(partyRow('Representative', '', 'Лице Издател'))
    const sheet = await companionSheet('certificate (bg)', parties)
    // right under the tax numbers, the parties' last row
    expect(sheet).toContain([
      '9: ["ЕИК","000000025",null,"ЕИК","000000017"]',
      '10: ["МОЛ","Лице Клиент",null,"МОЛ","Лице Издател"]',
      '11: []',
    ].join('\n'))
  })
})
