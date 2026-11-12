import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * A stock movement's number is the org's latest + 1, read and then written, so every creator has to write under
 * it the one way that tries again when another creator took the number first: `services/biz/movement-number`.
 *
 * Until 2026-11 seven sources each read the latest themselves and wrote once. Two movements made at the same
 * moment by any two of them answered one of the two a 500, and four of the seven listed a whole year's movements
 * to read the first. So the number may be built in that one module and nowhere else in the app or its scripts.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const ALLOWED = 'packages/services/src/biz/movement-number.ts'
/** The number, or its prefix, put together by hand: `SM-${year}-`, 'SM-' + year. */
const BUILDS_THE_NUMBER = /['"`]SM-(\$\{|['"`]\s*\+)/
/** The packages that are tests, and so number their fixtures as they like. */
const TESTS = new Set(['tests', 'e2e'])

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue|js|mjs)$/.test(name)) yield path
  }
}

describe('a stock movement\'s number', () => {
  it('is built in the numbering module alone', () => {
    const roots = [
      ...readdirSync(join(ROOT, 'packages')).filter(p => !TESTS.has(p)).map(p => join(ROOT, 'packages', p, 'src')).filter(existsSync),
      join(ROOT, 'scripts'),
    ]
    expect(roots.length).toBeGreaterThanOrEqual(20)

    const offenders: string[] = []
    let scanned = 0
    for (const root of roots) {
      for (const file of sources(root)) {
        scanned++
        const rel = relative(ROOT, file).replace(/\\/g, '/')
        if (rel === ALLOWED) continue
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (BUILDS_THE_NUMBER.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
          })
      }
    }
    expect(scanned).toBeGreaterThan(1000)
    expect(offenders).toEqual([])
  })

  it('the module itself still builds it (the scan is looking for the right thing)', () => {
    expect(BUILDS_THE_NUMBER.test(readFileSync(join(ROOT, ALLOWED), 'utf8'))).toBe(true)
    expect(BUILDS_THE_NUMBER.test("const prefix = 'SM-' + year")).toBe(true)
    // A number that is only read or shown is nobody's to forbid.
    expect(BUILDS_THE_NUMBER.test("if (/^SM-\\d{4}-/.test(n)) return 'SM-2026-00001'")).toBe(false)
  })
})
