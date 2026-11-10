/**
 * Rewriting a source document into the copy it becomes in the target org.
 *
 * ⚠ IMPORT-PURE: the caller passes in what it knows (`RemapEnv`), so the rewrite is a plain
 * function of its arguments and is tested without a database.
 *
 * **By VALUE, recursively, not by a list of reference paths** — the rule the restore's remap
 * (`backup-restore.service.ts#remapDoc`) is written on, for the same reason: a hand-kept list of
 * "fields that hold an id" across ~65 models is wrong the first time a model gains one. An
 * ObjectId, or a 24-hex string, anywhere in the document is replaced when it is the id of a
 * document in the source org (`env.idOf` answers) and left exactly as it was when it is not (a
 * person's id, a reference into a global collection, a string that merely looks like one).
 * The TYPE is kept: an ObjectId stays an ObjectId and a hex string stays a string.
 *
 * An id that stands INSIDE a longer string is a reference too, and is rewritten the same way: a tag
 * such as `<word>:<24-hex>` names the document it came from, and a copy that kept it would name a
 * document of the real org. Only a whole 24-hex token counts (a longer run of hex digits is not an
 * id), and only when it is the id of a source document, so ordinary text is untouched.
 *
 * Paths are rewritten too: a stored file path starts with the org's id, and a copy that kept the
 * source's would point into another tenant's directory.
 */

import { HEX24 } from './ids.js'

export interface RemapEnv {
  /** The hex id a SOURCE doc id becomes in the target (a copy's id, or the existing doc it maps onto); undefined = not a source doc. */
  idOf(hex: string): string | undefined
  /** Builds an ObjectId from hex (the caller's driver class). */
  oid(hex: string): unknown
  sourceOrgId: string
  targetOrgId: string
}

/** Keys whose string value is a path or a URL that embeds the org's id. */
const PATH_KEYS = new Set(['currentPath', 'storagePath', 'path', 'filePath', 'logo'])

/** A 24-hex token that is not part of a longer run of hex digits. */
const EMBEDDED_ID = /(?<![0-9a-fA-F])[0-9a-f]{24}(?![0-9a-fA-F])/g

const isObjectId = (v: any): boolean => !!v && typeof v === 'object' && (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID')
const isPlain = (v: any): boolean => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function remapValue(value: any, env: RemapEnv, key?: string): any {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (key && PATH_KEYS.has(key) && value.includes(env.sourceOrgId)) return value.split(env.sourceOrgId).join(env.targetOrgId)
    if (value.length === 24 && HEX24.test(value)) return env.idOf(value) ?? value
    if (value.length > 24) return value.replace(EMBEDDED_ID, token => env.idOf(token) ?? token)
    return value
  }
  if (typeof value !== 'object') return value
  if (isObjectId(value)) {
    const mapped = env.idOf(value.toHexString())
    return mapped === undefined ? value : env.oid(mapped)
  }
  if (Array.isArray(value)) return value.map(v => remapValue(v, env))
  if (!isPlain(value)) return value // Date, Buffer, Binary, Decimal128, RegExp: nothing inside to rewrite
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = remapValue(v, env, k)
  return out
}

/** The copy of one source document: its `_id`, `orgId` and every reference rewritten. */
export function remapDoc(doc: any, env: RemapEnv): any {
  const out = remapValue(doc, env)
  // Said outright, not left to the by-value pass: a document of the source org must never come out
  // carrying any other org.
  out.orgId = env.oid(env.targetOrgId)
  return out
}
