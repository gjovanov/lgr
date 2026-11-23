import { Employee, PayrollRun, Payslip, Timesheet } from 'db/models'
import { buildSearchFilter } from '../search.utils.js'
import { employeeView, nationalIdLookup } from '../personal-data/employee-personal.js'
import { fromCents, toCents } from './bg/money.js'
import { payslipView, runView } from './bg/views.js'

/**
 * #830: the payroll lists, as the screens filter them, and as their Excel and PDF exports print them.
 *
 * One filter per list, used by the list's own GET and by its `/export`, so a file holds exactly the rows the list
 * shows, every page of them up to the export's cap.
 *
 * ⚠ What an export prints goes through the same allow-lists as the list's answer (`employeeView`, `payslipView`,
 * `runView` without the people), and then a column list of its own that is narrower still:
 *   - nothing sealed, under any engine (FR-25 §3.12): a sealed payslip's amounts and a run's lines open only through a
 *     reveal, which is audit-logged, one record at a time;
 *   - no pay of a person (#830's conservative choice): neither an employee's base salary nor a payslip's amounts,
 *     though the screens show both to the same role. A file of everyone's pay leaves the building in one click; the
 *     owner decides if it should, and then it is a column each. A run's totals stay, as `payroll-runs.view` reads them.
 *   - no identifier: not the masked ЕГН either.
 */

type Query = Record<string, unknown>
type Filter = Record<string, any>

/** A query value as the list reads it: a string, or nothing. A repeated parameter is its first value. */
function text(value: unknown): string {
  if (Array.isArray(value)) return text(value[0])
  return typeof value === 'string' ? value : ''
}

const OBJECT_ID = /^[a-f0-9]{24}$/i

/** The page's sort: one plain field name (a list sorts by a column's key), else the newest first. */
export function listSort(q: Query, fallback = 'createdAt'): Record<string, 1 | -1> {
  const by = text(q.sortBy)
  const field = /^[A-Za-z][\w.]{0,63}$/.test(by) ? by : fallback
  return { [field]: text(q.sortOrder) === 'asc' ? 1 : -1 }
}

/** The ids of this org's employees whose name or number holds every word of `search`. */
async function employeesMatching(orgId: string, search: string): Promise<unknown[]> {
  const filter = { orgId, ...buildSearchFilter(search, ['firstName', 'middleName', 'lastName', 'employeeNumber']) }
  const rows = await Employee.find(filter, { _id: 1 }).limit(5000).lean().exec()
  return rows.map(r => r._id)
}

export async function employeeListFilter(orgId: string, q: Query): Promise<Filter> {
  const filter: Filter = { orgId }
  const search = text(q.search)
  if (search) {
    Object.assign(filter, buildSearchFilter(search, ['firstName', 'middleName', 'lastName', 'email']))
    // An exact ЕГН finds its person through the lookup value, and nothing is opened to do it.
    if (/^\d{9,10}$/.test(search.trim())) {
      const lookup = await nationalIdLookup(orgId, search)
      if (lookup) filter.$or = [...(filter.$or ?? []), lookup]
    }
  }
  if (text(q.status)) filter.status = text(q.status)
  if (text(q.department)) filter.department = text(q.department)
  if (q.tags) {
    const tags = Array.isArray(q.tags) ? q.tags.map(String) : String(q.tags).split(',')
    filter.tags = { $in: tags.filter(Boolean) }
  }
  return filter
}

export function runListFilter(orgId: string, q: Query): Filter {
  const filter: Filter = { orgId }
  const search = text(q.search)
  if (search) Object.assign(filter, buildSearchFilter(search, ['name', 'period']))
  if (text(q.status)) filter.status = text(q.status)
  return filter
}

/** A payslip names no person of its own: the search finds the employees it is for. */
export async function payslipListFilter(orgId: string, q: Query): Promise<Filter> {
  const filter: Filter = { orgId }
  const search = text(q.search)
  const employee = text(q.employeeId)
  let ids: unknown[] | undefined = search ? await employeesMatching(orgId, search) : undefined
  if (OBJECT_ID.test(employee)) ids = ids ? ids.filter(id => String(id) === employee) : [employee]
  if (ids) filter.employeeId = { $in: ids }
  if (text(q.status)) filter.status = text(q.status)
  return filter
}

