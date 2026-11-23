import { describe, it, expect } from 'bun:test'
import { payrollExportPath, wordsOf } from '../../../payroll-ui/src/composables/payroll-export'
import { buildPayslipMarkdown, payslipLabels, PAYSLIP_PDF_LABELS, type PayslipPdfData } from 'reporting/pdf/payslip.pdf'
import { exportLabels, listSort } from 'services/biz/payroll/list-export'

/**
 * #830: the pure parts of the payroll lists' Export and the payslip's PDF. The routes are
 * `integration/payroll-list-export.flow.test.ts`.
 */

describe('the export\'s address (payroll-ui)', () => {
  it('carries the list\'s filters and order, the format, the language and the screen\'s words', () => {
    const path = payrollExportPath('/org/o1', 'timesheet', {
      filters: { search: 'Ана', employeeId: 'e1', dateFrom: '2026-01-01', dateTo: '', status: null, tags: ['a', 'b'], none: [] },
      sortBy: 'date',
      sortOrder: 'asc',
      format: 'pdf',
      locale: 'bg',
      labels: { title: 'Отчети' },
    })
    const [base, query] = path.split('?')
    expect(base).toBe('/org/o1/payroll/timesheet/export')
    const params = new URLSearchParams(query)
    expect(params.get('search')).toBe('Ана')
    expect(params.get('employeeId')).toBe('e1')
    expect(params.get('dateFrom')).toBe('2026-01-01')
    expect(params.get('tags')).toBe('a,b')
    // An empty filter is no filter.
    expect(params.has('dateTo')).toBe(false)
    expect(params.has('status')).toBe(false)
    expect(params.has('none')).toBe(false)
    expect(params.get('sortBy')).toBe('date')
    expect(params.get('sortOrder')).toBe('asc')
    expect(params.get('format')).toBe('pdf')
    expect(params.get('locale')).toBe('bg')
    expect(JSON.parse(params.get('labels')!)).toEqual({ title: 'Отчети' })
  })

  it('names each value by the screen\'s word', () => {
    expect(wordsOf(['active', 'terminated'], v => v.toUpperCase())).toEqual({ active: 'ACTIVE', terminated: 'TERMINATED' })
  })
})

describe('what the server takes from the screen', () => {
  it('labels are JSON words or nothing', () => {
    expect(exportLabels('{"title":"Служители"}')).toEqual({ title: 'Служители' })
    expect(exportLabels('not json')).toEqual({})
    expect(exportLabels('[1,2]')).toEqual({})
    expect(exportLabels(undefined)).toEqual({})
    expect(exportLabels('x'.repeat(20_001))).toEqual({})
  })

  it('sorts by one plain field, else the newest first', () => {
    expect(listSort({ sortBy: 'lastName', sortOrder: 'asc' })).toEqual({ lastName: 1 })
    expect(listSort({ sortBy: 'period.from' })).toEqual({ 'period.from': -1 })
    expect(listSort({ sortBy: '$where' })).toEqual({ createdAt: -1 })
    expect(listSort({ sortBy: ['a', 'b'] })).toEqual({ a: -1 })
    expect(listSort({})).toEqual({ createdAt: -1 })
  })
})

describe('the payslip\'s sheet (reporting)', () => {
  const data: PayslipPdfData = {
    orgName: 'Пример ООД',
    employee: { name: 'Ива <b>Примерова</b>', number: 'E-1', department: 'Продажби', position: 'Продавач', employmentType: 'Пълно време' },
    period: { from: '2026-03-01', to: '2026-03-31' },
    earnings: [{ type: 'salary', description: 'Заплата | основна', amount: 2000 }],
    deductions: [{ type: 'tax', description: 'ДОД', amount: 172.44 }],
    grossPay: 2000,
    totalDeductions: 172.44,
    netPay: 1827.56,
    yearToDate: { grossPay: 6000, totalDeductions: 517.32, netPay: 5482.68 },
    paymentMethod: 'По банка',
    currency: 'EUR',
  }

  it('says whose payslip and what it pays, in the reader\'s words', () => {
    const md = buildPayslipMarkdown(data, payslipLabels({ title: 'Фиш', netPay: 'Нето', grossPay: 'Бруто' }))
    expect(md.startsWith('# Фиш\n')).toBe(true)
    expect(md).toContain('01.03.2026 – 31.03.2026')
    expect(md).toContain('**Нето** | **1827.56**')
    expect(md).toContain('| Бруто | 2000.00 |')
    expect(md).toContain('E-1')
    expect(md).toContain('5482.68')
    expect(md).toContain('(EUR)')
  })

  it('prints a stored value as text: no markup, no cell it can end', () => {
    const md = buildPayslipMarkdown(data)
    expect(md).toContain('Ива &lt;b&gt;Примерова&lt;/b&gt;')
    expect(md).not.toContain('<b>')
    expect(md).toContain('Заплата \\| основна')
  })

  it('takes a label only as a string, and English for the rest', () => {
    const labels = payslipLabels({ title: 'Фиш', netPay: 42, unknown: 'x', grossPay: '   ' })
    expect(labels.title).toBe('Фиш')
    expect(labels.netPay).toBe(PAYSLIP_PDF_LABELS.netPay)
    expect(labels.grossPay).toBe(PAYSLIP_PDF_LABELS.grossPay)
    expect('unknown' in labels).toBe(false)
  })

  it('leaves out what the payslip does not carry, rather than printing an empty line', () => {
    const md = buildPayslipMarkdown({ ...data, employee: { name: 'Ива' }, yearToDate: undefined, paymentMethod: undefined })
    expect(md).not.toContain(PAYSLIP_PDF_LABELS.department)
    expect(md).not.toContain(PAYSLIP_PDF_LABELS.yearToDate)
    expect(md).not.toContain(PAYSLIP_PDF_LABELS.paymentMethod)
  })
})
