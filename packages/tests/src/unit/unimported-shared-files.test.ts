import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * FR-32.10 (#797): a file of `ui-shared` or `ui-shell` that no source file imports does not come back.
 *
 * FR-32.9 deleted eight such files of `ui-shared` (a data table, a file upload, an audit trail, a web-socket
 * composable among them) and the shell's breadcrumb. Each looked live: it had an `exports` entry, comments, and in
 * one case a line in CLAUDE.md. What imports a file is read from every package's `src` (the tests do not count:
 * a file only a test reaches is dead), through relative paths and through the package's `exports`.
 *
 * An entry in ALLOWED says why the file stays with nothing importing it.
 */
const ALLOWED: Record<string, string> = {}

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const PACKAGES = join(ROOT, 'packages')
const SHARED = ['ui-shared', 'ui-shell']
const norm = (p: string) => p.replace(/\\/g, '/')

const exportsOf = (pkg: string): Record<string, string> => {
  const json = JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8'))
  return typeof json.exports === 'object' ? json.exports : {}
}
const EXPORTS = Object.fromEntries(SHARED.map(p => [p, exportsOf(p)]))

function resolveFile(base: string): string | null {
  const stem = base.replace(/\.js$/, '')
  for (const c of [base, `${stem}.ts`, `${stem}.vue`, join(stem, 'index.ts')]) if (existsSync(c) && !c.endsWith('/')) return norm(c)
  return null
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return resolveFile(resolve(dirname(fromFile), spec))
  const pkg = SHARED.find(p => spec === p || spec.startsWith(`${p}/`))
  if (!pkg) return null
  const sub = spec === pkg ? '.' : `.${spec.slice(pkg.length)}`
  const target = EXPORTS[pkg][sub]
  if (typeof target === 'string') return resolveFile(join(PACKAGES, pkg, target))
  // A path the exports do not name, as Vite's alias would take it: `ui-shared/src/...`.
  return resolveFile(join(PACKAGES, pkg, spec.slice(pkg.length + 1)))
}

const SPECIFIERS = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

function importedFiles(): Set<string> {
  const seen = new Set<string>()
  for (const f of new Glob('*/src/**/*.{ts,vue}').scanSync(PACKAGES)) {
    const file = join(PACKAGES, f)
    if (/^(tests|e2e)[\\/]/.test(f)) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(SPECIFIERS)) {
      const spec = m[1] ?? m[2] ?? m[3]
      const hit = resolveSpecifier(spec, file)
      if (hit) seen.add(hit)
    }
  }
  return seen
}

describe('no file of ui-shared or ui-shell sits unimported (FR-32.10)', () => {
  const imported = importedFiles()
  const files = SHARED.flatMap(p => [...new Glob('src/**/*.{ts,vue}').scanSync(join(PACKAGES, p))].map(f => norm(join(PACKAGES, p, f))))

  it('every file is imported by a source file, or allowed with a reason', () => {
    const unimported = files
      .filter(f => !f.endsWith('.d.ts'))
      .filter(f => !imported.has(f))
      .map(f => norm(relative(PACKAGES, f)))
      .filter(f => !(f in ALLOWED))
    expect(unimported).toEqual([])
  })

  it('the allow-list names files that exist and gives each a reason', () => {
    for (const [f, why] of Object.entries(ALLOWED)) {
      expect(existsSync(join(PACKAGES, f))).toBe(true)
      expect(why.length).toBeGreaterThan(10)
    }
  })

  it('the check sees an import (a positive control)', () => {
    expect(imported.has(norm(join(PACKAGES, 'ui-shared', 'src', 'composables', 'useHttpClient.ts')))).toBe(true)
    expect(imported.has(norm(join(PACKAGES, 'ui-shell', 'src', 'module.ts')))).toBe(true)
  })
})
