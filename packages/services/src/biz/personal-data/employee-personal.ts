import { Employee } from 'db/models'
import { logger } from '../../logger/logger.js'
import { maskIdentifier } from './crypto.js'
import { forOrg, personalDataKeyPresent } from './personal-data.service.js'

/**
 * FR-25 §3.12: what is sensitive about one employee. It all lives in one sealed JSON on the document
 * (`Employee.personal`), so adding a field needs no schema change and no migration.
 */
export const EMPLOYEE_PERSONAL_KEYS = [
  'identifierType', 'nationalId', 'taxId', 'dateOfBirth', 'address', 'emergencyContact',
  'idCard', 'education', 'retiree', 'disabled', 'childRelief', 'isMainEmployer', 'insuredAtMaxElsewhere',
  'paymentMethod', 'iban', 'bic', 'bankName', 'bankAccountNumber',
] as const
export type EmployeePersonalKey = (typeof EMPLOYEE_PERSONAL_KEYS)[number]
export type EmployeePersonal = Partial<Record<EmployeePersonalKey, any>>

const MODEL = 'Employee'
const PATH = 'personal'
const KEYS = new Set<string>(EMPLOYEE_PERSONAL_KEYS)

/**
 * What a route may send of an employee. A list of what is allowed, not of what is not: a field added
 * to the model stays out of every response until someone decides otherwise, and a row not yet swept
 * (`sealPlainEmployees`) shows nothing it still holds in clear.
 */
const VIEW_KEYS = [
  '_id', 'id', 'orgId', 'userId', 'employeeNumber', 'firstName', 'middleName', 'lastName', 'email', 'phone', 'gender',
  'nationalIdMask', 'department', 'position', 'managerId', 'employmentType', 'contractStartDate', 'contractEndDate',
  'probationEndDate', 'status', 'terminationDate', 'terminationReason', 'deductions', 'benefits', 'documents', 'notes',
  'tags', 'createdAt', 'updatedAt',
] as const
const SALARY_VIEW_KEYS = ['baseSalary', 'currency', 'frequency', 'hourlyRate'] as const

export function employeeView(doc: any): any {
  if (!doc) return doc
  const source = typeof doc.toObject === 'function' ? doc.toObject() : doc
  const out: any = {}
  for (const k of VIEW_KEYS) if (source[k] !== undefined) out[k] = source[k]
  if (source.salary) {
    out.salary = {}
    for (const k of SALARY_VIEW_KEYS) if (source.salary[k] !== undefined) out.salary[k] = source.salary[k]
  }
  out.hasPersonal = !!source.personal
  return out
}

/** Keeps only known keys. An empty string means "not touched"; `null` is how a value is cleared. */
export function cleanPersonalPatch(patch: Record<string, unknown> | undefined | null): EmployeePersonal {
  const out: EmployeePersonal = {}
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (KEYS.has(k) && v !== '' && v !== undefined) (out as any)[k] = v
  }
  return out
}

/** The fields to write for this patch: the sealed record, with its mask and lookup when the ЕГН changed. */
export async function sealedEmployeeFields(
  orgId: unknown,
  docId: string,
  current: string | undefined | null,
  patch: EmployeePersonal,
): Promise<{ personal: string; nationalIdMask?: string | null; nationalIdHmac?: string | null }> {
  const vault = await forOrg(orgId)
  const merged: EmployeePersonal = current ? vault.open<EmployeePersonal>(MODEL, docId, PATH, current) : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (merged as any)[k]
    else (merged as any)[k] = v
  }
  const fields: { personal: string; nationalIdMask?: string | null; nationalIdHmac?: string | null } = {
    personal: vault.seal(MODEL, docId, PATH, merged),
  }
  if ('nationalId' in patch) {
    const id = merged.nationalId ? String(merged.nationalId) : ''
    fields.nationalIdMask = id ? maskIdentifier(id) : null
    fields.nationalIdHmac = id ? vault.blindIndex('nationalId', id) : null
  }
  return fields
}

export async function openEmployeePersonal(orgId: unknown, doc: { id?: string; _id?: unknown; personal?: string | null }): Promise<EmployeePersonal> {
  if (!doc.personal) return {}
  const vault = await forOrg(orgId)
  return vault.open<EmployeePersonal>(MODEL, String(doc.id ?? doc._id), PATH, doc.personal)
}

/** Only the fields asked for, so that an audit row saying "IBAN" means only the IBAN left the vault. */
export async function revealEmployeeFields(orgId: unknown, doc: any, fields: string[]): Promise<EmployeePersonal> {
  const opened = await openEmployeePersonal(orgId, doc)
  const out: EmployeePersonal = {}
  for (const f of fields) {
    if (KEYS.has(f) && (opened as any)[f] !== undefined) (out as any)[f] = (opened as any)[f]
  }
  return out
}

/** The clause matching an exact ЕГН, or null when this org's keys cannot be opened here. */
export async function nationalIdLookup(orgId: unknown, value: string): Promise<Record<string, string> | null> {
  try {
    const vault = await forOrg(orgId)
    return { nationalIdHmac: vault.blindIndex('nationalId', value) }
  } catch {
    return null
  }
}

/** Where these fields lived in clear, before FR-25. */
const LEGACY_PATHS: ReadonlyArray<readonly [string, EmployeePersonalKey]> = [
  ['nationalId', 'nationalId'], ['taxId', 'taxId'], ['dateOfBirth', 'dateOfBirth'], ['address', 'address'],
  ['emergencyContact', 'emergencyContact'], ['salary.iban', 'iban'], ['salary.bankName', 'bankName'],
  ['salary.bankAccountNumber', 'bankAccountNumber'],
]

const readPath = (doc: any, path: string) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc)

/**
 * Seals what older rows still hold in clear. Runs at startup and is safe to run every time: a row
 * done once no longer matches. It reads the raw collection, because the schema no longer knows those
 * paths. Without a key it leaves the rows and says so; `employeeView` keeps them out of every response.
 */
export async function sealPlainEmployees(orgFilter: Record<string, unknown> = {}): Promise<{ sealed: number; waiting: number }> {
  const query = { ...orgFilter, $or: LEGACY_PATHS.map(([p]) => ({ [p]: { $exists: true } })) }
  if (!personalDataKeyPresent()) {
    const waiting = await Employee.collection.countDocuments(query)
    if (waiting) logger.warn({ waiting }, 'Employees hold personal data in clear, and PERSONAL_DATA_KEK is not set to seal it')
    return { sealed: 0, waiting }
  }
  let sealed = 0
  for await (const doc of Employee.collection.find(query)) {
    const patch: EmployeePersonal = {}
    const unset: Record<string, ''> = {}
    for (const [path, key] of LEGACY_PATHS) {
      const value = readPath(doc, path)
      if (value !== undefined) unset[path] = ''
      if (value !== undefined && value !== null && value !== '') (patch as any)[key] = value instanceof Date ? value.toISOString().slice(0, 10) : value
    }
    const fields = Object.keys(patch).length
      ? await sealedEmployeeFields(doc.orgId, String(doc._id), (doc as any).personal, patch)
      : {}
    // `strict: false`: the paths being removed are no longer in the schema, which would drop the $unset.
    await Employee.updateOne({ _id: doc._id }, { $set: fields, $unset: unset }, { strict: false }).exec()
    sealed++
  }
  if (sealed) logger.info({ sealed }, 'Employees: personal data sealed')
  return { sealed, waiting: 0 }
}
