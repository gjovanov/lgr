import { describe, it, expect } from 'bun:test'
import {
  accountShapeOf,
  analyticRootDef,
  ancestorsOfPath,
  baseAmount,
  chartJunkReason,
  exchangeRateOf,
  ledgerCurrencyOn,
  monthsBetween,
  nameOfPath,
  rootOfPath,
  roundCents,
  settlesOf,
} from 'services/biz/accounting-books/registry'
import {
  ExportRefused,
  assertWholeJournal,
  documentsByMonth,
  parseAnalyticsFile,
  parseChartExport,
  parseJournalExport,
  parseMainBookExport,
  parseTrialBalanceExport,
  type Matrix,
} from 'services/biz/accounting-books/plusminus-exports'
import { importHashOf, planMonth, settlesOfOperation } from 'services/biz/accounting-books/journal-plan'
import {
  compareAnalyticTrialBalance,
  compareJournalAccounts,
  compareJournalAnalytics,
  compareMainBook,
  compareTrialBalance,
} from 'services/biz/accounting-books/compare'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * FR-25 §5: the exports of the accountant's PlusMinus, and what the import makes of them. The fixtures
 * are made up, in the shape of the real files. The real files are read by `scripts/`, never here.
 */

const EIK = '000000000'
const HEADER = ['Дата', 'Док.', 'Док. N', 'Дебит', 'Кредит', 'Аналитичност дебит', 'Аналитичност кредит', 'Кол.', 'Валута', 'Курс', 'Валута сума', 'Сума', 'Номер', 'Вид', 'Коментар']

/** One row of the export. A document's header has no accounts. */
const headerRow = (date: string, doc: string, no: string, sum: number, kind?: string, comment?: string) =>
  [date, doc, no, '', '', '', '', null, '', null, null, sum, '', kind ?? '', comment ?? '']
const opRow = (date: string, doc: string, no: string, d: string, k: string, ad: string, ak: string, qty: number | null, sum: number | null, comment = '') =>
  [date, doc, no, d, k, ad, ak, qty, '', null, null, sum, '', '', comment]

interface JournalShape {
  period?: string
  title?: string[]
  docs?: number
  ops?: number
  rows: unknown[][]
  closing?: { qty?: number; ops?: number; all?: number; opCount?: number }
}

function journalMatrix(j: JournalShape): Matrix {
  const ops = j.rows.filter(r => r[3]).length
  const docs = j.rows.filter(r => !r[3]).length
  const opSum = j.rows.filter(r => r[3]).reduce((s, r) => s + Number(r[11] ?? 0), 0)
  const hdrSum = j.rows.filter(r => !r[3]).reduce((s, r) => s + Number(r[11] ?? 0), 0)
  const qty = j.rows.reduce((s, r) => s + Number(r[7] ?? 0), 0)
  const closing = { qty, ops: opSum, all: opSum + hdrSum, opCount: ops, ...j.closing }
  return [
    ['Отчет по журнал на операциите'],
    [`Период: ${j.period ?? '01.03.2025 - 31.03.2025'}`],
    [`Брой документи: ${j.docs ?? docs}`],
    [`Брой счетоводни операции: ${j.ops ?? ops}`],
    ...(j.title ?? []).map(l => [l]),
    ['Фирма: ПРИМЕРНА ФИРМА ООД'],
    [`ЕИК:${EIK}`],
    HEADER,
    ...j.rows,
    ['', '', '', '', '', `Общо за счет. операции (${closing.opCount}):`, '', closing.qty, '', null, null, closing.ops, '', '', ''],
    ['', '', '', '', '', 'Общо', '', closing.qty, '', null, null, closing.all, '', '', ''],
  ]
}

const SALE_ROWS = [
  headerRow('03.03.2025', '-ФЕ', '0000000101', 120, '1', 'Стоки'),
  opRow('03.03.2025', '-ФЕ', '0000000101', '702', '304', '', 'СТОКИ:БОЛТОВЕ', 10, 60),
  opRow('03.03.2025', '-ФЕ', '0000000101', '411', '702', 'КЛИЕНТИ:Клиент А', '', null, 100),
  opRow('03.03.2025', '-ФЕ', '0000000101', '411', '4532', 'КЛИЕНТИ:Клиент А', '', null, 20),
]

function refusal(run: () => unknown): ExportRefused {
  try {
    run()
  } catch (e) {
    if (e instanceof ExportRefused) return e
    throw e
  }
  throw new Error('expected a refusal')
}

