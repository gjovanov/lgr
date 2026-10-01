import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * FR-14.36 — nothing in this suite may use `expect(p).rejects` or `.resolves`.
 *
 * ## Why this is a test and not a grep
 *
 * C14's acceptance says `git grep '\.rejects\|\.resolves' packages/tests` should return nothing.
 * It cannot: about forty files carry a COMMENT explaining the ban, and the warning is worth more
 * than the greppability. So the real property — **no call sites** — is asserted here, where it
 * runs on every `bun run test` instead of in a command somebody has to remember.
 *
 * ## What it is protecting
 *
 * On Windows under Bun, those matchers deadlock when the rejection follows MongoDB driver I/O:
 * the pending operation hangs, mongod gets reaped, and every later file cascades into
 * ECONNREFUSED. **One occurrence blocked the entire Windows suite for two months** —
 * `accounting.flow.test.ts` is the first file the runner reaches, so its single `.rejects`
 * killed the shared mongod before any other file ran and the suite never reported at all. It
 * did not look like a hang; it looked like nothing.
 *
 * ⚠ Scans RECURSIVELY. `dal/repos/` and `unit/biz/` are two levels down, and a `unit/*.test.ts`
 * glob silently misses 23 sites — which is how the sweep missed them the first time.
 */

const ROOT = join(import.meta.dirname, '..')

/** `expect(...).rejects` / `.resolves` — the call sites, not the word in prose. */
const CALL_SITE = /\)\s*\.\s*(rejects|resolves)\b/

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

/** Strip comments, so the ~40 files that DOCUMENT the ban do not trip it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the async matchers stay out of this suite (FR-14.36)', () => {
  const files = walk(ROOT)

  it('finds no `.rejects` / `.resolves` call site anywhere under packages/tests', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []

    for (const file of files) {
      // This file necessarily contains the pattern it is looking for.
      if (file.endsWith('no-async-matchers.test.ts')) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/)
      lines.forEach((text, i) => {
        if (CALL_SITE.test(text)) {
          offenders.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: text.trim() })
        }
      })
    }

    // Named, so the failure says WHICH file rather than just that one exists.
    expect(offenders).toEqual([])
  })

  it('scans recursively, which is the part the first sweep got wrong', () => {
    // ⚠ If this ever drops to a single directory's worth of files, the guard has quietly stopped
    // covering `dal/repos/` and `unit/biz/` — the two places the original sweep missed.
    const dirs = new Set(files.map(f => f.slice(ROOT.length + 1).split(/[\\/]/)[0]))
    expect(dirs.has('integration')).toBe(true)
    expect(dirs.has('unit')).toBe(true)
    expect(files.length).toBeGreaterThan(100)

    const nested = files.filter(f => f.slice(ROOT.length + 1).split(/[\\/]/).length > 2)
    expect(nested.length).toBeGreaterThan(0)
  })

  it('still recognises a call site when it sees one', () => {
    // A guard whose pattern does not match is a guard that passes for ever. Both spellings, and
    // the whitespace a formatter might introduce.
    expect(CALL_SITE.test('await expect(p).rejects.toThrow()')).toBe(true)
    expect(CALL_SITE.test('await expect(p).resolves.toBe(1)')).toBe(true)
    expect(CALL_SITE.test('await expect(fn()) .rejects .toThrow()')).toBe(true)
  })

  it('does not fire on the prose that documents the ban', () => {
    // ⚠ Two things keep the ~40 explanatory comments from tripping it, and both matter: the
    // pattern needs a `)` immediately before the matcher, AND comments are stripped first. The
    // second alone would be fragile, the first alone would miss a commented-out call site.
    expect(CALL_SITE.test('// no .rejects here')).toBe(false)
    expect(CALL_SITE.test(' * ⚠ Use this instead of `.rejects` / `.resolves`')).toBe(false)
    expect(CALL_SITE.test('const rejects = 1')).toBe(false)

    // And a commented-out call site is removed by the stripper rather than relied on to miss.
    expect(stripComments('// await expect(p).rejects.toThrow()').trim()).toBe('')
    expect(stripComments('/* expect(p).resolves.toBe(1) */').trim()).toBe('')
  })
})
