import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * Multi-org sign-in, plan rule 6: per-tab sessions hold only while EVERY read of the session goes
 * through `ui-shared/src/session/session.ts`.
 *
 * A leftover `localStorage.getItem('lgr_token')` in a background tab would act in whichever org
 * another tab switched to last, with a valid token. Nothing would look wrong: requests succeed,
 * in the wrong org. So the keys may appear as string literals in that one file and nowhere else
 * in the UI sources.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
const ALLOWED = 'ui-shared/src/session/session.ts'
const KEY_LITERAL = /['"`]lgr_(token|org|last_org|signed_out)['"`]/

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue|js)$/.test(name)) yield path
  }
}

describe('session storage keys', () => {
  it('appear only in the session module', () => {
    const roots = readdirSync(PACKAGES)
      .filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell')
      .map(p => join(PACKAGES, p, 'src'))
    expect(roots.length).toBeGreaterThanOrEqual(10)

    const offenders: string[] = []
    let scanned = 0
    for (const root of roots) {
      for (const file of sources(root)) {
        scanned++
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        if (rel === ALLOWED) continue
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (KEY_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
          })
      }
    }
    expect(scanned).toBeGreaterThan(100)
    expect(offenders).toEqual([])
  })

  it('the module itself still uses them (the scan is looking for the right thing)', () => {
    const own = readFileSync(join(PACKAGES, ALLOWED), 'utf8')
    expect(KEY_LITERAL.test(own)).toBe(true)
  })
})
