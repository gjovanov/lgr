import { posix, win32, resolve, sep } from 'path'

/**
 * Two functions standing between an uploaded filename and the filesystem.
 *
 * ## Why
 *
 * `storeDocument` built its write target as `join(dir, file.name)` and handed it to
 * `Bun.write`. `file.name` is the `filename=` of a multipart part — chosen by the caller, not
 * by us. A browser strips path components before sending; `curl`, a script, or anything else
 * speaking HTTP does not. So a part named
 *
 *     ../../../../app/packages/portal-api/src/unified.ts
 *
 * resolved cleanly out of the uploads tree and overwrote application source — or
 * `lgr-seal.key`, the one credential `.gitignore` spends a paragraph keeping off GitHub.
 * `join()` does not prevent this; normalising `..` is precisely what it is for.
 *
 * The route is gated on `admin.settings`, so it takes an org admin. That is not much comfort:
 * `admin` is a TENANT-scoped role — the regal-pz shop owner holds it — and this turned it into
 * write access to the host every other tenant runs on. The boundary the whole multi-tenant
 * design rests on was one filename away.
 *
 * ## The shape of the fix
 *
 * Two layers, because either alone has a gap:
 *
 *   `safeFileName` sanitises at INGEST, so the name persisted on `DocFile.originalName` (and
 *   the `docNumber` derived from it) is already clean. Every later path is built from those
 *   stored values, so cleaning them once fixes paths this module has not been written yet.
 *
 *   `containedJoin` asserts at every SINK, so a value that reached the database before this
 *   landed — or through a path that forgets to sanitise — still cannot escape. It is the
 *   check that does not depend on remembering, which is the only kind that holds.
 */

/** Characters no filesystem here should be asked to take, plus the separators. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x1f\x7f<>:"|?*\\/]/g

/**
 * One filesystem-safe path SEGMENT from a caller-supplied filename.
 *
 * ⚠ `basename` first and separately: it is what removes a directory component, and it must
 * run before the `..` check, or `../../x` arrives as the harmless-looking segment `x` only
 * after the dangerous part has already been dropped — which is correct, but reads as luck
 * rather than intent when the order is implicit.
 *
 * ⚠ `..` and `.` are rejected outright rather than escaped. They are legal filenames nowhere
 * that matters and always an attempt at something; silently rewriting one to `_` would store
 * a document under a name nobody asked for instead of refusing a request nobody should make.
 *
 * Windows reserves `CON`, `PRN`, `AUX`, `NUL`, `COM1-9` and `LPT1-9` — with or without an
 * extension. A write to one of those opens a DEVICE, not a file. The desktop build runs on
 * Windows, so this is not theoretical here.
 */
export function safeFileName(raw: unknown): string {
  // ⚠ BOTH basenames, not the platform's. `path.basename` follows the host: on Windows it
  // reads `a:` as a drive and `\` as a separator, on Linux it reads neither. The server is
  // Linux and the desktop build is Windows, so the platform's own answer means one upload
  // lands under two different names depending on where it was received — and the Linux
  // server is the half that does NOT strip `..\..\x`. Running both makes the result identical
  // everywhere and as strict as the stricter host.
  const name = posix
    .basename(win32.basename(String(raw ?? '')))
    .replace(UNSAFE, '_')
    .trim()
  if (!name || name === '.' || name === '..') throw new Error('Invalid filename')
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) throw new Error('Invalid filename')
  // A leading dot would hide the document; a trailing dot or space is silently stripped by
  // Windows, so `report.pdf ` and `report.pdf` become the same file and one overwrites the other.
  const trimmed = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!trimmed) throw new Error('Invalid filename')
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed
}

/**
 * `join`, refusing to leave `base`.
 *
 * ⚠ Compares against `base + sep` so a sibling directory cannot pass on a prefix match:
 * `/uploads/org1-evil` starts with `/uploads/org1` as a STRING while being a different
 * directory entirely. The separator is what makes the comparison mean "inside".
 *
 * Returns the resolved absolute path, so callers get the value they should actually write to
 * rather than a boolean they might forget to act on.
 */
export function containedJoin(base: string, ...segments: string[]): string {
  const root = resolve(base)
  const target = resolve(root, ...segments.map(s => String(s ?? '')))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Resolved path escapes its base directory')
  }
  return target
}
