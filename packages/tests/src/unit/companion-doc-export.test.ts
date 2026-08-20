import { describe, it, expect } from 'bun:test'
import ExcelJS from 'exceljs'
import { generateCompanionDocXLSX } from 'reporting/excel/companion-doc.excel'
import { buildCompanionHtml, type CompanionDocData } from 'reporting/pdf/companion-doc.pdf'
import { companionDocI18n, sourceDocLabel } from 'reporting/companion-doc.i18n'
import { invoiceDocI18n, invoiceDocTitle, AMOUNT_IN_WORDS_RE } from 'reporting/invoice-doc.i18n'

function fixture(kind: CompanionDocData['kind']): CompanionDocData {
  return {
    kind,
    number: kind === 'certificate' ? 'CERT-2026-00007' : 'PPP-2026-00011',
    date: new Date('2026-08-07'),
    recipient: { name: 'СОЛИТЕХ АД', city: 'СОФИЯ', address: 'БУЛ.ГОЦЕ ДЕЛЧЕВ 55', taxId: '200610482' },
    supplier: { name: 'РЕГАЛ ООД', city: 'ПАЗАРДЖИК', address: 'ПЛОВДИВСКА 110', taxId: '112500982' },
    lines: [
      { name: 'БОЛТ М10Х30 - DIN 933 - K 8.8 - ZN', unit: 'БР', quantity: 15 },
      { name: 'ВИНТ 6Х160 - ТХ - EVOLUTION', unit: 'БР', quantity: 300 },
      { name: '1019 ТЕКСТИЛНА ЛЕНТА - ЧЕРНА', unit: 'БР', quantity: 2 },
    ],
    sourceDocs: [{ label: 'Фактура', number: 'INV-2026-00042', date: new Date('2026-08-07') }],
    preparedBy: 'Николета Тачева, 1111',
    locale: 'bg',
  }
}

async function readSheet(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const ws = wb.worksheets[0]
  const rows: string[] = []
  ws.eachRow(row => {
    rows.push((row.values as any[]).slice(1).map(v => (v == null ? '' : String(v))).join(' | '))
  })
  return { ws, rows, text: rows.join('\n') }
}

