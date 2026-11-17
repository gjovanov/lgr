import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.12 (#797, D-5): the generic payroll run computes no overtime, bonuses or allowances, and its form and its
 * payslips say so; the controls that did nothing (the four lists' Export, the payslip's PDF) are gone, filed as
 * #830. And a TODO left in the source names where it is tracked, so the open item cannot grow back unseen.
 */
const PACKAGES = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string) => readFileSync(join(PACKAGES, rel), 'utf8')

describe('payroll says what it computes (FR-32.12)', () => {
  it('the run form and the payslip show the note on a run of the generic engine', () => {
    const form = read('payroll-ui/src/views/payroll/PayrollRunFormView.vue')
    expect(form).toMatch(/v-if="isEdit && runEngine !== 'bg'"[^>]*data-testid="legacy-not-computed"/)
    expect(form).toContain("runEngine.value = item.engine || ''")
    const slips = read('payroll-ui/src/views/payroll/PayslipsView.vue')
    expect(slips).toMatch(/v-if="selectedPayslip\.engine !== 'bg'"[^>]*data-testid="legacy-not-computed"/)
  })

  it('the note is in all four languages', () => {
    for (const loc of ['en', 'bg', 'de', 'mk']) {
      const json = JSON.parse(read(`ui-shared/src/locales/${loc}.json`))
      expect(typeof json.payroll?.legacyNotComputed).toBe('string')
      expect(json.payroll.legacyNotComputed.length).toBeGreaterThan(20)
    }
  })

  it('the generic calculation states its gross as the base salary, with nothing computed beside it', () => {
    const service = read('services/src/biz/payroll.service.ts')
    expect(service).toContain('const grossPay = baseSalary\n')
    expect(service).not.toMatch(/TODO: calculate from timesheets/)
  })

  it('no payroll list offers an Export that does nothing, and no payslip a PDF that does nothing', () => {
    for (const v of ['EmployeesView', 'PayrollRunsView', 'PayslipsView', 'TimesheetsView']) {
      const src = read(`payroll-ui/src/views/payroll/${v}.vue`)
      expect(src).not.toContain('ExportMenu')
      expect(src).not.toContain('downloadPdf(')
    }
  })
})

describe('a TODO names where it is tracked', () => {
  it('every TODO or FIXME in the source carries an issue number or a spec item', () => {
    const untracked: string[] = []
    for (const f of new Glob('*/src/**/*.{ts,vue}').scanSync(PACKAGES)) {
      if (/^(tests|e2e)[\\/]/.test(f)) continue
      readFileSync(join(PACKAGES, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\b(TODO|FIXME)\b/.test(line) && !/\b(TODO|FIXME)\((?:#\d+|FR-\d+[^)]*)\)|#\d+/.test(line)) untracked.push(`${f}:${i + 1}`)
      })
    }
    expect(untracked).toEqual([])
  })
})
