import { describe, it, expect } from 'bun:test'
import { gzipSync } from 'node:zlib'
import {
  analyticItems,
  analyticNodes,
  analyticOpenings,
  analyticsFileRows,
  archiveNumber,
  chartOfYear,
  encodeRecords,
  journalFromRecords,
  journalOfYear,
  readArchiveBooks,
  walkDump,
  type RawRecord,
} from 'services/biz/accounting-books/plusminus-archive'
import { assertWholeJournal } from 'services/biz/accounting-books/plusminus-exports'
import { personnelOfArchive, readArchivePayroll, sheetsOfArchive } from '../../../../scripts/lib/payroll-archive'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'

// A made-up company, in the archive's layout (field names are PlusMinus's own). Every name and number here is invented.
type R = { depth: number; text?: string; float?: number }
const t = (depth: number, text: string): R => ({ depth, text })
const f = (depth: number, float: number): R => ({ depth, float })
const field = (depth: number, name: string, value: string | number): R[] => [t(depth, name), typeof value === 'number' ? f(depth + 1, value) : t(depth + 1, value)]

function company(name: string, withOps = true): R[] {
  return [
    t(1, name),
    ...(withOps ? [
      t(2, 'ОПЕРАЦИИ'),
      t(3, '20251231'),
      t(4, '00000001'), ...field(5, 'ДОКУМЕНТ', '+ФЕ'), ...field(5, 'ДОКУМ.No', '77'), ...field(5, 'СУМА', 120), ...field(5, 'ТЕКСТ', 'Стоки'), ...field(5, 'ТИП', '1'),
      t(4, '00000002'), ...field(5, 'АНАЛДЕБ', 'СТОКИ:ВИНТОВЕ:ВИНТ'), ...field(5, 'АНАЛКРЕ', 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД'), ...field(5, 'ДЕБИТ', '304'),
        ...field(5, 'ДОКУМ.No', '77'), ...field(5, 'ДОКУМЕНТ', '+ФЕ'), ...field(5, 'КОЛИЧЕСТВО', '10'), ...field(5, 'КРЕДИТ', '401'), ...field(5, 'СУМА', '100.00'),
      t(4, '00000003'), ...field(5, 'АНАЛКРЕ', 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД'), ...field(5, 'ДАНЪК', '100331'), ...field(5, 'ДЕБИТ', '4531'),
        ...field(5, 'ДОКУМ.No', '77'), ...field(5, 'ДОКУМЕНТ', '+ФЕ'), ...field(5, 'КРЕДИТ', '401'), ...field(5, 'СУМА', '20.00'),
      // an operation of no document (monthly depreciation): a document of its own; full precision and a NaN rate, as stored
      t(4, '00000004'), ...field(5, 'ДЕБИТ', '603'), ...field(5, 'КРЕДИТ', '241'), ...field(5, 'КУРС', 'NaN'), ...field(5, 'СУМА', '336.53996301411456'),
      // an operation whose document's header is gone (PlusMinus lost it), in a foreign currency with float noise
      t(4, '00000005'), ...field(5, 'ВАЛУТА', 'EUR'), ...field(5, 'ДЕБИТ', '401'), ...field(5, 'ДОКУМ.No', '9'), ...field(5, 'ДОКУМЕНТ', '+ББ'),
        ...field(5, 'КРЕДИТ', '503'), ...field(5, 'КУРС', '1.95583'), ...field(5, 'СУМА', '1'), ...field(5, 'СУМАВАЛ', '0.5112999999999999'),
      t(3, '20260105'),
      t(4, '00000001'), ...field(5, 'ДОКУМЕНТ', '-ФЕ'), ...field(5, 'ДОКУМ.No', '3000000001'), ...field(5, 'СУМА', 60), ...field(5, 'ТИП', '1'),
      t(4, '00000002'), ...field(5, 'АНАЛДЕБ', 'КЛИЕНТИ:КЛИЕНТ ООД'), ...field(5, 'ДЕБИТ', '411'), ...field(5, 'ДОКУМ.No', '3000000001'),
        ...field(5, 'ДОКУМЕНТ', '-ФЕ'), ...field(5, 'КРЕДИТ', '702'), ...field(5, 'СУМА', '60.00'),
    ] : []),
    t(2, 'ПАРАМЕТРИ'), ...field(3, 'Булстат', '999999999'),
    t(2, 'СМЕТКОПЛАН'),
    t(3, 'АНАЛИТИЧНИ ПРИЗНАЦИ'),
    t(4, 'БАНКОВИ СМЕТКИ'), t(5, 'BG00TEST00000000000000'), ...field(6, 'createdBy', 'Администратор'), t(6, 'ВАЛУТИ'), t(7, 'EUR'), ...field(8, 'КУРС', 1.95583),
    t(4, 'ДОСТАВЧИЦИ'), ...field(5, 'createdBy', 'Администратор'),
    t(5, 'ДОСТАВЧИК ЕООД'), t(6, 'ОПЕРАЦИИ'), t(7, 'КРЕДИТ'), t(6, 'ПАРАМЕТРИ'), ...field(7, 'БУЛСТАТ', '123456789'), ...field(7, 'ИНДДС', 'BG123456789'),
      t(6, 'САЛДА И ОБОРОТИ'), t(7, 'НАЧАЛНИ'), t(8, '2026'), t(9, 'НАЧАЛНО САЛДО'), ...field(10, 'КРЕДИТ', '50'),
    t(4, 'ПЕРСОНАЛ'), t(5, 'ИЗМИСЛЕН СЛУЖИТЕЛ'), t(6, 'ПАРАМЕТРИ'), ...field(7, 'ЕГН', '0000000000'),
    t(4, 'СТОКИ'), t(5, 'ВИНТОВЕ'), ...field(6, 'createdOn', '20250101:000000'),
      t(6, 'ВИНТ'), t(7, 'ПАРАМЕТРИ'), ...field(8, 'МЯРКА', 'БР'),
        t(7, 'САЛДА И ОБОРОТИ'), t(8, 'НАЧАЛНИ'), t(9, '2026'), ...field(10, 'КОЛИЧЕСТВО', '5'), t(10, 'НАЧАЛНО САЛДО'), ...field(11, 'ДЕБИТ', '12.5'),
    t(3, 'СМЕТКИ'),
    t(4, '304'), t(5, 'АНАЛИТ'), t(6, 'ПЕРСОНАЛ'), t(7, 'ИЗМИСЛЕН СЛУЖИТЕЛ'), ...field(5, 'ИМЕ', 'Стоки'), t(5, 'ОПЕРАЦИИ'), t(6, '20251231'),
      t(5, 'САЛДА И ОБОРОТИ'), t(6, 'НАЧАЛНИ'), t(7, '2026'), t(8, 'НАЧАЛНО САЛДО'), ...field(9, 'ДЕБИТ', 1000.0000000000002),
    t(4, '503 '),
    t(2, 'ТРЗ'),
    t(3, 'ОТДЕЛИ'), t(4, 'СКЛАД'),
    t(3, 'ПЕРСОНАЛ'),
    t(4, 'Пробен Тестов Измислен'),
      t(5, 'ЗАПЛАТИ'), t(6, '202601'), t(7, 'ДНИ'), ...field(8, '101', '21'), t(7, 'СУМИ'), ...field(8, '101', '1000'), ...field(8, 'ФРЗ', '1000'),
      t(5, 'ОТСЪСТВИЯ'), t(6, '202601'), t(7, '00000001'), ...field(8, 'КОМЕНТАР', 'болничен'), ...field(8, 'СУМА', '10'),
      t(5, 'ПАРАМЕТРИ'), ...field(6, 'ЕГН', '0000000001'), ...field(6, 'ИМЕ', 'Пробен Тестов Измислен'), ...field(6, 'ОСИГСТАЖ', '050102'),
        ...field(6, 'ОСНЗАПЛ', '1000'), ...field(6, 'ПОСТЪПИЛ', '20250101'), ...field(6, 'ТДНКИД', '4752'),
  ]
}
const dump = (records: R[]) => gzipSync(encodeRecords(records))
const archive = dump([t(0, 'LPVList'), t(1, 'Settings'), t(0, 'ПРАВА НА ДОСТЪП'), t(1, 'ПОТРЕБИТЕЛИ'), t(0, 'ФИРМИ'), ...company('ТЕСТ ООД')])

describe('the dump', () => {
  it('reads every record back, and refuses a stream that does not end on a whole record', async () => {
    const out: string[] = []
    const res = await walkDump(gzipSync(encodeRecords([t(0, 'А'), f(1, 1.5), t(1, 'Б')])), r => out.push(`${r.depth}:${r.tag}`))
    expect(res.records).toBe(3)
    expect(out).toEqual(['0:17', '1:40', '1:17'])
    const torn = Buffer.concat([encodeRecords([t(0, 'А')]), Buffer.from([0x11, 0, 9, 0, 0, 0, 1])])
    expectRejection(await captureRejection(walkDump(gzipSync(torn), () => {})), /after the last whole record/)
  })

  it('prints a number as the export does: 10 decimals, NaN blank', () => {
    expect(archiveNumber('336.53996301411456')).toBe(336.5399630141)
    expect(archiveNumber(837.5699999999999)).toBe(837.57)
    expect(archiveNumber('NaN')).toBeUndefined()
    expect(archiveNumber(' ')).toBeUndefined()
  })
})

describe('the books', () => {
  it('reads one company: its ЕИК, operations in range, chart and analytics, and never the employees', async () => {
    const b = await readArchiveBooks(archive, '20250101', '20261231')
    expect(b.company).toBe('ТЕСТ ООД')
    expect(b.eik).toBe('999999999')
    expect(b.records.length).toBe(7)
    expect(b.span).toEqual({ first: '20251231', last: '20260105' })
    expect(b.accounts!.kids.map(k => k.name)).toEqual(['304', '503 '])
    const everywhere = JSON.stringify([b.accounts, b.analytics])
    expect(everywhere).not.toContain('ИЗМИСЛЕН СЛУЖИТЕЛ') // neither the ПЕРСОНАЛ root nor an account's АНАЛИТ index is read
    expect(everywhere).not.toContain('АНАЛИТ"')
  })

  it('refuses a dump of two companies', async () => {
    const two = dump([t(0, 'ФИРМИ'), ...company('ЕДНО ООД'), ...company('ДРУГО ООД')])
    expectRejection(await captureRejection(readArchiveBooks(two, '20250101', '20261231')), /2 companies/)
  })

  it('groups the journal exactly as the export parser does', async () => {
    const b = await readArchiveBooks(archive, '20251231', '20251231')
    const j = journalFromRecords(b.records)
    expect(j.counts).toEqual({ documents: 1, operations: 4 })
    expect(j.documents[0]).toEqual({
      date: '2025-12-31', docType: '+ФЕ', docNumber: '77', vatKind: '1', total: 120, comment: 'Стоки',
      ops: [
        { d: '304', k: '401', amount: 100, ad: 'СТОКИ:ВИНТОВЕ:ВИНТ', ak: 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД', qty: 10 },
        { d: '4531', k: '401', amount: 20, ak: 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД', tax: '100331' },
      ],
    })
    expect(j.documents[1]).toEqual({ date: '2025-12-31', ops: [{ d: '603', k: '241', amount: 336.5399630141 }] })
    expect(j.documents[2]).toEqual({ date: '2025-12-31', docType: '+ББ', docNumber: '9', ops: [{ d: '401', k: '503', amount: 1, cur: 'EUR', rate: 1.95583, fx: 0.5113 }] })
    expect(j.withoutHeader).toEqual([{ at: 'archive 20251231\\00000005', date: '2025-12-31', docType: '+ББ', docNumber: '9' }])
  })

  describe('the rest of a document header (FR-25a)', () => {
    // Field names are PlusMinus's own; every value is invented.
    const header = (f: Record<string, string | number>): RawRecord => ({ date: '20250303', seq: '00000001', f: { 'ДОКУМЕНТ': '-ФЕ', 'ДОКУМ.No': '0000000101', 'СУМА': 120, 'ТИП': '1', ...f } })
    const op: RawRecord = { date: '20250303', seq: '00000002', f: { 'ДОКУМЕНТ': '-ФЕ', 'ДОКУМ.No': '0000000101', 'ДЕБИТ': '411', 'КРЕДИТ': '702', 'СУМА': '120', 'АНАЛДЕБ': 'КЛИЕНТИ:Клиент А' } }
    const propsOf = (f: Record<string, string | number>) => journalFromRecords([header(f), op]).documents[0].props

    it('reads each field the file states, under its own name, and leaves out what it does not', () => {
      expect(propsOf({
        'ПЛАЩАНЕ': '2', 'ВИДПЛА': '2', 'ПЛАТЕНО': '120', 'paidCash': '0', 'vatRate': '20', 'VATPER': '20', 'ВИДДОК': '3',
        'ОСНИЗВ': '-ФЕ 0000000100/01.03.2025', 'ОНС': 'чл. 0 от закона', 'МЕСЕЦ': '202504', 'ПАРТНЬОР': 'КЛИЕНТИ:Клиент А',
        'protocolType': 'p117', 'vatRules': 'ВОП', 'taxEventDate': '03.03.2025', 'НОММД': '00XX0000000000000', 'operation': 'Плащане',
        // restating the entry's own date and VAT, or the same thing twice: not read
        'docDate': '20250303', 'ДАТА1': '20250301', 'ДДС': 20, 'АВТОР': 'Оператор', 'placeOfIssue': 'гр.Тестоград',
      })).toEqual({
        paymentCode: '2', paidAmount: 120, paidCash: 0, vatRate: 20, registerDocType: '3', reasonRef: '-ФЕ 0000000100/01.03.2025',
        vatExemptionReason: 'чл. 0 от закона', reportingMonth: '202504', partnerPath: 'КЛИЕНТИ:Клиент А', protocolType: 'p117',
        vatRule: 'ВОП', taxEventDate: '2025-03-03', customsRef: '00XX0000000000000', bankOperation: 'Плащане',
      })
      // a header that says nothing more has no props at all
      expect(journalFromRecords([header({}), op]).documents[0]).not.toHaveProperty('props')
    })

    it('reads the links: each document with its date and what it settles, and drops what names none', () => {
      const links = JSON.stringify([
        { doc: '+ББ', docNumber: '901', date: '20250312', partner: 'КЛИЕНТИ:Клиент А', type: '2', param: 'paid', value: '100' },
        { doc: '-ФЕ', docNumber: '0000000100', type: '2', param: 'paid|paidCurrency', value: '20|10.23' },
        { doc: '+ББ', docNumber: '902', date: '20251399', param: '', value: '' },
        { broken: true }, 'text', null,
      ])
      expect(propsOf({ links })?.links).toEqual([
        { docType: '+ББ', docNumber: '901', date: '2025-03-12', amount: 100 },
        { docType: '-ФЕ', docNumber: '0000000100', amount: 20, amountFx: 10.23 },
        { docType: '+ББ', docNumber: '902' },
      ])
      expect(propsOf({ links: 'not json' })).toBeUndefined()
      expect(propsOf({ links: '[]' })).toBeUndefined()
    })

    it('keeps the switches that are set, and not to false, under keys that are identifiers', () => {
      const options = JSON.stringify({ exportInvoice: 'true', mixedDeal: 'false', comment: '', paidType: '2', 'bad.key': 'x', $where: 'x', nested: { a: 1 }, count: 3, off: false })
      expect(propsOf({ options })?.docOptions).toEqual({ exportInvoice: 'true', paidType: '2', count: '3' })
      expect(propsOf({ options: '{"a":"false","b":""}' })).toBeUndefined()
    })

    it('reads who keyed it and when, on the accountant\'s clock in Bulgaria, summer and winter', () => {
      expect(propsOf({ createdOn: '20250304:101530123456789', createdBy: 'Оператор', modifiedOn: '20250305:091500', modifiedBy: 'Оператор', version: '20240101' })?.source).toEqual({
        createdBy: 'Оператор', createdAt: '2025-03-04T08:15:30.123Z', modifiedBy: 'Оператор', modifiedAt: '2025-03-05T07:15:00.000Z', version: '20240101',
      })
      expect(propsOf({ createdOn: '20250704:101530' })?.source).toEqual({ createdAt: '2025-07-04T07:15:30.000Z' })
      // no stamp of either shape is no instant
      expect(propsOf({ createdOn: '1720000000000' })).toBeUndefined()
      expect(propsOf({ createdOn: '20250704:256000' })).toBeUndefined()
    })

    it('never refuses a document for a value of these that is none: it is left out', () => {
      expect(propsOf({ 'ПЛАТЕНО': 'x', taxEventDate: '31.02.2025', 'МЕСЕЦ': '202513', paidCash: 'NaN' })).toBeUndefined()
    })
  })

  it('gives each year its booked currency and a period the import can replace months over', async () => {
    const b = await readArchiveBooks(archive, '20250101', '20261231')
    const y2025 = journalOfYear(b, 2025, '2026-11-05'), y2026 = journalOfYear(b, 2026, '2026-11-05')
    expect([y2025.currency, y2025.period]).toEqual(['BGN', { from: '2025-01-01', to: '2025-12-31' }])
    expect([y2026.currency, y2026.period]).toEqual(['EUR', { from: '2026-01-01', to: '2026-11-05' }])
    expect(y2026.counts).toEqual({ documents: 1, operations: 1 })
    expect(() => assertWholeJournal(y2026)).not.toThrow() // a 3-without-header journal is the importer's to judge, not this one
  })

  it('reads the chart as „Сметкоплан" exports it: codes trimmed, the year\'s stored opening', async () => {
    const b = await readArchiveBooks(archive, '19000101', '19000101')
    expect(chartOfYear(b.accounts!, 2026)).toEqual([
      { code: '304', name: 'Стоки', openingDebit: 1000, openingCredit: 0, openingTurnoverDebit: 0, openingTurnoverCredit: 0 },
      { code: '503', name: '', openingDebit: 0, openingCredit: 0, openingTurnoverDebit: 0, openingTurnoverCredit: 0 },
    ])
  })

  it('reads the analytics as `ap_*.json` holds them, and their openings', async () => {
    const b = await readArchiveBooks(archive, '19000101', '19000101')
    const roots = analyticNodes(b.analytics!)
    expect(roots.map(r => r.root)).toEqual(['БАНКОВИ СМЕТКИ', 'ДОСТАВЧИЦИ', 'СТОКИ'])
    expect(analyticsFileRows('СТОКИ', roots[2].nodes)).toEqual([
      { ap: 'СТОКИ', params: {}, group: 'true' },
      { ap: 'СТОКИ:ВИНТОВЕ', params: {}, group: 'true' },
      { ap: 'СТОКИ:ВИНТОВЕ:ВИНТ', params: { МЯРКА: 'БР' } },
    ])
    expect(analyticItems(roots)).toEqual([
      { path: 'БАНКОВИ СМЕТКИ:BG00TEST00000000000000', foreignCurrency: true },
      { path: 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД', taxId: '123456789', vatNumber: 'BG123456789', params: [{ key: 'БУЛСТАТ', value: '123456789' }, { key: 'ИНДДС', value: 'BG123456789' }] },
      { path: 'СТОКИ:ВИНТОВЕ:ВИНТ', unit: 'БР', params: [{ key: 'МЯРКА', value: 'БР' }] },
    ])
    expect(analyticOpenings(roots[2].nodes, 2026, '304')).toEqual([{ code: '304', path: 'СТОКИ:ВИНТОВЕ:ВИНТ', debit: 12.5, credit: 0, quantity: 5 }])
    expect(analyticOpenings(roots[1].nodes, 2026, '401')).toEqual([{ code: '401', path: 'ДОСТАВЧИЦИ:ДОСТАВЧИК ЕООД', debit: 0, credit: 50 }])
    expect(analyticOpenings(roots[1].nodes, 2025, '401')).toEqual([])
  })
})

describe('the payroll', () => {
  it('reads each person, their months and absences, and the module\'s other tables', async () => {
    const p = await readArchivePayroll(archive)
    expect(p.employees.length).toBe(1)
    expect(p.employees[0].months).toEqual({ '202601': { days: { '101': 21 }, sums: { '101': 1000, 'ФРЗ': 1000 } } })
    expect(p.employees[0].absences).toEqual({ '202601': [{ id: '00000001', comment: 'болничен', sum: 10 }] })
    expect(Object.keys(p.tables)).toEqual(['ОТДЕЛИ'])
  })

  it('gives the personnel and the sheets in the GUI exports\' shapes, the sheet row with its ЕГН', async () => {
    const p = await readArchivePayroll(archive)
    expect(personnelOfArchive(p.employees, '2026-11-05')).toEqual([{
      name: 'Пробен Тестов Измислен', personId: '0000000001', asOf: '2026-11-05', startDate: '2025-01-01', endDate: undefined,
      salary: 1000, hoursPerDay: undefined, statutoryHours: undefined, daysPerWeek: undefined, classPercent: undefined,
      experience: { years: 5, months: 1, days: 2 }, kid: '4752', nkpd: undefined, position: undefined,
      socialSecurityType: undefined, healthSecurityType: undefined,
    }])
    const [sheet] = sheetsOfArchive(p.employees, '20261105')
    expect(sheet.period).toBe('202601')
    expect(sheet.rows).toEqual([{ period: '202601', name: 'Пробен Тестов Измислен', personId: '0000000001', values: { 'Заплата': 1000, 'Отр. дни': 21, 'ФРЗ': 1000 } }])
  })
})
