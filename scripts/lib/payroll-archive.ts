/**
 * FR-25: the employer's payroll (ТРЗ) read straight out of a PlusMinus database dump, into the shapes `payroll-exports.ts` reads
 * from the GUI exports (`PersonnelRow`, `SalarySheet`). The dump format: `packages/services/src/biz/accounting-books/plusminus-archive.ts`.
 *
 *   ТРЗ\ПЕРСОНАЛ\<person, keyed by full name>\ПАРАМЕТРИ\<field>\<value>            ЕГН, ИМЕ, ПОСТЪПИЛ, ОСНЗАПЛ, ТДНКИД, ВИДОСИГ…
 *   ТРЗ\ПЕРСОНАЛ\<person>\ЗАПЛАТИ\<YYYYMM>\ДНИ\<code>\<n>, …\СУМИ\<code|field>\<n>  the month's sheet, as PlusMinus computed it
 *   ТРЗ\ПЕРСОНАЛ\<person>\ОТСЪСТВИЯ\<YYYYMM>\<id>\{СУМА,КОМЕНТАР}                   absences
 *   ТРЗ\{ДЛЪЖНОСТИ,ОТДЕЛИ,РАБДНИ,ДОКУМЕНТИ,НЕПОДАД,ДРУГИ,ОПЕРАЦИИ}                  the module's other tables, kept as trees
 *
 * A person re-hired has one ПЕРСОНАЛ node per engagement, under the same ЕГН, exactly as „Персонал" lists one row per engagement.
 *
 * **Proven 2026-11-05** on archive 20261105 against the sealed E8 exports: personnel 361/361 rows of the 11-05 exports equal on all
 * 14 fields; the sheets 4,945 of 4,968 mapped cells over 45 months, the rest all in one person-month of a December 2025 sheet
 * exported on 19 December, before that month was final.
 *
 * ⚠ Personal data, all of it. Callers keep it in memory or seal it (`lgr-sealed-1`), and print counts only: never a name, an ЕГН or
 * a per-person amount.
 */
import { decode1251, walkDump, FLOAT64_TAG, type TreeNode } from '../../packages/services/src/biz/accounting-books/plusminus-archive'
import type { PersonnelRow, SalarySheet, SheetRow } from './payroll-exports'

export interface PayrollMonth { days: Record<string, number>; sums: Record<string, number> }
export interface ArchiveEmployee {
  /** The ПЕРСОНАЛ node's name: PlusMinus keys a person by their full name. */
  key: string
  params: Record<string, string>
  months: Record<string, PayrollMonth>
  absences: Record<string, { id: string; sum?: number; comment?: string }[]>
}
export interface ArchivePayroll { company: string; employees: ArchiveEmployee[]; tables: Record<string, TreeNode> }

const num = (s: string | number) => {
  const n = typeof s === 'number' ? s : Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? Number(n.toFixed(10)) : undefined
}

/** One walk: every person under ТРЗ\ПЕРСОНАЛ, and the module's other tables as trees. */
export async function readArchivePayroll(gz: Buffer): Promise<ArchivePayroll> {
  const employees: ArchiveEmployee[] = []
  const tables: Record<string, TreeNode> = {}
  const companies = new Set<string>()
  const p: string[] = []
  let emp: ArchiveEmployee | null = null
  let stack: TreeNode[] = []
  await walkDump(gz, r => {
    const name = r.tag === FLOAT64_TAG ? String(r.bytes.readDoubleLE(0)) : decode1251(r.bytes)
    p.length = r.depth; p[r.depth] = name
    if (p[0] !== 'ФИРМИ' || p[2] !== 'ТРЗ' || r.depth < 3) return
    companies.add(p[1])
    if (p[3] !== 'ПЕРСОНАЛ') {
      if (r.depth === 3) { tables[name] = { name, kids: [] }; stack = [tables[name]]; return }
      const parent = stack[r.depth - 4]
      if (!parent) return
      const node: TreeNode = { name, kids: [] }
      parent.kids.push(node); stack.length = r.depth - 3; stack[r.depth - 3] = node
      return
    }
    if (r.depth === 4) { emp = { key: name, params: {}, months: {}, absences: {} }; employees.push(emp); return }
    if (!emp) return
    const section = p[5]
    if (section === 'ПАРАМЕТРИ' && r.depth === 7) { if (!(p[6] in emp.params)) emp.params[p[6]] = name; return }
    if (section === 'ЗАПЛАТИ' && r.depth === 9) {
      const m = (emp.months[p[6]] ??= { days: {}, sums: {} })
      const v = num(name); if (v === undefined) return
      if (p[7] === 'ДНИ') m.days[p[8]] ??= v
      else if (p[7] === 'СУМИ') m.sums[p[8]] ??= v
      return
    }
    if (section === 'ОТСЪСТВИЯ' && r.depth === 9) {
      const list = (emp.absences[p[6]] ??= [])
      let a = list.find(x => x.id === p[7]); if (!a) list.push(a = { id: p[7] })
      if (p[8] === 'СУМА') a.sum = num(name)
      else if (p[8] === 'КОМЕНТАР') a.comment = name
    }
  })
  if (companies.size > 1) throw new Error(`payroll-archive: the dump holds ${companies.size} companies with a payroll; expected one`)
  return { company: [...companies][0] ?? '', employees, tables }
}

