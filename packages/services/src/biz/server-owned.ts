import { ValidationError } from 'dal'

/**
 * What a request body may not choose on a document.
 *
 * Twelve controllers store the body as the document: `POST /` creates `{ ...body, orgId }` and
 * `PUT /:id` sets every field the body names. Across orgs that is closed below the routes (a
 * body cannot move a document, S-25, or name another org's record, S-35). Inside the org it left
 * the fields the SERVER sets open to anyone holding the module's write permission: a count
 * marked completed without its stock adjustment, a payment order marked executed, a renumbered
 * order, somebody else's name on `createdBy`, a backdated `createdAt`.
 *
 * The rule: a body may RESTATE such a field, never choose it.
 *   - `clientCreate`: empty, or the value a new document starts with anyway (`initial`);
 *   - `clientUpdate`: the value the stored document already holds.
 * Anything else is refused with 422 `server_owned_field`, naming the field. Refused, not
 * dropped: a caller that asked for `status: 'completed'` and got 200 would believe it. A form
 * that sends a document back as it loaded it still saves.
 *
 * ⚠ Both also refuse update syntax in a body (`$set`, `lines.0.varianceCost`). A body is data;
 * `updateInOrg` puts it in a `$set`, where a dotted key writes inside a field the handler has
 * just computed (a count line's cost), past every check made on the top-level keys.
 *
 * ⚠ What is listed is what a server path sets (a number, an actor, a lifecycle step, a seal, a
 * ledger link) or what says WHO did something. A status the screens change with a plain save
 * (a fiscal year's lock, a timesheet's approval, a fixed asset's disposal) stays the body's;
 * the stamp beside it (`approvedBy`) is the server's, and the controller sets it.
 *
 * Import-pure, apart from `dal`'s error class.
 */
export class ServerOwnedFieldError extends Error {
  readonly statusCode = 422
  readonly code = 'server_owned_field'
  constructor(public path: string) {
    super(`${path}: set by the server, not by the request`)
    this.name = 'ServerOwnedFieldError'
  }
}

/** On every document: its identity, its org and its timestamps. */
export const ALWAYS_SERVER_OWNED = ['_id', 'id', 'orgId', '__v', 'createdAt', 'updatedAt'] as const

/**
 * Per model (the Mongoose model name), the fields only the server sets.
 * `unit/server-owned.test.ts` holds every name to the model's schema, and every controller that
 * stores a raw body to an entry here.
 */
export const SERVER_OWNED = {
  // Accounting.
  BankAccount: [],
  ExchangeRate: [],
  FiscalPeriod: [],
  // The year-end closing entry is posted by the server.
  FiscalYear: ['closingEntryId'],
  // What marks an asset the books import made (FR-25a §4.2): a body that could set them could hand a hand-kept asset to
  // the next import to overwrite, or point an asset at an analytic that is not its own.
  FixedAsset: ['sourceModule', 'importKey', 'analyticId'],
  // Who completed it and when: stamped by the controller when the status becomes `completed`.
  BankReconciliation: ['reconciledBy', 'reconciledAt'],
  // Invoicing.
  CashOrder: ['orderNumber', 'createdBy', 'journalEntryId'],
  // `executed` is `POST /:id/execute`.
  PaymentOrder: ['orderNumber', 'createdBy', 'status', 'executedAt', 'executedBy', 'journalEntryId'],
  // Payroll. A sealed slip is what a run generated (FR-25 §3.12).
  Payslip: ['engine', 'sealed'],
  // Stamped by the controller when the status becomes `approved`.
  Timesheet: ['approvedBy'],
  // Inventory. `completed` is `POST /:id/complete`, which books the adjustment it links, under a hold it takes.
  InventoryCount: ['countNumber', 'createdBy', 'status', 'completedBy', 'completedAt', 'adjustmentMovementId', 'leaseUntil'],
  // Follows `isActive`: set by the controller.
  PriceList: ['deactivatedAt'],
} as const satisfies Record<string, readonly string[]>

export type OwnedModel = keyof typeof SERVER_OWNED

const isEmpty = (v: unknown) => v === undefined || v === null || v === ''

/** Whether a body's value says what the server already holds. A body is JSON: ids and dates arrive as strings. */
function same(asked: unknown, held: unknown): boolean {
  if (isEmpty(asked) && isEmpty(held)) return true
  if (isEmpty(asked) || isEmpty(held)) return false
  // An object or an array is never one of these fields: each is an id, a date, a number or a word.
  if (typeof asked === 'object') return false
  if (held instanceof Date) {
    const at = typeof asked === 'string' || typeof asked === 'number' ? new Date(asked).getTime() : Number.NaN
    return at === held.getTime()
  }
  return String(asked) === String(held)
}

function fieldsOf(model: OwnedModel, body: unknown): Array<[string, unknown]> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('A document body is a JSON object')
  }
  const entries = Object.entries(body as Record<string, unknown>)
  const syntax = entries.map(([k]) => k).filter(k => k.startsWith('$') || k.includes('.'))
  if (syntax.length) {
    throw new ValidationError(`Update operators and field paths are not accepted in a document body: ${syntax.join(', ')}`)
  }
  if (!(model in SERVER_OWNED)) throw new Error(`No server-owned fields are declared for ${String(model)}`)
  return entries
}

const owned = (model: OwnedModel): ReadonlySet<string> => new Set<string>([...ALWAYS_SERVER_OWNED, ...SERVER_OWNED[model]])

/**
 * The fields of a new document that are the body's to give. `initial` is what the server is
 * about to set (`orgId`, `createdBy`, a default status): a body may say the same.
 */
export function clientCreate(model: OwnedModel, body: unknown, initial: Record<string, unknown> = {}): Record<string, any> {
  const mine = owned(model)
  const out: Record<string, any> = {}
  for (const [key, value] of fieldsOf(model, body)) {
    if (!mine.has(key)) out[key] = value
    else if (!isEmpty(value) && !same(value, initial[key])) throw new ServerOwnedFieldError(key)
  }
  return out
}

/** The fields of a stored document that the body may change. `stored` is the document as it is now. */
export function clientUpdate(model: OwnedModel, body: unknown, stored: Record<string, any>): Record<string, any> {
  const mine = owned(model)
  const out: Record<string, any> = {}
  for (const [key, value] of fieldsOf(model, body)) {
    if (!mine.has(key)) out[key] = value
    // The one field that moves under a caller who sends a document back as loaded: never an ask.
    else if (key === 'updatedAt') continue
    else if (!same(value, key === '_id' || key === 'id' ? stored?.id ?? stored?._id : stored?.[key])) throw new ServerOwnedFieldError(key)
  }
  return out
}