describe('the registry', () => {
  it('a bank comment names invoices by their whole type: `-ФЕ` is a prefix of `-ФЕА`, and they are different documents', () => {
    expect(settlesOf('-ФЕ 123,-ФЕА 124')).toEqual([{ docType: '-ФЕ', docNumber: '123' }, { docType: '-ФЕА', docNumber: '124' }])
    expect(settlesOf('+ФЕ0000000042')).toEqual([{ docType: '+ФЕ', docNumber: '0000000042' }])
  })

  it('what is no invoice reference names nothing, a comment cut off in the middle included', () => {
    expect(settlesOf('Такса,12.03.2025,100,')).toEqual([])
    expect(settlesOf('-ФЕ 123,-ФЕ')).toEqual([{ docType: '-ФЕ', docNumber: '123' }])
    expect(settlesOf(undefined)).toEqual([])
    expect(settlesOf('НЕЩО 123')).toEqual([])
  })

  it('a path is its root, its ancestors and its own name', () => {
    expect(rootOfPath('РАЗХОДИ:УСЛУГИ:Наем')).toBe('РАЗХОДИ')
    expect(rootOfPath('ПОС')).toBe('ПОС')
    expect(ancestorsOfPath('РАЗХОДИ:УСЛУГИ:Наем')).toEqual(['РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ'])
    expect(nameOfPath('РАЗХОДИ:УСЛУГИ:Наем')).toBe('Наем')
  })

  it('says which roots name a partner and which carry stock', () => {
    expect(analyticRootDef('КЛИЕНТИ')?.partner).toBe(true)
    expect(analyticRootDef('СТОКИ')?.quantitative).toBe(true)
    expect(analyticRootDef('РАЗХОДИ')?.quantitative).toBeUndefined()
    expect(analyticRootDef('НЕЩО')).toBeUndefined()
  })

  it('an account is what its digits say, and settlement accounts run on both sides', () => {
    expect(accountShapeOf('101').type).toBe('equity')
    expect(accountShapeOf('203')).toEqual({ type: 'asset', subType: 'fixed_asset', balanceSide: 'debit' })
    expect(accountShapeOf('2414').balanceSide).toBe('credit')
    expect(accountShapeOf('304').type).toBe('asset')
    expect(accountShapeOf('401')).toEqual({ type: 'liability', subType: 'current_liability', balanceSide: 'both' })
    expect(accountShapeOf('411')).toEqual({ type: 'asset', subType: 'current_asset', balanceSide: 'both' })
    expect(accountShapeOf('4532').type).toBe('liability')
    expect(accountShapeOf('604').type).toBe('expense')
    expect(accountShapeOf('702')).toEqual({ type: 'revenue', subType: 'operating_revenue', balanceSide: 'credit' })
    expect(accountShapeOf('990').type).toBe('liability')
  })

  it('drops what PlusMinus accumulates in a chart, and says why', () => {
    expect(chartJunkReason('#VALUE!', 'Нещо')).toBe('code')
    expect(chartJunkReason('1234567', 'Нещо')).toBe('code')
    expect(chartJunkReason('501', ' ')).toBe('name')
    expect(chartJunkReason('501', 'Каса')).toBeNull()
  })

  it('books in BGN before the euro, and counts base amounts once, each line rounded', () => {
    expect(ledgerCurrencyOn('2025-12-31')).toBe('BGN')
    expect(ledgerCurrencyOn('2026-01-01')).toBe('EUR')
    expect(baseAmount(195.583, 'BGN')).toBe(100)
    expect(baseAmount(10.005, 'EUR')).toBe(10.01)
    expect(baseAmount(-195.583, 'BGN')).toBe(-100)
    expect(exchangeRateOf('EUR')).toBe(1)
    expect(exchangeRateOf('BGN')).toBeCloseTo(0.5112918, 6)
  })

  it('rounds a correction to minus what it rounds the original to', () => {
    for (const x of [1.005, 2.675, 0.125, 10.015]) expect(roundCents(-x)).toBe(-roundCents(x))
    expect(Object.is(roundCents(-0.001), 0)).toBe(true)
  })

  it('walks the months of a period, across a year', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthsBetween('2026-03-01', '2026-03-31')).toEqual(['2026-03'])
  })
})

