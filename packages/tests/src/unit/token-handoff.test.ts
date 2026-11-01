import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * FR-24 AC 7: nothing reads a session token from a query string.
 *
 * Until FR-24.21 every SPA's router took `?token=&org=` from the URL: the per-app Vite dev servers
 * were different origins, and a hop between them carried the tab's session in the query. On any
 * origin but those dev ports that read was a login-fixation hole (`https://lgrai.app/apps?token=<an
 * attacker's JWT>` signed the visitor into the attacker's account, FR-14.24), gated, but present.
 * With one SPA on one origin the handoff has no reason to exist, and this keeps it from coming back:
 * no UI source may read `token` out of a route query or a URL's search.
 * The reset-password and OAuth flows carry their secrets in the FRAGMENT, which no server logs.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
// `?org=` alone is no session: the sign-in page pre-fills the org slug from it.
const READS = [
  /\.query\.token\b/,
  /\.query\[['"`]token['"`]\]/,
  /searchParams\.get\(\s*['"`]token['"`]/,
  /[?&]token=\$\{/,
  /\b(consumeTokenHandoff|classifyTokenHandoff|isDevTokenHandoffOrigin|handoffQuery)\b/,
]

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|vue|js)$/.test(name)) yield path
  }
}

describe('no session token from a query string (FR-24 AC 7)', () => {
  it('no UI source reads one', () => {
    const roots = readdirSync(PACKAGES)
      .filter(p => p.endsWith('-ui') || p === 'web' || p === 'ui-shared' || p === 'ui-shell')
      .map(p => join(PACKAGES, p, 'src'))
      .filter(p => existsSync(p)) // a package folder git no longer has can linger on a checkout
    expect(roots.length).toBeGreaterThanOrEqual(10)

    const offenders: string[] = []
    for (const root of roots) {
      for (const file of sources(root)) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (READS.some(r => r.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
