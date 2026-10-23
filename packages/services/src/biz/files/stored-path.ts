import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { config } from 'config'

/**
 * File paths as the database stores them (FR-20.24, plan step P0b-8).
 *
 * A stored path is RELATIVE to the upload root, starts with the org's id and uses `/`:
 * `6a8d…bbcd/docs/2026-09-10/invoicem_3000100855.pdf`. Every writer already lays files out as
 * `<upload root>/<orgId>/…`, so the first segment both tells the new form from a legacy one and
 * names the org the file belongs to.
 *
 * Until now the rows held the path the process wrote to: absolute in production
 * (`/app/uploads/<orgId>/…`) and relative to the process's working directory in development
 * (`uploads/<orgId>/…`, from the default `UPLOAD_DIR=./uploads`). A bundle restored on a server
 * with another root, or the same org on a master, then points nowhere.
 *
 * ⚠ **Expand, then contract.** This release only READS both forms: every reader goes through
 * `resolveStored`. The writers switch to `toStored`, and a migration rewrites the rows, one release
 * later, so a binary rollback never meets a path it cannot read.
 */

export class StoredPathError extends Error {
  readonly code = 'stored_path_invalid'
}

const OBJECT_ID = /^[0-9a-f]{24}$/i

/** The upload root, resolved. */
const uploadRoot = () => resolve(config.upload.dir)

const unify = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const isAbsoluteAnywhere = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || isAbsolute(p)

/**
 * Roots a legacy absolute path may start with: this server's, production's, and any listed in
 * `UPLOAD_LEGACY_ROOTS` (comma-separated) for a database that came from somewhere else.
 */
export function knownRoots(): string[] {
  const extra = (process.env.UPLOAD_LEGACY_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean)
  return [...new Set([uploadRoot(), '/app/uploads', ...extra].map(unify))]
}

/** Throw unless `rel` is a stored path: relative, `/`-separated, no `..`, under an org id. */
export function validateStored(rel: string): string {
  if (typeof rel !== 'string' || !rel) throw new StoredPathError('empty file path')
  if (rel.includes('\0')) throw new StoredPathError('file path contains a NUL byte')
  if (rel.includes('\\')) throw new StoredPathError(`stored file path uses a backslash: ${rel}`)
  if (isAbsoluteAnywhere(rel)) throw new StoredPathError(`stored file path is absolute: ${rel}`)
  const segs = rel.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) throw new StoredPathError(`stored file path has an empty, . or .. segment: ${rel}`)
  if (!OBJECT_ID.test(segs[0])) throw new StoredPathError(`stored file path does not start with an org id: ${rel}`)
  return rel
}

/** The stored form of an absolute path inside the upload root. */
export function toStored(absolutePath: string): string {
  const rel = relative(uploadRoot(), resolve(absolutePath))
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new StoredPathError(`file is outside the upload root: ${absolutePath}`)
  }
  return validateStored(rel.split(sep).join('/'))
}

/** The stored form of any path a row holds: the new form as it is, a legacy one converted. */
export function normalizeStored(stored: string): string {
  if (typeof stored !== 'string' || !stored) throw new StoredPathError('empty file path')
  if (!isAbsoluteAnywhere(stored) && OBJECT_ID.test(stored.split(/[\\/]/)[0])) return validateStored(stored)

  if (isAbsoluteAnywhere(stored)) {
    const path = unify(stored)
    const caseless = /^[A-Za-z]:/.test(path)   // a Windows path compares without case
    for (const root of knownRoots()) {
      const a = caseless ? path.toLowerCase() : path
      const r = caseless ? root.toLowerCase() : root
      if (a.startsWith(r + '/')) return validateStored(path.slice(root.length + 1))
    }
    throw new StoredPathError(`file path is under no known upload root: ${stored}`)
  }

  // Legacy relative: written relative to the process's working directory (`uploads/<orgId>/…`).
  return toStored(resolve(stored))
}

/**
 * The absolute path on THIS server for a stored path, in either form. With `orgId`, the file must
 * be that org's: a row of one org never resolves into another org's tree.
 */
export function resolveStored(stored: string, orgId?: unknown): string {
  const rel = normalizeStored(stored)
  if (orgId !== undefined && orgId !== null && rel.split('/')[0] !== String(orgId)) {
    throw new StoredPathError(`file path belongs to another org: ${rel}`)
  }
  return join(uploadRoot(), ...rel.split('/'))
}
