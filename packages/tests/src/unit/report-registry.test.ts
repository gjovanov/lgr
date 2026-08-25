import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models) — this file must never boot Mongoose, same reasoning
// as amount-in-words.test.ts. The registry ITSELF imports models, so only the types module
// may be pulled in here; the gate and validator are re-exercised against hand-built entries.
import {
  resolvePeriod,
  rowCapFor,
  isIsoDate,
  canAccessReport,
  validateParams,
  toReportMeta,
  ReportParamError,
  TABLE_ROW_CAP,
  XLSX_ROW_CAP,
  PDF_ROW_CAP,
  type ReportEntry,
  type ReportMeta,
} from 'services/biz/report-registry.types'

/**
 * FR-6.6/6.7 — the registry's guarantees, tested against hand-built entries so no real
 * report's shape can make this pass or fail by accident:
 *  1. the gate hides a report a caller may not run (permission AND, when present, role);
 *  2. param validation coerces what it understands and rejects what it does not;
 *  3. the wire projection never leaks the gate.
 *
 * The LIVE registry (real entries, real handlers) is covered by reports.flow.test.ts.
 */

/** Minimal well-formed entry; each test overrides only what it is about. */
function entry(over: Partial<ReportEntry> = {}): ReportEntry {
  return {
    id: 'test', category: 'inventory', labelKey: 'l', descriptionKey: 'd', icon: 'mdi-x',
    outputs: ['table'], params: [], view: 'runner', route: '/test',
    permission: 'inventory.read',
    ...over,
  }
}

// ── period presets (FR-6.11) ────────────────────────────────────────────────

