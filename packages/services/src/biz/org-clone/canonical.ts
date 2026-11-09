/**
 * A document's content as one string, the same for two documents that say the same thing.
 *
 * ⚠ IMPORT-PURE. The sync decides "has this copy drifted from its source" by comparing these, so
 * what must NOT matter is the key order (an update through the app appends a field; a copy is
 * built in the source's order) and what MUST is every type: the ObjectId `6a5e...` and the string
 * "6a5e..." are different documents, a Date is not its ISO string, and a Decimal128 keeps its digits.
 *
 * Reads the shapes the raw driver hands back (BSON classes recognised by `_bsontype`, so no import
 * of the `bson` package and no dependency on which copy of it the driver loaded).
 */
import { createHash } from 'node:crypto'

function walk(v: any): string {
  if (v === null || v === undefined) return 'n'
  switch (typeof v) {
    case 'string': return JSON.stringify(v)
    case 'number': return Number.isNaN(v) ? 'NaN' : Object.is(v, -0) ? '0' : String(v)
    case 'boolean': return v ? 't' : 'f'
    case 'bigint': return `${v}L`
    case 'function': case 'symbol': return 'n'
  }
  if (v instanceof Date) return `d${v.getTime()}`
  if (Buffer.isBuffer(v)) return `b${v.toString('base64')}`
  if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`
  const bson = v._bsontype
  if (typeof bson === 'string') {
    switch (bson) {
      case 'ObjectId': case 'ObjectID': return `o${typeof v.toHexString === 'function' ? v.toHexString() : String(v)}`
      case 'Binary': return `b${typeof v.toString === 'function' ? v.toString('base64') : ''}`
      case 'Double': case 'Int32': return String(v.valueOf?.() ?? v)
      case 'Decimal128': case 'Long': return `${bson[0]}${v.toString()}`
      default: return `$${bson}:${typeof v.toString === 'function' ? v.toString() : ''}`
    }
  }
  if (v instanceof RegExp) return `r${v.toString()}`
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`
}

export function canonicalize(doc: unknown): string {
  return walk(doc)
}

/** 16 hex characters of SHA-256 over the canonical form: plenty to tell a changed document from an equal one. */
export function contentHash(doc: unknown): string {
  return createHash('sha256').update(canonicalize(doc)).digest('hex').slice(0, 16)
}