describe('Companion document export', () => {
  it('renders the declaration of conformity with its own number and no quantity total', async () => {
    const buffer = await generateCompanionDocXLSX(fixture('certificate'))
    const { text } = await readSheet(buffer)

    expect(text).toContain('ДЕКЛАРАЦИЯ ЗА СЪОТВЕТСТВИЕ')
    expect(text).toContain('CERT-2026-00007')
    expect(text).toContain('07.08.2026')
    // Both parties, each with their own EIK.
    expect(text).toContain('СОЛИТЕХ АД')
    expect(text).toContain('РЕГАЛ ООД')
    expect(text).toContain('200610482')
    expect(text).toContain('112500982')
    // Certificate column, not the protocol's remark column.
    expect(text).toContain('Сертификат')
    expect(text).not.toContain('Забележка')
    // Both companion kinds close on the total quantity — 15 + 300 + 2 — under a plain label.
    expect(text).toContain('Общо:')
    expect(text).toContain('317')
    expect(text).not.toContain('Общо количество')
    // Signed by its author only — no counter-signature block.
    expect(text).toContain('Съставил')
    expect(text).not.toContain('Приел')
  })

  it('renders the handover protocol with a quantity total and both signature lines', async () => {
    const buffer = await generateCompanionDocXLSX(fixture('ppprotocol'))
    const { text } = await readSheet(buffer)

    expect(text).toContain('ПРИЕМО - ПРЕДАВАТЕЛЕН ПРОТОКОЛ')
    expect(text).toContain('PPP-2026-00011')
    expect(text).toContain('Забележка')
    expect(text).not.toContain('Сертификат')
    // 15 + 300 + 2, under the shortened label.
    expect(text).toContain('Общо:')
    expect(text).toContain('317')
    expect(text).not.toContain('Общо количество')
    expect(text).toContain('Приел')
    expect(text).toContain('Съставил')
  })

  it('carries every invoice line through in order', async () => {
    const data = fixture('ppprotocol')
    const buffer = await generateCompanionDocXLSX(data)
    const { text } = await readSheet(buffer)

    for (const line of data.lines) expect(text).toContain(line.name)
    const positions = data.lines.map(l => text.indexOf(l.name))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('references the source document so the protocol is traceable to its invoice', async () => {
    const buffer = await generateCompanionDocXLSX(fixture('certificate'))
    const { text } = await readSheet(buffer)

    expect(text).toContain('Списък с документи, по които е издаден протоколът:')
    expect(text).toContain('-Фактура № INV-2026-00042 от 07.08.2026')
  })

  it('lays the worksheet out as the printed form does: centred title, shaded party bands, boxed total', async () => {
    const buffer = await generateCompanionDocXLSX(fixture('ppprotocol'))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as any)
    const ws = wb.worksheets[0]
    const merges: string[] = (ws as any).model.merges

    // Title centred over the full table width.
    expect(merges).toContain('A1:E1')
    expect(ws.getCell('A1').alignment?.horizontal).toBe('center')
    // The party names sit on their own shaded band, recipient left, supplier right.
    const band = ws.getRow(6)
    expect(band.getCell(1).value).toBe('Получател')
    expect(band.getCell(4).value).toBe('Доставчик')
    expect((band.getCell(1).fill as any)?.fgColor?.argb).toBeDefined()
    expect(band.getCell(1).font?.bold).toBe(true)
    // Grid stays on so the cells around the document still read as a grid.
    expect(ws.views?.[0]?.showGridLines).toBe(true)
  })

  it('boxes the total quantity under the table on both kinds, and omits it when there are no lines', () => {
    // The certificate prints whole quantities, the protocol three decimals — as their own
    // quantity columns do.
    const cert = buildCompanionHtml(fixture('certificate')).html
    expect(cert).toContain('<div class="totals-box">')
    expect(cert).toContain('Общо:')
    expect(cert).toContain('>317<')

    const protocol = buildCompanionHtml(fixture('ppprotocol')).html
    expect(protocol).toContain('<div class="totals-box">')
    expect(protocol).toContain('>317.000<')

    // These documents state what was delivered, never what it cost.
    for (const html of [cert, protocol]) {
      expect(html).not.toContain('Общо количество')
      expect(html).not.toContain('€')
    }

    expect(buildCompanionHtml({ ...fixture('ppprotocol'), lines: [] }).html).not.toContain('totals-box')
  })

  it('prints the letterhead logo above the title, as the invoice form does', () => {
    // Own logo (a data URI Chromium can render) wins…
    const own = buildCompanionHtml({ ...fixture('certificate'), logo: 'data:image/png;base64,AAAA' }).html
    expect(own).toContain('<div class="logo-bar"><img class="org-logo" src="data:image/png;base64,AAAA"')
    expect(own.indexOf('org-logo')).toBeLessThan(own.indexOf('doc-title'))

    // …and an org without one still gets the bundled asset, on both companion kinds.
    for (const kind of ['certificate', 'ppprotocol'] as const) {
      const html = buildCompanionHtml(fixture(kind)).html
      expect(html).toContain('<div class="logo-bar"><img class="org-logo" src="data:image/png;base64,')
    }
  })

  it('falls back to English for an unknown locale and localises the source-document label', () => {
    expect(companionDocI18n('bg').title.certificate).toBe('ДЕКЛАРАЦИЯ ЗА СЪОТВЕТСТВИЕ')
    expect(companionDocI18n('fr').title.certificate).toBe('DECLARATION OF CONFORMITY')
    expect(companionDocI18n('bg-BG').label.taxId).toBe('ЕИК')

    expect(sourceDocLabel('credit_note', 'bg')).toBe('Кредитно известие')
    expect(sourceDocLabel('cash_sale', 'en')).toBe('Cash Sale')
    // Unknown document types still print a sensible reference line.
    expect(sourceDocLabel('something_else', 'en')).toBe('Invoice')
  })
})

describe('Invoice document strings', () => {
  it('titles each document type, resolving an incoming invoice to the purchase wording', () => {
    expect(invoiceDocTitle('invoice', 'outgoing', 'bg')).toBe('ФАКТУРА')
    expect(invoiceDocTitle('invoice', 'incoming', 'bg')).toBe('ФАКТУРА')
    expect(invoiceDocTitle('invoice', 'incoming', 'en')).toBe('PURCHASE INVOICE')
    expect(invoiceDocTitle('proforma', 'outgoing', 'bg')).toBe('ПРОФОРМА ФАКТУРА')
    expect(invoiceDocTitle('credit_note', 'outgoing', 'bg')).toBe('КРЕДИТНО ИЗВЕСТИЕ')
    expect(invoiceDocTitle('debit_note', 'outgoing', 'bg')).toBe('ДЕБИТНО ИЗВЕСТИЕ')
    expect(invoiceDocTitle('cash_sale', 'outgoing', 'bg')).toBe('КАСОВА ПРОДАЖБА')
    // Unknown type still yields a printable title rather than blank.
    expect(invoiceDocTitle('mystery', 'outgoing', 'en')).toBe('INVOICE')
  })

  it('carries the statutory Bulgarian notices and falls back to English elsewhere', () => {
    const bg = invoiceDocI18n('bg')
    expect(bg.notice.gdpr).toContain('чл. 114, ал. 1, т. 7 и т. 8 от ЗДДС')
    expect(bg.notice.stamp).toContain('чл.6, ал.1 от ЗСч.')
    expect(bg.label.vatId).toBe('ИН по ДДС')
    expect(bg.paymentMethod.bank_transfer).toBe('По сметка')

    expect(invoiceDocI18n('fr').label.recipient).toBe('RECIPIENT')
    expect(invoiceDocI18n('bg-BG').label.recipient).toBe('ПОЛУЧАТЕЛ')
  })

  it('recognises the amount-in-words line in every locale it is written in', () => {
    expect(AMOUNT_IN_WORDS_RE.test('Словом : двадесет и три евро и 2 цента')).toBe(true)
    expect(AMOUNT_IN_WORDS_RE.test('In words: twenty three euro')).toBe(true)
    expect(AMOUNT_IN_WORDS_RE.test('In Worten : dreiundzwanzig Euro')).toBe(true)
    expect(AMOUNT_IN_WORDS_RE.test('Со зборови : дваесет и три')).toBe(true)
    // A user's own note must not be mistaken for the generated line.
    expect(AMOUNT_IN_WORDS_RE.test('Доставка до склад 2')).toBe(false)
  })
})
