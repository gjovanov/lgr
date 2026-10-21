import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { config } from 'config'
import {
  StoredPathError, normalizeStored, resolveStored, toStored, validateStored,
} from 'services/biz/files/stored-path'

/**
 * Stored file paths (FR-20.24, plan step P0b-8): relative to the upload root, `/`-separated, under
 * the org's id, and validated wherever they are read. A reader still accepts the legacy forms.
 */

const ORG = '6a8d0000000000000000bbcd'
const OTHER = '6a8d0000000000000000aaaa'
const ROOT = resolve(tmpdir(), 'lgr-stored-path-root')
const was = config.upload.dir

beforeAll(() => { config.upload.dir = ROOT })
afterAll(() => { config.upload.dir = was })

const throws = (f: () => unknown) => {
  try { f() } catch (e) { return e }
  return undefined
}

describe('validateStored', () => {
  it('accepts the stored form', () => {
    expect(validateStored(`${ORG}/docs/2026-09-10/a.pdf`)).toBe(`${ORG}/docs/2026-09-10/a.pdf`)
  })

  it.each([
    ['empty', ''],
    ['..', `${ORG}/docs/../../etc/passwd`],
    ['.', `${ORG}/./a.pdf`],
    ['an empty segment', `${ORG}//a.pdf`],
    ['absolute', `/${ORG}/a.pdf`],
    ['a drive letter', `C:/${ORG}/a.pdf`],
    ['a backslash', `${ORG}\\docs\\a.pdf`],
    ['no org id first', 'docs/a.pdf'],
    ['a NUL byte', `${ORG}/a\0.pdf`],
  ])('refuses %s', (_label, path) => {
    expect(throws(() => validateStored(path))).toBeInstanceOf(StoredPathError)
  })
})

describe('toStored', () => {
  it('makes a path under the root relative, with / separators', () => {
    expect(toStored(join(ROOT, ORG, 'docs', 'a.pdf'))).toBe(`${ORG}/docs/a.pdf`)
  })

  it('refuses a path outside the root, or the root itself', () => {
    expect(throws(() => toStored(join(ROOT, '..', 'elsewhere', ORG, 'a.pdf')))).toBeInstanceOf(StoredPathError)
    expect(throws(() => toStored(ROOT))).toBeInstanceOf(StoredPathError)
  })
})

describe('reading either form', () => {
  it('the stored form resolves under this server\'s root', () => {
    expect(resolveStored(`${ORG}/docs/a.pdf`, ORG)).toBe(join(ROOT, ORG, 'docs', 'a.pdf'))
  })

  it('a legacy absolute path under this root', () => {
    expect(resolveStored(join(ROOT, ORG, 'docs', 'a.pdf'), ORG)).toBe(join(ROOT, ORG, 'docs', 'a.pdf'))
  })

  it('a legacy absolute path written by production lands under THIS root (AC 9)', () => {
    expect(normalizeStored(`/app/uploads/${ORG}/docs/a.pdf`)).toBe(`${ORG}/docs/a.pdf`)
    expect(resolveStored(`/app/uploads/${ORG}/docs/a.pdf`, ORG)).toBe(join(ROOT, ORG, 'docs', 'a.pdf'))
  })

  it('a root named in UPLOAD_LEGACY_ROOTS, Windows-style and in another case', () => {
    process.env.UPLOAD_LEGACY_ROOTS = 'D:\\lgr\\Uploads'
    try {
      expect(normalizeStored(`d:\\LGR\\uploads\\${ORG}\\docs\\a.pdf`)).toBe(`${ORG}/docs/a.pdf`)
    } finally {
      delete process.env.UPLOAD_LEGACY_ROOTS
    }
  })

  it('a legacy path relative to the working directory (the dev default ./uploads)', () => {
    config.upload.dir = './uploads'
    try {
      expect(normalizeStored(join('uploads', ORG, 'docs', 'a.pdf'))).toBe(`${ORG}/docs/a.pdf`)
    } finally {
      config.upload.dir = ROOT
    }
  })

  it('refuses an absolute path under no known root', () => {
    expect(throws(() => resolveStored(`/var/other/${ORG}/a.pdf`))).toBeInstanceOf(StoredPathError)
  })

  it('refuses a path that escapes through .. in either form', () => {
    expect(throws(() => resolveStored(`${ORG}/../${OTHER}/a.pdf`))).toBeInstanceOf(StoredPathError)
    expect(throws(() => resolveStored(join(ROOT, ORG, '..', '..', 'etc', 'passwd')))).toBeInstanceOf(StoredPathError)
  })

  it('a row of one org never resolves into another org\'s tree', () => {
    expect(throws(() => resolveStored(`${OTHER}/docs/a.pdf`, ORG))).toBeInstanceOf(StoredPathError)
    expect(throws(() => resolveStored(join(ROOT, OTHER, 'docs', 'a.pdf'), ORG))).toBeInstanceOf(StoredPathError)
  })
})

/** Server source, walked: a reader that touches a stored path without `resolveStored` fails here. */
function serverSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) serverSources(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/** A file operation whose argument is a stored path as the row holds it. */
const RAW_READ = /(?:Bun\.file|Bun\.write|rename|unlink|stat|readFile|createReadStream|writeFile)\(\s*[\w.]+\.(?:currentPath|storagePath)\b/

describe('every reader goes through resolveStored', () => {
  it('no file operation takes a stored path directly', () => {
    const pkgs = join(import.meta.dir, '..', '..', '..')
    const hits: string[] = []
    for (const pkg of ['services', 'invoicing-api', 'portal-api', 'reports-api', 'migrations']) {
      for (const f of serverSources(join(pkgs, pkg, 'src'))) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (RAW_READ.test(line)) hits.push(`${f}:${i + 1}`) })
      }
    }
    expect(hits).toEqual([])
  })

  it('the scan catches a raw read (positive control)', () => {
    expect(RAW_READ.test('const buf = await Bun.file(doc.currentPath).arrayBuffer()')).toBe(true)
    expect(RAW_READ.test('await rename(existing.currentPath, dest)')).toBe(true)
    expect(RAW_READ.test('Bun.file(resolveStored(doc.currentPath, orgId))')).toBe(false)
  })
})
