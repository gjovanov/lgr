import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * FR-24.30: one domain auth plugin. It used to be seven byte-identical copies, deduped by Elysia's
 * plugin name, so that the tenant guard ran from whichever copy was mounted first and a fix had to
 * land seven times. Now it is defined once (`services/http/app-auth.service.ts`) and each `*-api`
 * package's `auth/app-auth.service.ts` only re-exports it.
 */

const PACKAGES = join(import.meta.dirname, '..', '..', '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('FR-24.30: one auth plugin for every domain API', () => {
  it('defines Service.AppAuth exactly once, in services', () => {
    const definitions: string[] = []
    for (const pkg of readdirSync(PACKAGES).filter(p => p.endsWith('-api') || p === 'services')) {
      const src = join(PACKAGES, pkg, 'src')
      if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue
      for (const file of sources(src)) {
        if (/name:\s*'Service\.AppAuth'/.test(readFileSync(file, 'utf8'))) definitions.push(relative(PACKAGES, file).replace(/\\/g, '/'))
      }
    }
    expect(definitions).toEqual(['services/src/http/app-auth.service.ts'])
  })

  it("each package's auth/app-auth.service.ts is only the re-export", () => {
    for (const pkg of readdirSync(PACKAGES).filter(p => p.endsWith('-api'))) {
      const file = join(PACKAGES, pkg, 'src', 'auth', 'app-auth.service.ts')
      if (!statSync(file, { throwIfNoEntry: false })) continue
      const code = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('//'))
      expect({ pkg, code }).toEqual({ pkg, code: ["export { AppAuthService } from 'services/http/app-auth.service'"] })
    }
  })
})