/** The search finds the employee or the entry's own description; the employee and the days narrow it. */
export async function timesheetListFilter(orgId: string, q: Query): Promise<Filter> {
  const filter: Filter = { orgId }
  const search = text(q.search)
  if (search) {
    filter.$and = [{ $or: [{ employeeId: { $in: await employeesMatching(orgId, search) } }, buildSearchFilter(search, ['description'])] }]
  }
  const employee = text(q.employeeId)
  if (OBJECT_ID.test(employee)) filter.employeeId = employee
  const from = dayOf(text(q.dateFrom))
  const to = dayOf(text(q.dateTo))
  if (from || to) {
    filter.date = {}
    if (from) filter.date.$gte = from
    // The whole of the last day.
    if (to) filter.date.$lt = new Date(to.getTime() + 24 * 60 * 60 * 1000)
  }
  if (text(q.status)) filter.status = text(q.status)
  return filter
}

/** `YYYY-MM-DD` as that day's UTC midnight, or null. */
function dayOf(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

// ── The exports ──────────────────────────────────────────────────────────────

export type PayrollListKind = 'employees' | 'runs' | 'payslips' | 'timesheets'
export type ExportCellType = 'text' | 'money' | 'quantity' | 'int' | 'date'

export interface ExportColumn {
  key: string
  header: string
  type?: ExportCellType
  width?: number
}

/** What the screen sends in its words (`labels`, JSON): every one optional, English when missing. */
export interface ExportLabels {
  title?: string
  columns?: Record<string, string>
  /** Per column: stored value → the word the screen shows for it (a status, a type). */
  values?: Record<string, Record<string, string>>
  /** Per filter: its name in the header block of a PDF. */
  filters?: Record<string, string>
  meta?: { period?: string; generated?: string; rows?: string; noRows?: string }
  totals?: string
}

export interface PayrollListTable {
  kind: PayrollListKind
  title: string
  columns: ExportColumn[]
  rows: Record<string, unknown>[]
  totals?: Record<string, number>
  totalsLabel?: string
  currency?: string
  period?: { from?: string; to?: string }
  /** What the list was filtered by, for the header block of a PDF. */
  filters: Array<{ label: string; value: string }>
  meta?: ExportLabels['meta']
  truncated: boolean
}

/** The labels the screen sent, or none: never trusted beyond being words. */
export function exportLabels(raw: unknown): ExportLabels {
  if (typeof raw !== 'string' || raw.length > 20_000) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ExportLabels : {}
  } catch {
    // Not JSON: the export prints its English words.
    return {}
  }
}

const word = (map: Record<string, string> | undefined, key: string, fallback: string): string =>
  (map && typeof map[key] === 'string' && map[key]) || fallback

const DEFAULT_TITLES: Record<PayrollListKind, string> = {
  employees: 'Employees',
  runs: 'Payroll runs',
  payslips: 'Payslips',
  timesheets: 'Timesheets',
}

const COLUMNS: Record<PayrollListKind, ReadonlyArray<readonly [string, string, ExportCellType?, number?]>> = {
  employees: [
    ['employeeNumber', 'Employee number'],
    ['name', 'Name', 'text', 32],
    ['department', 'Department'],
    ['position', 'Position'],
    ['employmentType', 'Employment type'],
    ['status', 'Status'],
    ['contractStartDate', 'Contract start', 'date'],
  ],
  runs: [
    ['name', 'Name', 'text', 28],
    ['periodFrom', 'From', 'date'],
    ['periodTo', 'To', 'date'],
    ['status', 'Status'],
    ['employeeCount', 'Employees', 'int'],
    ['grossPay', 'Gross pay', 'money'],
    ['totalDeductions', 'Deductions', 'money'],
    ['netPay', 'Net pay', 'money'],
    ['totalEmployerCost', 'Employer cost', 'money'],
    ['currency', 'Currency'],
  ],
  payslips: [
    ['employee', 'Employee', 'text', 32],
    ['employeeNumber', 'Employee number'],
    ['periodFrom', 'From', 'date'],
    ['periodTo', 'To', 'date'],
    ['status', 'Status'],
    ['paymentMethod', 'Payment method'],
  ],
  timesheets: [
    ['employee', 'Employee', 'text', 32],
    ['date', 'Date', 'date'],
    ['hoursWorked', 'Hours worked', 'quantity'],
    ['overtimeHours', 'Overtime', 'quantity'],
    ['type', 'Type'],
    ['status', 'Status'],
    ['description', 'Description', 'text', 36],
  ],
}