describe('the journal export', () => {
  it('a row with no accounts is a document, and the rows after it its operations', () => {
    const j = parseJournalExport(journalMatrix({ rows: SALE_ROWS }))
    expect(j.eik).toBe(EIK)
    expect(j.period).toEqual({ from: '2025-03-01', to: '2025-03-31' })
    expect(j.counts).toEqual({ documents: 1, operations: 3 })
    expect(j.documents).toHaveLength(1)
    const [doc] = j.documents
    expect(doc).toMatchObject({ date: '2025-03-03', docType: '-ФЕ', docNumber: '0000000101', vatKind: '1', total: 120, comment: 'Стоки' })
    expect(doc.ops.map(op => [op.d, op.k, op.amount])).toEqual([['702', '304', 60], ['411', '702', 100], ['411', '4532', 20]])
    expect(doc.ops[0]).toMatchObject({ ak: 'СТОКИ:БОЛТОВЕ', qty: 10 })
  })

  it('a row with no document is an entry of its own', () => {
    const rows = [opRow('31.03.2025', '', '', '603', '2414', '', 'ДА:Машина', null, 50), opRow('31.03.2025', '', '', '603', '2414', '', 'ДА:Друга', null, 60)]
    const j = parseJournalExport(journalMatrix({ rows }))
    expect(j.documents).toHaveLength(2)
    expect(j.documents.every(d => !d.docType && d.ops.length === 1)).toBe(true)
  })

  it('an operation whose document PlusMinus no longer holds is a document of its own, and is named', () => {
    const orphan = opRow('04.03.2025', '+ББ', '0000000777', '503', '411', 'БАНКОВИ СМЕТКИ:Сметка', 'КЛИЕНТИ:Клиент А', null, 120)
    const j = parseJournalExport(journalMatrix({ rows: [...SALE_ROWS, orphan] }))
    expect(j.counts).toEqual({ documents: 1, operations: 4 })
    expect(j.withoutHeader).toEqual([{ at: expect.any(String), date: '2025-03-04', docType: '+ББ', docNumber: '0000000777' }])
    expect(j.documents[1]).toEqual({ date: '2025-03-04', docType: '+ББ', docNumber: '0000000777', ops: [{ d: '503', k: '411', amount: 120, ad: 'БАНКОВИ СМЕТКИ:Сметка', ak: 'КЛИЕНТИ:Клиент А' }] })
    expect(() => assertWholeJournal(j)).not.toThrow()
  })

  it('keeps a negative amount and a negative quantity as booked', () => {
    const rows = [headerRow('10.03.2025', '-ФЕ', '0000000102', -12), opRow('10.03.2025', '-ФЕ', '0000000102', '702', '304', '', 'СТОКИ:БОЛТОВЕ', -1, -6)]
    expect(parseJournalExport(journalMatrix({ rows })).documents[0].ops[0]).toMatchObject({ amount: -6, qty: -1 })
  })

  it('keeps every decimal of an amount, and a path with its double space', () => {
    const rows = [opRow('10.03.2025', '', '', '601', '302', 'РАЗХОДИ:А  Б', 'МАТЕРИАЛИ:В', null, 12.3456789012)]
    expect(parseJournalExport(journalMatrix({ rows })).documents[0].ops[0]).toMatchObject({ amount: 12.3456789012, ad: 'РАЗХОДИ:А  Б' })
  })

  it('reads the layouts PlusMinus has used for the same report', () => {
    const header = ['Дата', 'Док.', 'Док. N', 'Дебит', 'Кредит', 'Аналитичност дебит', 'Аналитичност кредит', 'Кол', 'Валута', 'Курс', 'Валутна сума', 'Сума', 'Журнал', 'Вид', 'Данък', 'Коментар']
    const m = journalMatrix({ period: '01.03.2026 - 31.03.2026', title: ['Валута: Евро (€)'], rows: [] })
    m[m.findIndex(r => r[0] === 'Дата')] = header
    const at = m.findIndex(r => r[0] === 'Дата') + 1
    m.splice(at, 0, ['05.03.2026', '', '', '503', '411', 'БАНКОВИ СМЕТКИ:X', 'КЛИЕНТИ:Клиент А', null, 'EUR', 1, 10, 10, 'ДДС', '', 'Т1', 'Коментар'])
    m[at + 1] = ['', '', '', '', '', 'Общо за счет. операции (1):', '', 0, '', null, null, 10, '', '', '', '']
    m[at + 2] = ['', '', '', '', '', 'Общо', '', 0, '', null, null, 10, '', '', '', '']
    m[3] = ['Брой счетоводни операции: 1']
    const j = parseJournalExport(m)
    expect(j.currency).toBe('EUR')
    expect(j.documents[0].ops[0]).toMatchObject({ cur: 'EUR', rate: 1, fx: 10, journal: 'ДДС', tax: 'Т1', comment: 'Коментар' })
  })

  it('reads the text `NaN` in `Курс` as a blank, and refuses it where it would change a total', () => {
    const fine = [...opRow('10.03.2025', '', '', '402', '401', '', '', null, 10)]
    fine[9] = 'NaN'
    expect(parseJournalExport(journalMatrix({ rows: [fine] })).documents[0].ops[0].rate).toBeUndefined()
    const bad = [...opRow('10.03.2025', '', '', '402', '401', '', '', null, 10)]
    bad[11] = 'NaN'
    expect(refusal(() => parseJournalExport(journalMatrix({ rows: [bad], closing: { ops: 0, all: 0 } }))).code).toBe('bad_number')
  })

  describe('refuses, rather than guesses', () => {
    it('a filter in the title block, whatever it says', () => {
      const j = parseJournalExport(journalMatrix({ title: ['Док.: = +ФЕ'], rows: SALE_ROWS }))
      expect(j.filters).toEqual(['Док.: = +ФЕ'])
      expect(refusal(() => assertWholeJournal(j)).code).toBe('filtered_export')
    })

    it('an export with no document rows: the same report, filtered to one account', () => {
      const rows = SALE_ROWS.slice(1)
      expect(refusal(() => parseJournalExport(journalMatrix({ docs: 0, rows }))).code).toBe('operation_without_document')
    })

    it('operations without a header in a file that misses a header it declares, or in more documents than a complete one holds', () => {
      const orphan = (no: string) => opRow('04.03.2025', '+ББ', no, '503', '411', 'БАНКОВИ СМЕТКИ:Сметка', 'КЛИЕНТИ:Клиент А', null, 5)
      expect(refusal(() => parseJournalExport(journalMatrix({ docs: 2, rows: [...SALE_ROWS, orphan('0000000701')] }))).code).toBe('operation_without_document')
      const four = ['0000000701', '0000000702', '0000000703', '0000000704'].map(orphan)
      expect(refusal(() => parseJournalExport(journalMatrix({ rows: [...SALE_ROWS, ...four] }))).code).toBe('operation_without_document')
    })

    it('a count or a total the file itself contradicts', () => {
      expect(refusal(() => parseJournalExport(journalMatrix({ docs: 2, rows: SALE_ROWS }))).code).toBe('count_mismatch')
      expect(refusal(() => parseJournalExport(journalMatrix({ ops: 9, rows: SALE_ROWS }))).code).toBe('count_mismatch')
      expect(refusal(() => parseJournalExport(journalMatrix({ rows: SALE_ROWS, closing: { ops: 1 } }))).code).toBe('total_mismatch')
      expect(refusal(() => parseJournalExport(journalMatrix({ rows: SALE_ROWS, closing: { all: 1 } }))).code).toBe('total_mismatch')
      expect(refusal(() => parseJournalExport(journalMatrix({ rows: SALE_ROWS, closing: { qty: 1 } }))).code).toBe('total_mismatch')
    })

    it('an operation with one account', () => {
      const rows = [opRow('10.03.2025', '', '', '402', '', '', '', null, 10)]
      expect(refusal(() => parseJournalExport(journalMatrix({ rows }))).code).toBe('one_sided_operation')
    })

    it('another report', () => {
      expect(refusal(() => parseJournalExport([['Нещо друго'], HEADER])).code).toBe('not_a_journal')
      expect(refusal(() => parseJournalExport([['Нещо друго']])).code).toBe('no_table')
    })

    it('a period across the euro, or in the currency it was not booked in', () => {
      const crossing = parseJournalExport(journalMatrix({ period: '01.12.2025 - 31.01.2026', rows: [] }))
      expect(refusal(() => assertWholeJournal(crossing)).code).toBe('crosses_changeover')
      const converted = parseJournalExport(journalMatrix({ title: ['Валута: Евро (€)'], rows: [] }))
      expect(refusal(() => assertWholeJournal(converted)).code).toBe('wrong_currency')
      const inBgn = parseJournalExport(journalMatrix({ title: ['Валута: Лева (лв.)'], rows: [] }))
      expect(() => assertWholeJournal(inBgn)).not.toThrow()
    })
  })

  it('splits by month', () => {
    const rows = [opRow('31.01.2025', '', '', '402', '401', '', '', null, 10), opRow('01.02.2025', '', '', '402', '401', '', '', null, 20)]
    const j = parseJournalExport(journalMatrix({ period: '01.01.2025 - 28.02.2025', rows }))
    expect([...documentsByMonth(j.documents).keys()]).toEqual(['2025-01', '2025-02'])
  })
})

