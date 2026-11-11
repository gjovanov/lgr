import { describe, it, expect } from 'bun:test'
import { parseAmount, parseStatementCsv, parseStatementDate } from 'services/biz/bank-reconciliation/statement-csv'

/** #675: a bank statement as CSV, read into statement lines, whichever bank and language exported it. */

const day = (d: Date) => d.toISOString().slice(0, 10)

describe('amounts and dates as banks write them', () => {
  it('a decimal comma or point, thousands of any kind, a sign before or after', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56)
    expect(parseAmount('1.234,56')).toBe(1234.56)
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('-12,5')).toBe(-12.5)
    expect(parseAmount('12.50-')).toBe(-12.5)
    expect(parseAmount('(40,00)')).toBe(-40)
    expect(parseAmount('1,234')).toBe(1234)
    expect(parseAmount('EUR 15.00')).toBe(15)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('n/a')).toBeNull()
  })

  it('dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd, with or without a time; nonsense is no date', () => {
    expect(day(parseStatementDate('31.10.2026')!)).toBe('2026-10-31')
    expect(day(parseStatementDate('31/10/2026 14:05')!)).toBe('2026-10-31')
    expect(day(parseStatementDate('2026-10-31T08:00:00')!)).toBe('2026-10-31')
    expect(day(parseStatementDate('01.11.26')!)).toBe('2026-11-01')
    expect(parseStatementDate('31.02.2026')).toBeNull()
    expect(parseStatementDate('Opening balance')).toBeNull()
  })
})

describe('a statement', () => {
  it('Bulgarian headers, `;`, debit and credit columns: credit is money in, debit money out', () => {
    const csv = [
      'Извлечение по сметка BG80BNBG96611020345678',
      'Дата;Основание;Дебит;Кредит;Референция',
      '01.11.2026;Плащане фактура 123;;1 200,00;REF-1',
      '02.11.2026;Такса обслужване;12,50;;REF-2',
      '03.11.2026;"Наем; ноември";800,00;;',
      'Начално салдо;;;;',
    ].join('\r\n')
    const r = parseStatementCsv(csv)
    expect(r.lines).toEqual([
      { date: new Date('2026-11-01'), description: 'Плащане фактура 123', amount: 1200, bankReference: 'REF-1' },
      { date: new Date('2026-11-02'), description: 'Такса обслужване', amount: -12.5, bankReference: 'REF-2' },
      { date: new Date('2026-11-03'), description: 'Наем; ноември', amount: -800 },
    ])
    expect(r.unrecognized).toEqual([{ row: 6, reason: 'no date in "Начално салдо"' }])
    expect(r.columns).toMatchObject({ date: 'Дата', description: 'Основание', debit: 'Дебит', credit: 'Кредит', reference: 'Референция' })
  })

  it('English headers, `,`, one signed amount column', () => {
    const r = parseStatementCsv('Booking date,Details,Amount,Reference\n2026-11-05,"Card payment, shop",-45.90,TX9\n2026-11-06,Transfer in,"1,000.00",TX10\n')
    expect(r.lines.map(l => [day(l.date), l.description, l.amount, l.bankReference])).toEqual([
      ['2026-11-05', 'Card payment, shop', -45.9, 'TX9'],
      ['2026-11-06', 'Transfer in', 1000, 'TX10'],
    ])
  })

  it('German headers and a tab', () => {
    const r = parseStatementCsv('Buchungsdatum\tVerwendungszweck\tBetrag\n05.11.2026\tMiete\t-1.200,00\n')
    expect(r.lines).toEqual([{ date: new Date('2026-11-05'), description: 'Miete', amount: -1200 }])
  })

  it('a file with no date and amount header reads nothing, and says why', () => {
    const r = parseStatementCsv('foo;bar\n1;2\n')
    expect(r.lines).toEqual([])
    expect(r.columns).toBeNull()
    expect(r.unrecognized[0].reason).toContain('no header')
  })
})
