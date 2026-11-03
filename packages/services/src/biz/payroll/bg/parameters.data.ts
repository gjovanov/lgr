import annexes from './data/zbdoo-2026.json' with { type: 'json' }
import type { ParameterRow } from './parameters.js'

/**
 * FR-25 §7.4: Bulgaria's payroll parameters, dated. Public law and nothing else: no customer's value
 * belongs here. A rate is looked up by date, never by year: 2026 alone has two periods, split at
 * 08-01, and 2025's split at 04-01. The rows go back as far as the earliest filed month this system
 * holds. Rates before that are the law's business, and nothing here calculates them.
 *
 * ⚠ Amounts are in the currency of their row. `currency` says which one a period runs in.
 */
const KSO = 'КСО чл. 6'
const ZBNZOK = 'ЗБНЗОК чл. 2'
const START = '2022-01-01'

const rate = (key: string, value: number, source: string): ParameterRow => ({ key, effectiveFrom: START, value, source })

const dated = (key: string, source: string, rows: ReadonlyArray<readonly [string, number, 'BGN' | 'EUR']>): ParameterRow[] =>
  rows.map(([effectiveFrom, value, currency]) => ({ key, effectiveFrom, value, currency, source }))

const calendarRow = (year: number, holidays: string, workingWeekends = ''): ParameterRow => ({
  key: 'calendar',
  effectiveFrom: `${year}-01-01`,
  value: { holidays: holidays.split(','), workingWeekends: workingWeekends ? workingWeekends.split(',') : [] },
  source: 'КТ чл. 154 and the Council of Ministers\' decisions moving days',
})

export const PAYROLL_PARAMETERS: readonly ParameterRow[] = [
  { key: 'currency', effectiveFrom: START, value: 'BGN', source: 'lev until the euro changeover' },
  { key: 'currency', effectiveFrom: '2026-01-01', value: 'EUR', source: 'Закон за въвеждане на еврото' },

  ...dated('minWage', 'ПМС on the minimum wage of each year', [
    [START, 650, 'BGN'], ['2022-04-01', 710, 'BGN'], ['2023-01-01', 780, 'BGN'], ['2024-01-01', 933, 'BGN'],
    ['2025-01-01', 1077, 'BGN'], ['2026-01-01', 620.20, 'EUR'],
  ]),
  ...dated('maxInsurableIncome', 'ЗБДОО of each year', [
    [START, 3000, 'BGN'], ['2022-04-01', 3400, 'BGN'], ['2024-01-01', 3750, 'BGN'], ['2025-04-01', 4130, 'BGN'],
    ['2026-01-01', 2111.64, 'EUR'], ['2026-08-01', 2300, 'EUR'],
  ]),
  // The lowest income for a self-insured person. The base of health contributions during sick leave
  // and unpaid leave (ЗЗО чл. 40), and the floor where no annex for the period is held below.
  ...dated('minInsurableSelfInsured', 'ЗБДОО of each year', [
    [START, 650, 'BGN'], ['2022-04-01', 710, 'BGN'], ['2023-08-01', 780, 'BGN'], ['2024-01-01', 933, 'BGN'],
    ['2025-04-01', 1077, 'BGN'], ['2026-01-01', 550.66, 'EUR'], ['2026-08-01', 620.20, 'EUR'],
  ]),

  rate('rate.pension.before1960.employer', 11.02, KSO),
  rate('rate.pension.before1960.employee', 8.78, KSO),
  rate('rate.pension.from1960.employer', 8.22, KSO),
  rate('rate.pension.from1960.employee', 6.58, KSO),
  rate('rate.sickness.employer', 2.1, KSO),
  rate('rate.sickness.employee', 1.4, KSO),
  rate('rate.unemployment.employer', 0.6, KSO),
  rate('rate.unemployment.employee', 0.4, KSO),
  rate('rate.upf.employer', 2.8, 'КСО чл. 157'),
  rate('rate.upf.employee', 2.2, 'КСО чл. 157'),
  rate('rate.health.employer', 4.8, ZBNZOK),
  rate('rate.health.employee', 3.2, ZBNZOK),
  rate('rate.gvrs', 0, 'ЗБДОО чл. 15'),
  rate('rate.tax', 10, 'ЗДДФЛ чл. 48'),

  // TODO(FR-25 §7.5, item 6): no official euro figure was found; this is 660 лв. at the fixed rate.
  ...dated('relief.disability.monthly', 'ЗДДФЛ чл. 18', [[START, 660, 'BGN'], ['2026-01-01', 337.45, 'EUR']]),
  // One child, two, three or more. Before 2026 runs are imported, never calculated.
  { key: 'relief.children.monthly', effectiveFrom: '2026-01-01', value: [255.65, 511.29, 766.94], currency: 'EUR', source: 'ЗДДФЛ чл. 22в, NRA for 2026' },

  // Annexes 1 and 1А, 2 and 2А. Earlier years' annexes are not held: their months were filed already.
  ...Object.entries(annexes.minInsurableIncome).map(([effectiveFrom, value]) => ({
    key: 'minInsurableByActivity', effectiveFrom, value, currency: 'EUR', source: annexes.source,
  })),
  ...Object.entries(annexes.tzpb).map(([effectiveFrom, value]) => ({
    key: 'tzpbByActivity', effectiveFrom, value, source: annexes.source,
  })),

  calendarRow(2022, '0101,0103,0303,0422,0423,0424,0425,0501,0502,0506,0524,0906,0922,1224,1225,1226,1227,1228'),
  calendarRow(2023, '0101,0102,0303,0414,0415,0416,0417,0501,0506,0508,0524,0906,0922,1224,1225,1226,1227'),
  calendarRow(2024, '0101,0303,0304,0501,0503,0504,0505,0506,0524,0906,0922,0923,1224,1225,1226'),
  calendarRow(2025, '0101,0303,0418,0419,0420,0421,0501,0506,0524,0526,0906,0908,0922,1224,1225,1226,1231'),
  calendarRow(2026, '0101,0102,0303,0410,0411,0412,0413,0501,0506,0524,0525,0906,0907,0922,1224,1225,1226,1228'),
]