/**
 * The month's sheet („Ведомост за заплати"): the vendor's column label → where the stored month keeps it. Proven 2026-11-05 (header).
 * ⚠ „Дни във временна неработоспособност" is NOT here: no single code or sum of two equals it in every month. Nothing reads it.
 */
export const SHEET_LABELS: Readonly<Record<string, { from: 'days' | 'sums'; code: string }>> = {
  'Заплата': { from: 'sums', code: '101' }, 'Отр. дни': { from: 'days', code: '101' },
  'ДТВ за стаж': { from: 'sums', code: '102' },
  'Пл.отп. чл.155,ал.1': { from: 'sums', code: '1' }, 'Платен отпуск': { from: 'days', code: '1' },
  'Болн. сума раб-л': { from: 'sums', code: '13' },
  'Непл. отпуск': { from: 'days', code: '2' },
  'ДОД': { from: 'sums', code: '201' }, 'Корекция на ДОД': { from: 'sums', code: '220' },
  'Фонд Пенсии': { from: 'sums', code: '206' }, 'Фонд Безработица': { from: 'sums', code: '207' },
  'Здр.осиг.': { from: 'sums', code: '218' }, 'ОЗМ': { from: 'sums', code: '221' }, 'ДЗПО лице': { from: 'sums', code: '228' },
  'Ваучери храна': { from: 'sums', code: '1001' },
  'ФРЗ': { from: 'sums', code: 'ФРЗ' }, 'Осигурителен доход': { from: 'sums', code: 'ОД' },
  'Обл. сума': { from: 'sums', code: 'ОС' }, 'Сума за получаване': { from: 'sums', code: 'СП' },
}

/** One person-month as a salary-sheet row's `values`: only labels that have a value. */
export function sheetValues(m: PayrollMonth): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [label, { from, code }] of Object.entries(SHEET_LABELS)) {
    const v = m[from][code]
    if (v !== undefined) out[label] = v
  }
  return out
}

/**
 * Every month's sheet. A row carries the person's ЕГН as well (`personId`): the GUI sheet has none, which is why the importer joins
 * it to the declaration by surname and initials; from the archive it can join exactly.
 */
export function sheetsOfArchive(employees: ArchiveEmployee[], stamp: string): (SalarySheet & { rows: (SheetRow & { personId?: string })[] })[] {
  const byPeriod = new Map<string, (SheetRow & { personId?: string })[]>()
  for (const e of employees) for (const [period, m] of Object.entries(e.months)) {
    const values = sheetValues(m)
    if (!Object.keys(values).length) continue
    const personId = (e.params['ЕГН'] ?? '').trim()
    ;(byPeriod.get(period) ?? byPeriod.set(period, []).get(period)!).push({ period, name: (e.params['ИМЕ'] ?? e.key).trim(), values, ...(personId ? { personId } : {}) })
  }
  return [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, rows]) => ({ period, stamp, labels: ['Име', ...Object.keys(SHEET_LABELS)], rows }))
}

const dateOf = (s?: string) => {
  const t = (s ?? '').trim()
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t)
  return dotted ? `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}` : undefined
}
const amount = (s?: string) => { const t = (s ?? '').trim(); const n = Number(t.replace(',', '.')); return t !== '' && Number.isFinite(n) ? n : undefined }
const experience = (s?: string) => {
  const d = (s ?? '').replace(/\D/g, '')
  return d.length === 6 ? { years: Number(d.slice(0, 2)), months: Number(d.slice(2, 4)), days: Number(d.slice(4)) } : undefined
}

/** What „Персонал" exports: one row per engagement (ПЕРСОНАЛ node) of everyone with an ЕГН, as of `asOf` (YYYY-MM-DD). */
export function personnelOfArchive(employees: ArchiveEmployee[], asOf: string): PersonnelRow[] {
  return employees.filter(e => /^\d{9,10}$/.test((e.params['ЕГН'] ?? '').trim())).map(e => {
    const p = e.params, t = (k: string) => (p[k] ?? '').trim() || undefined
    return {
      name: (p['ИМЕ'] ?? e.key).trim(), personId: p['ЕГН'].trim(), asOf,
      startDate: dateOf(p['ПОСТЪПИЛ']), endDate: dateOf(p['НАПУСНАЛ']),
      salary: amount(p['ОСНЗАПЛ']), hoursPerDay: amount(p['РАБВРЕМЕ']), statutoryHours: amount(p['РАБВРЕМЕЗАК']),
      daysPerWeek: amount(p['РАБСЕДМ']), classPercent: amount(p['КЛАС']), experience: experience(p['ОСИГСТАЖ']),
      kid: t('ТДНКИД'), nkpd: t('ТДНКП'), position: t('ДЛЪЖНОСТ'),
      socialSecurityType: t('ВИДОСИГ'), healthSecurityType: t('ВИДЗДРОС'),
    }
  })
}