/** Which columns print a stored value as the screen's word for it. */
const WORDED = new Set(['status', 'employmentType', 'type', 'paymentMethod'])

const personName = (e: { firstName?: string; middleName?: string; lastName?: string } | undefined) =>
  e ? [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ') : ''

const isoDay = (d: unknown): string | undefined => {
  if (!d) return undefined
  const date = d instanceof Date ? d : new Date(String(d))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

/** This org's employees by id, for the lists whose rows name one: name and number only. */
async function employeesById(orgId: string, ids: unknown[]): Promise<Map<string, { name: string; number: string }>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))].filter(id => OBJECT_ID.test(id))
  if (!unique.length) return new Map()
  const rows = await Employee.find({ orgId, _id: { $in: unique } }, { firstName: 1, middleName: 1, lastName: 1, employeeNumber: 1 }).lean().exec()
  return new Map(rows.map(r => [String(r._id), { name: personName(r), number: r.employeeNumber ?? '' }]))
}

/** The rows of one list, filtered and sorted as the screen asked, at most `cap` of them. */
async function rowsOf(kind: PayrollListKind, orgId: string, q: Query, cap: number): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; currencies: Set<string> }> {
  const currencies = new Set<string>()
  const cut = <T>(docs: T[]) => ({ docs: docs.slice(0, cap), truncated: docs.length > cap })

  if (kind === 'employees') {
    const { docs, truncated } = cut(await Employee.find(await employeeListFilter(orgId, q)).sort(listSort(q)).limit(cap + 1).lean().exec())
    const rows = docs.map(doc => {
      const e = employeeView(doc)
      return {
        employeeNumber: e.employeeNumber ?? '',
        name: personName(e),
        department: e.department ?? '',
        position: e.position ?? '',
        employmentType: e.employmentType ?? '',
        status: e.status ?? '',
        contractStartDate: e.contractStartDate,
      }
    })
    return { rows, truncated, currencies }
  }

  if (kind === 'runs') {
    const { docs, truncated } = cut(await PayrollRun.find(runListFilter(orgId, q)).sort(listSort(q)).limit(cap + 1).lean().exec())
    const rows = docs.map(doc => {
      // Never the people: totals are what `payroll-runs.view` reads (FR-25 §3.11).
      const run = runView(doc, false)
      if (run.currency) currencies.add(String(run.currency))
      return {
        name: run.name ?? '',
        periodFrom: run.period?.from,
        periodTo: run.period?.to,
        status: run.status ?? '',
        employeeCount: run.totals?.employeeCount ?? 0,
        grossPay: run.totals?.grossPay ?? 0,
        totalDeductions: run.totals?.totalDeductions ?? 0,
        netPay: run.totals?.netPay ?? 0,
        totalEmployerCost: run.totals?.totalEmployerCost ?? 0,
        currency: run.currency ?? '',
      }
    })
    return { rows, truncated, currencies }
  }

  if (kind === 'payslips') {
    const { docs, truncated } = cut(await Payslip.find(await payslipListFilter(orgId, q)).sort(listSort(q)).limit(cap + 1).lean().exec())
    const people = await employeesById(orgId, docs.map(d => d.employeeId))
    const rows = docs.map(doc => {
      const slip = payslipView(doc)
      const person = people.get(String(slip.employeeId))
      return {
        employee: person?.name ?? '',
        employeeNumber: person?.number ?? '',
        periodFrom: slip.period?.from,
        periodTo: slip.period?.to,
        status: slip.status ?? '',
        paymentMethod: slip.paymentMethod ?? '',
      }
    })
    return { rows, truncated, currencies }
  }

  const { docs, truncated } = cut(await Timesheet.find(await timesheetListFilter(orgId, q)).sort(listSort(q)).limit(cap + 1).lean().exec())
  const people = await employeesById(orgId, docs.map(d => d.employeeId))
  const rows = docs.map(doc => ({
    employee: people.get(String(doc.employeeId))?.name ?? '',
    date: doc.date,
    hoursWorked: doc.hoursWorked ?? 0,
    overtimeHours: doc.overtimeHours ?? 0,
    type: doc.type ?? '',
    status: doc.status ?? '',
    description: doc.description ?? '',
  }))
  return { rows, truncated, currencies }
}