describe('resolvePeriod', () => {
  // A fixed Wednesday, so week/month/quarter maths is deterministic.
  const now = new Date(2026, 7, 19) // 2026-08-19

  it('resolves today to a single day', () => {
    expect(resolvePeriod({ preset: 'today' }, now)).toEqual({ from: '2026-08-19', to: '2026-08-19' })
  })

  it('resolves this_week Monday-to-Sunday (ISO)', () => {
    expect(resolvePeriod({ preset: 'this_week' }, now)).toEqual({ from: '2026-08-17', to: '2026-08-23' })
  })

  it('resolves this_month to the calendar month', () => {
    expect(resolvePeriod({ preset: 'this_month' }, now)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('resolves last_month across the boundary', () => {
    expect(resolvePeriod({ preset: 'last_month' }, now)).toEqual({ from: '2026-07-01', to: '2026-07-31' })
  })

  it('resolves last_month in January to the previous December', () => {
    expect(resolvePeriod({ preset: 'last_month' }, new Date(2026, 0, 15)))
      .toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('resolves this_quarter to Q3', () => {
    expect(resolvePeriod({ preset: 'this_quarter' }, now)).toEqual({ from: '2026-07-01', to: '2026-09-30' })
  })

  it('resolves this_year to the calendar year', () => {
    expect(resolvePeriod({ preset: 'this_year' }, now)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('passes custom bounds through, dropping malformed ones', () => {
    expect(resolvePeriod({ preset: 'custom', from: '2026-01-05', to: '2026-02-09' }, now))
      .toEqual({ from: '2026-01-05', to: '2026-02-09' })
    expect(resolvePeriod({ preset: 'custom', from: 'last tuesday', to: '2026-02-09' }, now))
      .toEqual({ from: undefined, to: '2026-02-09' })
  })

  it('treats a missing value as custom-with-nothing', () => {
    expect(resolvePeriod(undefined, now)).toEqual({ from: undefined, to: undefined })
  })
})

describe('isIsoDate', () => {
  it('accepts only YYYY-MM-DD', () => {
    expect(isIsoDate('2026-08-19')).toBe(true)
    expect(isIsoDate('19.08.2026')).toBe(false)
    expect(isIsoDate('2026-8-9')).toBe(false)
    expect(isIsoDate(20260819)).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })
})

// ── row caps (FR-6.15) ──────────────────────────────────────────────────────

describe('rowCapFor', () => {
  it('caps each surface at its own limit', () => {
    expect(rowCapFor('table')).toBe(TABLE_ROW_CAP)
    expect(rowCapFor('xlsx')).toBe(XLSX_ROW_CAP)
    expect(rowCapFor('pdf')).toBe(PDF_ROW_CAP)
  })

  it('keeps the PDF cap below the XLSX one', () => {
    // A PDF paginates what a spreadsheet scrolls, so it must be the tighter of the two.
    expect(PDF_ROW_CAP).toBeLessThan(XLSX_ROW_CAP)
    expect(TABLE_ROW_CAP).toBeLessThanOrEqual(PDF_ROW_CAP)
  })
})

// ── the wire contract (FR-6.6) ──────────────────────────────────────────────

// ── the gate (FR-6.7) ───────────────────────────────────────────────────────

describe('canAccessReport', () => {
  it('requires the report permission', () => {
    const e = entry({ permission: 'inventory.read' })
    expect(canAccessReport(e, { role: 'warehouse_manager', permissions: ['inventory.read'] })).toBe(true)
    expect(canAccessReport(e, { role: 'accountant', permissions: ['invoicing.read'] })).toBe(false)
  })

  it('matches permissions exactly — no prefix or wildcard expansion', () => {
    const e = entry({ permission: 'inventory.read' })
    expect(canAccessReport(e, { role: 'member', permissions: ['inventory.write'] })).toBe(false)
    expect(canAccessReport(e, { role: 'member', permissions: ['inventory'] })).toBe(false)
  })

  it('lets admin through without the explicit permission', () => {
    expect(canAccessReport(entry({ permission: 'inventory.read' }), { role: 'admin', permissions: [] })).toBe(true)
  })

  it('applies `roles` ON TOP of the permission, never instead of it', () => {
    // The SUPTO case (P2): a manager holds every module permission and must STILL be shut out.
    const supto = entry({ permission: 'invoicing.read', roles: ['admin', 'nra_auditor'] })
    expect(canAccessReport(supto, { role: 'manager', permissions: ['invoicing.read'] })).toBe(false)
    expect(canAccessReport(supto, { role: 'nra_auditor', permissions: ['invoicing.read'] })).toBe(true)
    // …and the role alone is not enough either.
    expect(canAccessReport(supto, { role: 'nra_auditor', permissions: [] })).toBe(false)
  })

  it('denies an anonymous caller', () => {
    expect(canAccessReport(entry(), null)).toBe(false)
    expect(canAccessReport(entry(), undefined)).toBe(false)
  })
})

// ── parameter validation (FR-6.6) ───────────────────────────────────────────

describe('validateParams', () => {
  it('drops keys the entry does not declare', () => {
    // Nothing a caller invents may reach a handler and steer its query.
    const out = validateParams(entry({ params: [{ key: 'warehouseId', type: 'warehouse', labelKey: 'w' }] }), {
      warehouseId: 'wh1',
      orgId: 'someone-elses-org',
      $where: 'sleep(1000)',
    })
    expect(out).toEqual({ warehouseId: 'wh1' })
  })

  it('applies defaults for omitted params', () => {
    const e = entry({ params: [{ key: 'includeZero', type: 'bool', labelKey: 'z', default: false }] })
    expect(validateParams(e, {})).toEqual({ includeZero: false })
    expect(validateParams(e, undefined)).toEqual({ includeZero: false })
  })

  it('coerces bools from their query-string forms', () => {
    const e = entry({ params: [{ key: 'z', type: 'bool', labelKey: 'z' }] })
    expect(validateParams(e, { z: 'true' }).z).toBe(true)
    expect(validateParams(e, { z: '1' }).z).toBe(true)
    expect(validateParams(e, { z: 'false' }).z).toBe(false)
    expect(validateParams(e, { z: 'no' }).z).toBe(false)
  })

  it('rejects a malformed date', () => {
    const e = entry({ params: [{ key: 'asOf', type: 'date', labelKey: 'd' }] })
    expect(validateParams(e, { asOf: '2026-08-19' })).toEqual({ asOf: '2026-08-19' })
    expect(() => validateParams(e, { asOf: '19.08.2026' })).toThrow(ReportParamError)
  })

  it('rejects a select value outside its options', () => {
    const e = entry({
      params: [{
        key: 'mode', type: 'select', labelKey: 'm',
        options: [{ value: 'a', labelKey: 'a' }, { value: 'b', labelKey: 'b' }],
      }],
    })
    expect(validateParams(e, { mode: 'b' })).toEqual({ mode: 'b' })
    expect(() => validateParams(e, { mode: 'c' })).toThrow(ReportParamError)
  })

  it('rejects a required param with neither value nor default', () => {
    const e = entry({ params: [{ key: 'productId', type: 'product', labelKey: 'p', required: true }] })
    expect(() => validateParams(e, {})).toThrow(/Missing required parameter: productId/)
  })

  it('re-resolves a period preset server-side, ignoring client-supplied bounds', () => {
    const e = entry({ params: [{ key: 'period', type: 'period', labelKey: 'p' }] })
    // The client says "this_month" but also sends bounds from 1998; the preset wins.
    const out = validateParams(e, { period: { preset: 'this_month', from: '1998-01-01', to: '1998-01-31' } })
    expect(out.period.from).not.toBe('1998-01-01')
    expect(out.period.from).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('rejects an inverted custom period', () => {
    const e = entry({ params: [{ key: 'period', type: 'period', labelKey: 'p' }] })
    expect(() => validateParams(e, { period: { preset: 'custom', from: '2026-09-01', to: '2026-08-01' } }))
      .toThrow(/after its end/)
  })
})

// ── the wire contract (FR-6.6) ──────────────────────────────────────────────

describe('toReportMeta', () => {
  it('strips every server-only field', () => {
    const meta: ReportMeta = toReportMeta(entry({
      permission: 'inventory.read',
      roles: ['admin'],
      handler: async () => ({ columns: [], rows: [] }),
      drilldown: () => '/x',
    }))
    expect(Object.keys(meta)).not.toContain('permission')
    expect(Object.keys(meta)).not.toContain('roles')
    expect(Object.keys(meta)).not.toContain('handler')
    expect(Object.keys(meta)).not.toContain('drilldown')
    expect(meta.id).toBe('test')
    expect(meta.route).toBe('/test')
  })
})
