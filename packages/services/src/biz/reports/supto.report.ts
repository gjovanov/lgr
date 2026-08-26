/**
 * FR-06 (#14) P2 — the SUPTO (НАП, Наредба Н-18 Приложение 29) tables 18.1–18.9 in the
 * report catalog.
 *
 * ⚠ These are the ONE part of the catalog that is deliberately NOT a registry handler.
 *
 * The reason is legal, not architectural: each table's XLSX layout — sheet name, column
 * order, header wording, cell types — is prescribed by Appendix 29 and already implemented,
 * table by table, in `reporting/excel/supto.excel.ts` behind `/supto/export/:tableId`.
 * Rendering them through the GENERIC report renderer would produce a different, prettier,
 * non-compliant workbook. So the entries carry `view: 'custom'` and point at a dedicated
 * page that drives the existing endpoint, byte-for-byte as before (FR-6.20).
 *
 * What this closes is the actual gap the issue names: the tables existed only behind an API,
 * unreachable from any UI — a real problem during an inspection, when an auditor is sitting
 * in front of the screen. Now they are nine cards in the catalog, visible to exactly the two
 * roles the endpoint allows.
 *
 * 18.9 (nomenclatures) is a snapshot, not a period — it is the one table whose page must not
 * demand a date range, which is why `needsPeriod` rides along on the definition.
 */

export interface SuptoTableDef {
  /** Registry id — `supto-18-1`. The endpoint wants the dotted form. */
  id: string
  /** The `:tableId` path segment of `/supto/export/:tableId`. */
  tableId: string
  labelKey: string
  descriptionKey: string
  /** 18.9 is a nomenclature snapshot; every other table is period-scoped. */
  needsPeriod: boolean
}

const TABLES: Array<[string, boolean]> = [
  ['18.1', true],
  ['18.2', true],
  ['18.3', true],
  ['18.4', true],
  ['18.5', true],
  ['18.6', true],
  ['18.7', true],
  ['18.8', true],
  ['18.9', false],
]

export const SUPTO_TABLES: SuptoTableDef[] = TABLES.map(([tableId, needsPeriod]) => {
  const slug = tableId.replace('.', '-')
  return {
    id: `supto-${slug}`,
    tableId,
    labelKey: `reports.supto.t${slug.replace('-', '_')}.label`,
    descriptionKey: `reports.supto.t${slug.replace('-', '_')}.description`,
    needsPeriod,
  }
})

/** Roles the SUPTO endpoint itself allows — mirrored so the catalog cannot drift from it. */
export const SUPTO_ROLES = ['admin', 'nra_auditor']

/**
 * The permission behind the tables. `admin.audit` is what `nra_auditor` holds and what a
 * `manager` does NOT — which is precisely the case `roles` was added for, kept belt-and-braces
 * because a custom permission set could hand `admin.audit` to someone outside those roles.
 */
export const SUPTO_PERMISSION = 'admin.audit'