/** What a list was filtered by, in the screen's words, for a PDF's header block. */
async function filtersOf(kind: PayrollListKind, orgId: string, q: Query, labels: ExportLabels): Promise<PayrollListTable['filters']> {
  const out: PayrollListTable['filters'] = []
  const add = (key: string, fallback: string, value: string) => {
    if (value) out.push({ label: word(labels.filters, key, fallback), value })
  }
  add('search', 'Search', text(q.search).trim())
  add('status', 'Status', text(q.status) ? word(labels.values?.status, text(q.status), text(q.status)) : '')
  if (kind === 'employees') {
    add('department', 'Department', text(q.department))
    add('tags', 'Tags', Array.isArray(q.tags) ? q.tags.map(String).join(', ') : text(q.tags).split(',').filter(Boolean).join(', '))
  }
  const employee = text(q.employeeId)
  if (OBJECT_ID.test(employee)) add('employee', 'Employee', (await employeesById(orgId, [employee])).get(employee)?.name ?? '')
  return out
}

/**
 * One list as an export prints it: the screen's columns and filters, in the screen's words, every row up to `cap`.
 * `truncated` says the cap cut it, so a file never passes for the whole list.
 */
export async function payrollListTable(kind: PayrollListKind, orgId: string, q: Query, cap: number): Promise<PayrollListTable> {
  const labels = exportLabels(q.labels)
  const { rows, truncated, currencies } = await rowsOf(kind, orgId, q, cap)

  const columns: ExportColumn[] = COLUMNS[kind].map(([key, header, type, width]) => ({
    key,
    header: word(labels.columns, key, header),
    ...(type ? { type } : {}),
    ...(width ? { width } : {}),
  }))
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (WORDED.has(key) && typeof row[key] === 'string' && row[key]) row[key] = word(labels.values?.[key], String(row[key]), String(row[key]))
    }
  }

  // Money is summed only in one currency: a sum across two means nothing. Hours always are. In whole cents (`money.ts`).
  let totals: Record<string, number> | undefined
  const sum = (key: string) => fromCents(rows.reduce((n, r) => n + toCents(Number(r[key]) || 0), 0))
  if (kind === 'runs' && rows.length && currencies.size === 1) {
    totals = { employeeCount: sum('employeeCount'), grossPay: sum('grossPay'), totalDeductions: sum('totalDeductions'), netPay: sum('netPay'), totalEmployerCost: sum('totalEmployerCost') }
  }
  if (kind === 'timesheets' && rows.length) totals = { hoursWorked: sum('hoursWorked'), overtimeHours: sum('overtimeHours') }

  const from = kind === 'timesheets' ? isoDay(dayOf(text(q.dateFrom))) : undefined
  const to = kind === 'timesheets' ? isoDay(dayOf(text(q.dateTo))) : undefined

  return {
    kind,
    title: typeof labels.title === 'string' && labels.title ? labels.title : DEFAULT_TITLES[kind],
    columns,
    rows,
    ...(totals ? { totals, totalsLabel: typeof labels.totals === 'string' && labels.totals ? labels.totals : 'Total' } : {}),
    ...(kind === 'runs' && currencies.size === 1 ? { currency: [...currencies][0] } : {}),
    ...(from || to ? { period: { from, to } } : {}),
    filters: await filtersOf(kind, orgId, q, labels),
    ...(labels.meta && typeof labels.meta === 'object' ? { meta: labels.meta } : {}),
    truncated,
  }
}