describe('the other exports', () => {
  it('reads a chart, with its year and opening balances', () => {
    const chart = parseChartExport([
      ['Сметкоплан'], ['Година: 2026'], ['Фирма: ПРИМЕРНА ФИРМА ООД'], [`ЕИК:${EIK}`],
      ['', '', 'Начално салдо', '', 'Начални обороти', ''],
      ['Код', 'Наименование', 'Дебит', 'Кредит', 'Дебит', 'Кредит'],
      ['101', 'Основен капитал', 0, 100.5, 0, 0],
      ['411', 'Клиенти', 40, null, 0, 0],
      ['Съставител/счетоводител/'],
    ])
    expect(chart.year).toBe(2026)
    expect(chart.eik).toBe(EIK)
    expect(chart.rows).toHaveLength(2)
    expect(chart.rows[0]).toMatchObject({ code: '101', openingCredit: 100.5, openingDebit: 0 })
  })

  const CELLS = [10, null, 5, 2, 13, null]

  it('reads a synthetic trial balance, its total apart', () => {
    const tb = parseTrialBalanceExport([
      ['Оборотна ведомост - Синтетична'], ['Период: 01.01.2025 - 31.12.2025'], ['Валута: Лева (лв.)'], ['Фирма: ПРИМЕРНА ФИРМА ООД'], [`ЕИК:${EIK}`],
      ['Сметка', '', 'Салдо в началото на периода', '', 'Обороти през периода', '', 'Салдо в края на периода', ''],
      ['Код', 'Име', 'Дебит', 'Кредит', 'Дебит', 'Кредит', 'Дебит', 'Кредит'],
      ['411', 'Клиенти', ...CELLS],
      ['', 'Общо за периода:', ...CELLS],
      ['Съставител/счетоводител/', '', '', '', '', '', '', ''],
    ])
    if (tb.kind !== 'synthetic') throw new Error('synthetic')
    expect(tb.currency).toBe('BGN')
    expect(tb.filters).toEqual([])
    expect(tb.rows).toEqual([{ code: '411', name: 'Клиенти', openingDebit: 10, openingCredit: 0, turnoverDebit: 5, turnoverCredit: 2, closingDebit: 13, closingCredit: 0 }])
    expect(tb.total?.turnoverDebit).toBe(5)
  })

  it('reads an analytic trial balance: its root, its quantities, and a path exactly as booked', () => {
    const tb = parseTrialBalanceExport([
      ['Оборотна ведомост - Аналитична'], ['Период: 01.01.2025 - 31.12.2025'], ['Избрани АП: СТОКИ:'], ['Фирма: ПРИМЕРНА ФИРМА ООД'], [`ЕИК:${EIK}`],
      ['', 'Салдо в началото на периода', '', '', 'Обороти през периода'],
      ['Аналитичен признак', 'Нач. кол-во', 'Дебит в лева', 'Кредит в лева', 'Дебит кол', 'Кредит кол', 'Дебит в лева', 'Кредит в лева', 'Количество', 'Дебит в лева', 'Кредит в лева'],
      ['СТОКИ:А  Б', 3, 12.5, null, 10, 8, 40.25, 33.75, 5, 19, null],
      ['Всичко:', 3, 12.5, null, 10, 8, 40.25, 33.75, 5, 19, null],
    ])
    if (tb.kind !== 'analytic') throw new Error('analytic')
    expect(tb.root).toBe('СТОКИ')
    expect(tb.filters).toEqual([])
    expect(tb.rows).toEqual([{
      path: 'СТОКИ:А  Б',
      openingQuantity: 3, openingDebit: 12.5, openingCredit: 0,
      turnoverDebitQuantity: 10, turnoverCreditQuantity: 8, turnoverDebit: 40.25, turnoverCredit: 33.75,
      closingQuantity: 5, closingDebit: 19, closingCredit: 0,
    }])
  })

  it('reads a main book, each account with what it corresponds with', () => {
    const book = parseMainBookExport([
      ['Главна книга - Синтетична'], ['Период: 01.01.2025 - 31.12.2025'], ['Валута: Лева (лв.)'], ['Фирма: ПРИМЕРНА ФИРМА ООД'], [`ЕИК:${EIK}`],
      ['Сметка', 'Коресп. сметка', 'Дебит', 'Кредит'],
      ['411 - Клиенти'],
      ['', 'Начално салдо', 10, null],
      ['', 'Начални обороти', null, null],
      ['', '702 - Приходи от стоки', 5, null],
      ['', '501 - Каса', null, 2],
      ['', 'Обороти през периода', 5, 2],
      ['', 'Салдо в края на периода', 13, null],
    ])
    expect(book.accounts).toEqual([{
      code: '411', name: 'Клиенти', openingDebit: 10, openingCredit: 0, turnoverDebit: 5, turnoverCredit: 2, closingDebit: 13, closingCredit: 0,
      counters: [{ code: '702', debit: 5, credit: 0 }, { code: '501', debit: 0, credit: 2 }],
    }])
  })

  describe('an analytics file', () => {
    const json = (rows: unknown[]) => new TextEncoder().encode(JSON.stringify(rows))

    it('reads a partner, and skips the group rows', () => {
      const items = parseAnalyticsFile(json([
        { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
        { ap: 'КЛИЕНТИ:Клиент А', params: { БУЛСТАТ: '000000000', ИНДДС: 'BG000000000', АДРЕС: 'ул. Първа 1', ГРАД: 'гр. Пример', ТЕЛЕФОН: '000', МОЛ: 'Лице' } },
      ]))
      expect(items).toEqual([{ path: 'КЛИЕНТИ:Клиент А', taxId: '000000000', vatNumber: 'BG000000000', address: 'ул. Първа 1', city: 'Пример', phone: '000', contactPerson: 'Лице' }])
    })

    it('takes the ЕИК from a VAT number when it has only that, a unit, and a currency account', () => {
      expect(parseAnalyticsFile(json([{ ap: 'КЛИЕНТИ:Б', params: { 'ИН ПО ДДС': 'BG000000000' } }]))[0].taxId).toBe('000000000')
      expect(parseAnalyticsFile(json([{ ap: 'СТОКИ:БОЛТОВЕ', params: { МЯРКА: 'БР' } }]))[0].unit).toBe('БР')
      expect(parseAnalyticsFile(json([{ ap: 'СТОКИ:БОЛТОВЕ', params: { Мярка: 'бр' } }]))[0].unit).toBe('бр')
      expect(parseAnalyticsFile(json([{ ap: 'БАНКОВИ СМЕТКИ:X', params: { Банка: 'Банка' }, currency: 'true' }]))[0]).toEqual({ path: 'БАНКОВИ СМЕТКИ:X', bankName: 'Банка', foreignCurrency: true })
    })

    it('reads the install\'s own encoding, CP1251', () => {
      const text = '[{"ap":"СТОКИ:БОЛТОВЕ","params":{}}]'
      const bytes = Uint8Array.from([...text].map(c => (c.charCodeAt(0) >= 0x410 ? c.charCodeAt(0) - 0x410 + 0xC0 : c.charCodeAt(0))))
      expect(parseAnalyticsFile(bytes)[0].path).toBe('СТОКИ:БОЛТОВЕ')
    })

    it('refuses the employees\' file: the books do not need it', () => {
      expect(refusal(() => parseAnalyticsFile(json([{ ap: 'ПЕРСОНАЛ:Някой', params: {} }]))).code).toBe('personal_data')
    })
  })
})

describe('a month, planned', () => {
  const sale = (over: Partial<ImportDocument> = {}): ImportDocument => ({
    date: '2025-03-03',
    docType: '-ФЕ',
    docNumber: '0000000101',
    vatKind: '1',
    total: 120,
    ops: [
      { d: '702', k: '304', ak: 'СТОКИ:БОЛТОВЕ', qty: 10, amount: 60 },
      { d: '411', k: '702', ad: 'КЛИЕНТИ:Клиент А', amount: 100 },
      { d: '411', k: '4532', ad: 'КЛИЕНТИ:Клиент А', amount: 20 },
    ],
    ...over,
  })

  it('an entry is found again by what it is, whatever "Преизчисление" did to its amounts', () => {
    const [before] = planMonth([sale()], [])
    const recosted = sale()
    recosted.ops[0].amount = 61
    const [after] = planMonth([recosted], [])
    expect(after.importKey).toBe(before.importKey)
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('a document number is not unique across suppliers, so the partner is part of the key', () => {
    const a = sale({ docType: '+ФЕ', ops: [{ d: '304', k: '401', ak: 'ДОСТАВЧИЦИ:Първи', amount: 1 }] })
    const b = sale({ docType: '+ФЕ', ops: [{ d: '304', k: '401', ak: 'ДОСТАВЧИЦИ:Втори', amount: 1 }] })
    const [x, y] = planMonth([a, b], [])
    expect(x.importKey).not.toBe(y.importKey)
  })

  it('tells the same operation twice on a day apart by its place in the file', () => {
    const op = { date: '2025-03-31', ops: [{ d: '603', k: '2414', ak: 'ДА:Машина', amount: 5 }] }
    const [x, y] = planMonth([op, op], [])
    expect(x.importKey).not.toBe(y.importKey)
    expect(y.importKey.endsWith('#2')).toBe(true)
  })

  it('names the one partner, and none on a statement that pays several', () => {
    expect(planMonth([sale()], [])[0].partnerPath).toBe('КЛИЕНТИ:Клиент А')
    const statement = sale({ docType: '+ББ', ops: [
      { d: '503', k: '411', ak: 'КЛИЕНТИ:Клиент А', amount: 1 },
      { d: '503', k: '411', ak: 'КЛИЕНТИ:Клиент Б', amount: 2 },
    ] })
    expect(planMonth([statement], [])[0].partnerPath).toBeUndefined()
  })

  it('reads a document\'s VAT from the side that charges it', () => {
    expect(planMonth([sale()], [])[0].docVat).toBe(20)
    const purchase = sale({ docType: '+ФЕ', ops: [{ d: '304', k: '401', amount: 100 }, { d: '4531', k: '401', amount: 20 }] })
    expect(planMonth([purchase], [])[0].docVat).toBe(20)
    const protocol = sale({ docType: '-П', ops: [{ d: '4531', k: '4532', amount: 20 }] })
    expect(planMonth([protocol], [])[0].docVat).toBe(20)
    const noDocument = { date: '2025-03-31', ops: [{ d: '4532', k: '4531', amount: 20 }] }
    expect(planMonth([noDocument], [])[0].docVat).toBeUndefined()
  })

  it('a sales document\'s number says whose it is, and nothing else does', () => {
    const branches = [{ orgId: 'pz', docSeries: ['00001'] }, { orgId: 'sf', docSeries: ['00002'] }]
    expect(planMonth([sale({ docNumber: '0000200001' })], branches)[0].branchOrgId).toBe('sf')
    expect(planMonth([sale({ docNumber: '0000900001' })], branches)[0].branchOrgId).toBeUndefined()
    const bank = sale({ docType: '+ББ', docNumber: '0000200001', ops: [{ d: '503', k: '411', amount: 1 }] })
    expect(planMonth([bank], branches)[0].branchOrgId).toBeUndefined()
  })

  it('a link made later changes the hash, which is how a re-import writes it onto the lines', () => {
    const [entry] = planMonth([sale()], [])
    const before = importHashOf(entry, { branchOrgId: 'books', contactIds: [undefined, undefined] })
    expect(importHashOf(entry, { branchOrgId: 'books', contactIds: [undefined, undefined] })).toBe(before)
    expect(importHashOf(entry, { branchOrgId: 'books', contactIds: ['c1', undefined] })).not.toBe(before)
    expect(importHashOf(entry, { branchOrgId: 'pz', contactIds: [undefined, undefined] })).not.toBe(before)
  })

  it('what a bank line pays is on the line that takes it off the partner', () => {
    const doc: ImportDocument = { date: '2025-03-05', docType: '+ББ', docNumber: '1', comment: '-ФЕ 7', ops: [] }
    expect(settlesOfOperation(doc, { d: '503', k: '411', amount: 1, comment: '-ФЕ 9' })).toEqual({ side: 'credit', settles: [{ docType: '-ФЕ', docNumber: '9' }] })
    expect(settlesOfOperation(doc, { d: '401', k: '503', amount: 1 })).toEqual({ side: 'debit', settles: [{ docType: '-ФЕ', docNumber: '7' }] })
    expect(settlesOfOperation({ ...doc, docType: '-ФЕ' }, { d: '503', k: '411', amount: 1, comment: '-ФЕ 9' })).toBeNull()
  })
})

describe('the comparison with PlusMinus', () => {
  const cells = { openingDebit: 10, openingCredit: 0, turnoverDebit: 5, turnoverCredit: 2, closingDebit: 13, closingCredit: 0 }
  const row = (code: string, over = {}) => ({ accountId: code, code, name: code, ...cells, ...over })
  const file = (code: string, over = {}) => ({ code, name: code, ...cells, ...over })

  it('equal is equal, to the half cent the file rounds to', () => {
    expect(compareTrialBalance([file('411')], [row('411', { turnoverDebit: 5.004 })])).toMatchObject({ rows: 1, cells: 6, differingCells: 0 })
    expect(compareTrialBalance([file('102', { openingCredit: 1234.57 })], [row('102', { openingCredit: 1234.565 })]).differingCells).toBe(0)
  })

  it('counts the cells that differ, and names the account', () => {
    const v = compareTrialBalance([file('411'), file('501')], [row('411', { turnoverDebit: 5.01, closingDebit: 13.01 }), row('501')])
    expect(v).toMatchObject({ rows: 2, cells: 12, differingCells: 2, differingRows: 1, accounts: ['411'] })
  })

  it('a row on one side only differs, and one that holds nothing does not', () => {
    expect(compareTrialBalance([file('411')], [])).toMatchObject({ differingRows: 1, missingRows: 1, accounts: ['411'] })
    const empty = { openingDebit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0 }
    expect(compareTrialBalance([file('411', empty)], []).differingCells).toBe(0)
  })

  it('compares an analytic row\'s quantities too, and names no path: a path can name a partner', () => {
    const quantities = { openingQuantity: 3, turnoverDebitQuantity: 10, turnoverCreditQuantity: 8, closingQuantity: 5 }
    const mine = { analyticId: 'a', path: 'КЛИЕНТИ:Клиент А', ...cells, ...quantities, closingQuantity: 6 }
    const theirs = { path: 'КЛИЕНТИ:Клиент А', ...cells, ...quantities }
    const v = compareAnalyticTrialBalance([theirs], [mine])
    expect(v).toMatchObject({ cells: 10, differingCells: 1, differingRows: 1, accounts: [] })
    expect(JSON.stringify(v)).not.toContain('Клиент')
  })

  it('compares a main book\'s correspondents, each once', () => {
    const counters = [{ code: '702', debit: 5, credit: 0 }]
    const v = compareMainBook(
      [{ ...file('411'), counters }],
      [{ ...row('411'), counters: [{ code: '702', name: 'x', debit: 6, credit: 0 }, { code: '501', name: 'y', debit: 0, credit: 2 }] }],
    )
    expect(v).toMatchObject({ differingRows: 2, missingRows: 1, accounts: ['411'] })
  })

  it('proves a period with no trial balance against the journal\'s own turnovers', () => {
    const j = { documents: [{ date: '2025-03-03', ops: [{ d: '304', k: '401', ad: 'СТОКИ:БОЛТОВЕ', ak: 'ДОСТАВЧИЦИ:Първи', qty: 2, amount: 10 }, { d: '304', k: '401', ad: 'СТОКИ:БОЛТОВЕ', ak: 'ДОСТАВЧИЦИ:Първи', qty: -1, amount: -4 }] }] }
    const books = [row('304', { turnoverDebit: 6, turnoverCredit: 0 }), row('401', { turnoverDebit: 0, turnoverCredit: 6 })]
    expect(compareJournalAccounts(j, books)).toMatchObject({ cells: 4, differingCells: 0 })
    const analytic = (path: string, d: number, k: number, qd: number, qk: number) => ({ analyticId: path, path, ...cells, turnoverDebit: d, turnoverCredit: k, openingQuantity: 0, turnoverDebitQuantity: qd, turnoverCreditQuantity: qk, closingQuantity: 0 })
    expect(compareJournalAnalytics(j, [analytic('СТОКИ:БОЛТОВЕ', 6, 0, 1, 0), analytic('ДОСТАВЧИЦИ:Първи', 0, 6, 0, 1)])).toMatchObject({ cells: 8, differingCells: 0 })
    expect(compareJournalAnalytics(j, [analytic('СТОКИ:БОЛТОВЕ', 6, 0, 2, 0), analytic('ДОСТАВЧИЦИ:Първи', 0, 6, 0, 1)]).differingCells).toBe(1)
  })
})
