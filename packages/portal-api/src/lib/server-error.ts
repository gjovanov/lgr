/**
 * What a 500 tells the caller (S-12).
 *
 * The app's `onError` used to answer every unexpected error with its own `message`. Some of those
 * are written for a person (`throw new Error('…')` in a service, about 260 of them, which the
 * UI's snackbar shows as they are). Others are the machinery talking: a duplicate key names the
 * database, the collection and the index (`E11000 duplicate key error collection: lgr.products
 * index: orgId_1_sku_1 …`), a schema error names the model and the BSON cast, a file error names
 * a path on the server, a `TypeError` names the property our code read off `undefined`.
 *
 * The rule here: the server's own words reach the caller, the machinery's never do. A schema
 * error and a duplicate key are still said plainly, because a person can act on them (the
 * postal code that was required, the SKU that already exists). Everything else internal becomes
 * "Internal server error" with a reference, and the log line carries the same reference with
 * the full error, so a person quoting it can be found in the log.
 *
 * ⚠ It is a deny-list on purpose. An allow-list would need every deliberate `throw new Error`
 * to opt in, and the ones that did not would turn a reason a person can act on into a
 * reference number, silently, the day this shipped.
 */

/** The JavaScript runtime's own errors: a bug in our code, never a sentence for a person. */
const RUNTIME_ERRORS = new Set([
  'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError',
])

/** Mongoose's errors without the `Mongoose` prefix (its base class and the driver's all carry it). */
const MONGOOSE_ERRORS = new Set([
  'CastError', 'ValidationError', 'ValidatorError', 'VersionError', 'DocumentNotFoundError',
  'StrictModeError', 'StrictPopulateError', 'DivergentArrayError', 'ParallelSaveError',
  'ParallelValidateError', 'OverwriteModelError', 'MissingSchemaError', 'ObjectExpectedError',
  'ObjectParameterError', 'BulkSaveIncompleteError',
])

/** The operating system's error codes that the runtime puts on a failed file or socket call. */
const SYSTEM_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EMFILE', 'ENFILE',
  'ENOSPC', 'EROFS', 'EBUSY', 'EIO', 'EPIPE', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN',
])

/**
 * A path on the server's disk, as an error message would quote it: `/app/…`, `/tmp/…`, `C:\…`,
 * `file:///…`, or anything inside `node_modules`.
 */
const SERVER_PATH = /(?:^|[\s'"`(=:])(?:\/(?:app|home|root|tmp|usr|var|opt|etc|proc|srv|mnt|data|run)\/|[A-Za-z]:[\\/]|file:\/\/)|node_modules/

/** The generic answer: nothing about the error, only the reference to find it by. */
export const INTERNAL_MESSAGE = 'Internal server error'

/** A short reference for one failed request, quoted in the answer and in the log line. */
export function errorRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

/** A duplicate key, from the driver or from a bulk write that carries one. */
function isDuplicateKey(err: any): boolean {
  if (err?.code === 11000 || err?.code === 11001) return true
  if (err?.writeErrors?.[0]?.code === 11000) return true
  return /\bE11000\b/.test(String(err?.message ?? ''))
}

/** The fields a duplicate key collided on, without the org every unique index starts with. */
function duplicateFields(err: any): string[] {
  const keys = err?.keyPattern ?? err?.keyValue ?? err?.writeErrors?.[0]?.err?.keyPattern
  if (!keys || typeof keys !== 'object') return []
  return Object.keys(keys).filter(k => k !== 'orgId')
}

/** Mongoose's schema rejection: one entry per field it refused. */
function isSchemaRejection(err: any): boolean {
  return err?.name === 'ValidationError' && !!err?.errors && typeof err.errors === 'object'
}

/** One refused field, in the words `validationMessage` uses for the route's own schema. */
function fieldReason(e: any): string {
  switch (e?.kind) {
    case 'required': return 'is required'
    case 'enum': return 'is not one of the allowed values'
    case 'min': return 'is too small'
    case 'max': return 'is too large'
    case 'minlength': return 'is too short'
    case 'maxlength': return 'is too long'
    case 'regexp': return 'is not in the expected format'
    // A validator our own schema declares: its message was written for a person.
    case 'user defined': return typeof e?.message === 'string' && e.message ? `: ${e.message}` : 'is not valid'
    // A cast (`ObjectId`, `Number`, `Date`…): the value was not of the field's type.
    default: return 'is not valid'
  }
}

/** The fields a schema rejection names, at most five, with how many more there were. */
function schemaMessage(err: any): string {
  const entries = Object.entries<any>(err.errors)
  const said = entries.slice(0, 5).map(([path, e]) => {
    const reason = fieldReason(e)
    return reason.startsWith(':') ? `"${path}"${reason}` : `"${path}" ${reason}`
  })
  const more = entries.length > 5 ? ` (and ${entries.length - 5} more)` : ''
  return `Not saved: ${said.join('; ')}${more}`
}

/**
 * Is this the machinery's error rather than the server's own words? Anything that is not an
 * `Error` at all counts as one: nothing in this codebase throws a bare value on purpose.
 */
export function isInternalError(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  const e = err as any
  const name = String(e.name ?? '')
  if (RUNTIME_ERRORS.has(name) || MONGOOSE_ERRORS.has(name)) return true
  if (/^(Mongo|BSON)/.test(name)) return true
  if (typeof e.syscall === 'string' || typeof e.errno === 'number') return true
  if (typeof e.code === 'string' && SYSTEM_CODES.has(e.code)) return true
  return SERVER_PATH.test(String(e.message ?? ''))
}

/**
 * The message a 500 carries. A schema rejection and a duplicate key are said plainly (a person
 * can act on them); the server's own words pass as they are; anything else internal is the
 * generic message with the reference.
 */
export function serverErrorMessage(err: unknown, ref: string): string {
  if (isSchemaRejection(err)) return schemaMessage(err)
  if (isDuplicateKey(err)) {
    const fields = duplicateFields(err)
    const which = fields.length ? fields.map(f => `"${f}"`).join(' and ') : 'value'
    return `Not saved: another record already has the same ${which}`
  }
  if (isInternalError(err)) return `${INTERNAL_MESSAGE} (ref ${ref})`
  const message = (err as Error).message
  return message ? message : `${INTERNAL_MESSAGE} (ref ${ref})`
}
