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
 *
 * An inventory count's number went the same way with no unique index beside it, so two counts made at the same
 * moment were saved under one number (#713). It comes from the org's counter now (`services/biz/count-number`),
 * and no source puts one together by hand.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
/** The packages that are tests, and so number their fixtures as they like. */
const TESTS = new Set(['tests', 'e2e'])

const RULES = [
  {
    what: 'a stock movement\'s number',
    /** The number, or its prefix, put together by hand: `SM-${year}-`, 'SM-' + year. */
    builds: /['"`]SM-(\$\{|['"`]\s*\+)/,
    allowed: 'packages/services/src/biz/movement-number.ts',
    sample: "const prefix = 'SM-' + year",
    onlyRead: "if (/^SM-\\d{4}-/.test(n)) return 'SM-2026-00001'",
  },
  {
    what: 'an inventory count\'s number',
    builds: /['"`]IC-(\$\{|['"`]\s*\+)/,
    /** Nowhere: the count module asks the counter by the series' name and never writes the prefix out. */
    allowed: null,
    sample: 'const prefix = `IC-${year}-`',
    onlyRead: "expect(number).toMatch(/^IC-\\d{4}-\\d{5}$/)",
  },
] as const

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue|js|mjs)$/.test(name)) yield path
  }
}

describe('a number is built in one place', () => {
  const roots = [
    ...readdirSync(join(ROOT, 'packages')).filter(p => !TESTS.has(p)).map(p => join(ROOT, 'packages', p, 'src')).filter(existsSync),
    join(ROOT, 'scripts'),
  ]
  const files = roots.flatMap(root => [...sources(root)]).map(file => ({ rel: relative(ROOT, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') }))

  it('the scan sees the app and its scripts', () => {
    expect(roots.length).toBeGreaterThanOrEqual(20)
    expect(files.length).toBeGreaterThan(1000)
  })

  for (const rule of RULES) {
    it(`${rule.what} is built ${rule.allowed ? 'in its module alone' : 'by no source'}`, () => {
      const offenders: string[] = []
      for (const { rel, text } of files) {
        if (rel === rule.allowed) continue
        text.split(/\r?\n/).forEach((line, i) => {
          if (rule.builds.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
      expect(offenders).toEqual([])
    })

    it(`${rule.what}: the scan is looking for the right thing`, () => {
      if (rule.allowed) expect(rule.builds.test(readFileSync(join(ROOT, rule.allowed), 'utf8'))).toBe(true)
      expect(rule.builds.test(rule.sample)).toBe(true)
      // A number that is only read or shown is nobody's to forbid.
      expect(rule.builds.test(rule.onlyRead)).toBe(false)
    })
  }

  it('the count module names the series the counter is asked for', () => {
    expect(readFileSync(join(ROOT, 'packages/services/src/biz/count-number.ts'), 'utf8')).toContain("COUNT_SERIES = 'IC'")
  })
})
