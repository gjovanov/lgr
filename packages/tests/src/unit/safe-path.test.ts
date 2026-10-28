import { describe, it, expect } from 'bun:test'
import { basename, dirname, resolve, sep } from 'path'
import { safeFileName, containedJoin, stampedUploadPath } from 'services/biz/files/safe-path'

/**
 * S-03 (#49) — the uploaded filename reached `Bun.write` through `join(dir, file.name)`.
 *
 * ⚠ These run without a database or a filesystem on purpose. The property is about STRINGS —
 * "no input produces a path outside the base" — and a test that writes files can only ever
 * sample the inputs someone thought of. `containedJoin` is asserted directly against the
 * shapes that defeat the obvious fixes.
 */

const BASE = resolve('/srv/uploads/org1/docs')

describe('safeFileName', () => {
  it('keeps an ordinary export name intact', () => {
    expect(safeFileName('stokrazp_3000016311.pdf')).toBe('stokrazp_3000016311.pdf')
    expect(safeFileName('salesAnalysis_20260813_172956.xlsx')).toBe('salesAnalysis_20260813_172956.xlsx')
  })

  it('strips every directory component', () => {
    // The actual payload: a multipart filename a browser would never send, but curl will.
    expect(safeFileName('../../../../app/packages/portal-api/src/unified.ts')).toBe('unified.ts')
    expect(safeFileName('..\\..\\..\\lgr-seal.key')).toBe('lgr-seal.key')
    expect(safeFileName('/etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts')
  })

  it('rejects a name that is only traversal', () => {
    for (const bad of ['..', '.', '../', '../..', '']) {
      expect(() => safeFileName(bad)).toThrow('Invalid filename')
    }
  })

  it('rejects Windows device names', () => {
    // A write to one of these opens a DEVICE. The desktop build runs on Windows.
    for (const bad of ['CON', 'con.txt', 'NUL', 'COM1', 'LPT9.pdf', 'aux']) {
      expect(() => safeFileName(bad)).toThrow('Invalid filename')
    }
  })

  it('removes control characters and shell-hostile punctuation', () => {
    expect(safeFileName('re\u0000port.pdf')).toBe('re_port.pdf')
    expect(safeFileName('a<b>c\"d|e?f*g.pdf')).toBe('a_b_c_d_e_f_g.pdf')
  })

  /**
   * ⚠ The same input must produce the same name on the Linux server and the Windows desktop.
   * `path.basename` follows the host — it reads `x:` as a drive and `\` as a separator only on
   * Windows — so the platform's own answer differs, and the Linux half is the one that does
   * NOT strip a backslash path. `safeFileName` runs both basenames for exactly this reason.
   */
  it('gives the same answer on both platforms', () => {
    expect(safeFileName('a:b.pdf')).toBe('b.pdf')
    expect(safeFileName('..\\..\\lgr-seal.key')).toBe('lgr-seal.key')
    expect(safeFileName('dir\\sub/deep\\file.pdf')).toBe('file.pdf')
    expect(safeFileName('/srv/uploads\\..\\..\\etc\\passwd')).toBe('passwd')
  })

  it('normalises names Windows would silently collide', () => {
    // `report.pdf ` and `report.pdf` are the same file on Windows; storing both under their
    // literal names means one silently overwrites the other.
    expect(safeFileName('report.pdf ')).toBe('report.pdf')
    expect(safeFileName('report.pdf.')).toBe('report.pdf')
    expect(safeFileName('.hidden.pdf')).toBe('hidden.pdf')
  })

  it('caps the length', () => {
    expect(safeFileName('x'.repeat(500)).length).toBe(200)
  })

  it('handles non-string input without throwing something unhelpful', () => {
    for (const bad of [undefined, null, 123, {}]) {
      // Either a safe name or a clean refusal — never a crash from deeper in the stack.
      try { expect(typeof safeFileName(bad as any)).toBe('string') }
      catch (e) { expect(String(e)).toContain('Invalid filename') }
    }
  })
})

describe('containedJoin', () => {
  it('joins an ordinary segment', () => {
    expect(containedJoin(BASE, 'invoice.pdf')).toBe(resolve(BASE, 'invoice.pdf'))
    expect(containedJoin(BASE, 'versions', 'invoice_2026.pdf')).toBe(resolve(BASE, 'versions', 'invoice_2026.pdf'))
  })

  it('refuses to climb out', () => {
    expect(() => containedJoin(BASE, '..')).toThrow('escapes its base')
    expect(() => containedJoin(BASE, '../../../etc/passwd')).toThrow('escapes its base')
    expect(() => containedJoin(BASE, 'versions', '..', '..', '..')).toThrow('escapes its base')
  })

  it('refuses an absolute segment', () => {
    // `resolve` lets a later absolute segment discard the base entirely — the failure mode
    // that makes "just call resolve" an incomplete fix.
    expect(() => containedJoin(BASE, '/etc/passwd')).toThrow('escapes its base')
  })

  /**
   * ⚠ The check that a naive `startsWith(root)` gets wrong. `/srv/uploads/org1/docs-evil`
   * starts with `/srv/uploads/org1/docs` as a STRING while being a different directory.
   */
  it('refuses a sibling directory sharing the base as a prefix', () => {
    expect(() => containedJoin(BASE, '..', 'docs-evil', 'x.pdf')).toThrow('escapes its base')
  })

  it('allows the base itself', () => {
    expect(containedJoin(BASE)).toBe(BASE)
  })

  it('treats a nested path inside the base as fine', () => {
    const deep = containedJoin(BASE, '2026-08-13', 'versions', 'a.pdf')
    expect(deep.startsWith(BASE + sep)).toBe(true)
  })
})

/**
 * The two import writers (`/bills/import/extract`, `/doc-import/extract`) kept `/` and `\` in the
 * name they stored, so `join` walked a part named `x/../../../anything` out of their directory.
 * Over HTTP: `integration/upload-filename.flow.test.ts`.
 */
describe('stampedUploadPath', () => {
  const DIR = resolve('/srv/uploads/org1/bill-ocr')
  const NOW = 1761206400000

  it('stores an ordinary export name as those writers always did', () => {
    expect(stampedUploadPath(DIR, 'invoicem_3000100855.pdf', NOW)).toBe(resolve(DIR, `${NOW}-invoicem_3000100855.pdf`))
    // Cyrillic and spaces were always `_` in these two directories; that does not change.
    expect(stampedUploadPath(DIR, 'Фактура 12.pdf', NOW)).toBe(resolve(DIR, `${NOW}-${"_".repeat(8)}12.pdf`))
  })

  it('keeps only the last component of a path, on either platform', () => {
    for (const [raw, last] of [
      ['x/../../../../escaped.txt', 'escaped.txt'],
      ['../../../../app/packages/portal-api/src/unified.ts', 'unified.ts'],
      ['..\\..\\..\\lgr-seal.key', 'lgr-seal.key'],
      ['/etc/passwd', 'passwd'],
      ['C:\\Windows\\win.ini', 'win.ini'],
      ['a:b.pdf', 'b.pdf'],
      ['dir\\sub/deep\\file.pdf', 'file.pdf'],
    ]) {
      expect(stampedUploadPath(DIR, raw, NOW)).toBe(resolve(DIR, `${NOW}-${last}`))
    }
  })

  /**
   * ⚠ Unlike `safeFileName`, it never refuses. Behind the timestamp none of these can be the
   * final segment, so refusing would only turn away a real file somebody called `con.pdf`.
   */
  it('lands every name, however odd, directly inside the directory', () => {
    for (const raw of ['..', '.', '', '../', 'con.pdf', 'NUL', 'x/..', 'a\u0000b.pdf', 'evil.pdf:stream', undefined, null, 'x'.repeat(500)]) {
      const p = stampedUploadPath(DIR, raw, NOW)
      expect(dirname(p)).toBe(DIR)
      expect(basename(p).startsWith(`${NOW}-`)).toBe(true)
      expect(basename(p)).toMatch(/^[\w.\-]{1,200}$/)
    }
  })
})
