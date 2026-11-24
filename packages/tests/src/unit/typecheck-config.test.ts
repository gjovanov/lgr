import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { PROGRAMS, compilerKilled } from '../../../../scripts/typecheck'
import {
  compareCounts, countDiagnostics, parseBaseline, parseDiagnostics, rewriteBaseline, serializeCounts, totalOf,
} from '../../../../scripts/lib/typecheck-baseline'

/**
 * FR-32.1 to FR-32.3 (#797): every package can be type-checked, on one strict base, and the CI
 * check (`scripts/typecheck.ts`) covers each package or says why not. The baseline it compares
 * against names files and error codes, never lines, and may only get shorter.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const PACKAGES = join(ROOT, 'packages')

/** Packages that have a tsconfig.json but are not in CI's check yet, each with its reason. */
const NOT_CHECKED_IN_CI: Record<string, string> = {
  tests: 'the suite itself: its own run is its check, and its `any` is not FR-32\'s concern (§1.4)',
  e2e: 'Playwright specs run under Node and its stubs under Bun: two programs of their own, not yet in CI',
}

function hasSources(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'src-tauri' || name === 'target' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (hasSources(p)) return true }
    else if (/\.(ts|vue)$/.test(name)) return true
  }
  return false
}

const tsPackages = readdirSync(PACKAGES).filter(p => statSync(join(PACKAGES, p)).isDirectory() && hasSources(join(PACKAGES, p)))

function readConfig(path: string): { extends?: string; include?: string[] } {
  const read = ts.readConfigFile(path, ts.sys.readFile)
  if (read.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  return read.config
}

/** The files a tsconfig.json resolves to, through its `extends`. */
function chainOf(path: string): string[] {
  const chain = [path]
  let config = readConfig(path)
  while (config.extends) {
    const next = resolve(dirname(chain.at(-1)!), config.extends)
    chain.push(next)
    config = readConfig(next)
  }
  return chain
}

describe('every package can be type-checked (FR-32.1)', () => {
  it('finds the packages it is about', () => {
    expect(tsPackages).toContain('services')
    expect(tsPackages).toContain('web')
    expect(tsPackages).toContain('api')
    // The two Rust packages have no TypeScript.
    expect(tsPackages).not.toContain('server')
  })

  it('each has a tsconfig.json on the one strict base', () => {
    const offenders: string[] = []
    for (const p of tsPackages) {
      const path = join(PACKAGES, p, 'tsconfig.json')
      if (!existsSync(path)) { offenders.push(`${p}: no tsconfig.json`); continue }
      if (!chainOf(path).includes(join(ROOT, 'tsconfig.base.json'))) offenders.push(`${p}: does not extend tsconfig.base.json`)
    }
    expect(offenders).toEqual([])
  })

  it('the base is strict and emits nothing', () => {
    const { options } = ts.parseJsonConfigFileContent(readConfig(join(ROOT, 'tsconfig.base.json')), ts.sys, ROOT)
    expect(options.strict).toBe(true)
    expect(options.noEmit).toBe(true)
  })

  // Read by the builders, not only by the check (see tsconfig.base.json): each preset keeps how
  // its builder emitted a class field before these files existed. Bun kept the field; Vite made
  // it an assignment.
  it('the server\'s packages leave class fields as Bun built them, the browser\'s as Vite did', () => {
    const optionsOf = (file: string) => ts.parseJsonConfigFileContent(readConfig(join(ROOT, file)), ts.sys, ROOT).options
    expect(optionsOf('tsconfig.base.json').useDefineForClassFields).toBeUndefined()
    expect(optionsOf('tsconfig.server.json').useDefineForClassFields).toBeUndefined()
    expect(optionsOf('tsconfig.dom.json').useDefineForClassFields).toBe(false)
  })
})

describe('CI checks every package, or says why not (FR-32.2, FR-32.3)', () => {
  const programs = {
    backend: readConfig(join(ROOT, 'scripts/typecheck/backend.tsconfig.json')),
    ui: readConfig(join(ROOT, 'scripts/typecheck/ui.tsconfig.json')),
  }
  const programOf = (p: string) => {
    if (p === 'desktop-ui') return ['desktop-ui']
    return Object.entries(programs)
      .filter(([, c]) => (c.include ?? []).some(g => g.startsWith(`../../packages/${p}/`)))
      .map(([name]) => name)
  }

  it('each package is in exactly one program, unless it is listed with a reason', () => {
    const offenders: string[] = []
    for (const p of tsPackages) {
      const inPrograms = programOf(p)
      if (NOT_CHECKED_IN_CI[p]) { if (inPrograms.length) offenders.push(`${p}: listed as not checked, but is in ${inPrograms}`) }
      else if (inPrograms.length !== 1) offenders.push(`${p}: in ${inPrograms.length} programs`)
    }
    expect(offenders).toEqual([])
  })

  it('a program checks what the package\'s own tsconfig.json says', () => {
    const offenders: string[] = []
    for (const p of tsPackages) {
      if (NOT_CHECKED_IN_CI[p] || p === 'desktop-ui') continue
      const own = readConfig(join(PACKAGES, p, 'tsconfig.json'))
      const [program] = programOf(p)
      const globs = (programs[program as keyof typeof programs].include ?? []).filter(g => g.startsWith(`../../packages/${p}/`))
      const expected = (own.include ?? []).map(g => `../../packages/${p}/${g}`)
      if (JSON.stringify(globs.sort()) !== JSON.stringify(expected.sort())) offenders.push(`${p}: ${globs} vs ${expected}`)
      // The same options too: a package on the DOM preset is checked by the UI program, one on the server's by the backend's.
      const preset = chainOf(join(PACKAGES, p, 'tsconfig.json'))[1]
      const want = program === 'backend' ? 'tsconfig.server.json' : 'tsconfig.dom.json'
      if (preset !== join(ROOT, want)) offenders.push(`${p}: extends ${preset}, its program uses ${want}`)
    }
    expect(offenders).toEqual([])
  })
})

describe('a killed compiler is said as such, never as a type error (#939)', () => {
  const ui = PROGRAMS.find(p => p.name === 'ui')!
  const backend = PROGRAMS.find(p => p.name === 'backend')!

  it('exit 137 / SIGKILL: killed, likely out of memory', () => {
    expect(compilerKilled(ui, 137, 'SIGKILL')).toBe('vue-tsc (ui) was killed (exit 137, SIGKILL, likely out of memory); this is not a type error')
    // The exit code alone is enough (a runtime that reports no signal).
    expect(compilerKilled(ui, 137, null)).toBe('vue-tsc (ui) was killed (exit 137, likely out of memory); this is not a type error')
  })

  it('another signal: killed, without the memory guess', () => {
    expect(compilerKilled(backend, 143, 'SIGTERM')).toBe('tsc (backend) was killed (exit 143, SIGTERM); this is not a type error')
  })

  it('a compiler that exited on its own is not killed: 0 clean, 1 or 2 errors, other codes its own failure', () => {
    for (const code of [0, 1, 2, 3, 127, 128]) expect(compilerKilled(ui, code, null)).toBeNull()
  })

  it('the programs run one after another, never side by side', () => {
    const source = readFileSync(join(ROOT, 'scripts/typecheck.ts'), 'utf8')
    expect(source).not.toMatch(/Promise\.all\(\s*programs/)
    expect(source).toMatch(/for \(const program of programs\) results\.push\(await run\(program\)\)/)
  })
})

describe('the baseline (FR-32.2)', () => {
  const output = [
    'packages/a/src/x.ts(10,3): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
    'packages/a/src/x.ts(40,1): error TS2345: Another one.',
    '  An elaboration on the line before, which is not an error of its own.',
    'C:\\repo\\packages\\b\\src\\Y.vue(2,9): error TS18047: \'user\' is possibly \'null\'.',
    'error TS2688: Cannot find type definition file for \'nothing\'.',
  ].join('\n')

  it('reads files and codes, relative to the repository, with forward slashes', () => {
    const d = parseDiagnostics(output, 'C:\\repo')
    expect(d.map(x => `${x.file} ${x.code}`)).toEqual([
      'packages/a/src/x.ts TS2345',
      'packages/a/src/x.ts TS2345',
      'packages/b/src/Y.vue TS18047',
      '(no file) TS2688',
    ])
    expect(countDiagnostics(d)).toEqual({
      '(no file)': { TS2688: 1 },
      'packages/a/src/x.ts': { TS2345: 2 },
      'packages/b/src/Y.vue': { TS18047: 1 },
    })
  })

  it('an error moved by an edit above it is the same error', () => {
    const before = countDiagnostics(parseDiagnostics('packages/a/src/x.ts(10,3): error TS2345: m'))
    const after = countDiagnostics(parseDiagnostics('packages/a/src/x.ts(55,3): error TS2345: m'))
    expect(compareCounts(before, after)).toEqual({ added: [], fixed: [] })
  })

  it('a new error, and a count that grew, are added; a count that fell is fixed', () => {
    const baseline = { 'a.ts': { TS2345: 2, TS2322: 1 }, 'b.ts': { TS7006: 3 } }
    const current = { 'a.ts': { TS2345: 3 }, 'b.ts': { TS7006: 1 }, 'c.ts': { TS2339: 1 } }
    expect(compareCounts(baseline, current)).toEqual({
      added: [{ file: 'a.ts', code: 'TS2345', was: 2, now: 3 }, { file: 'c.ts', code: 'TS2339', was: 0, now: 1 }],
      fixed: [{ file: 'a.ts', code: 'TS2322', was: 1, now: 0 }, { file: 'b.ts', code: 'TS7006', was: 3, now: 1 }],
    })
  })

  it('the rewrite refuses to add an error, and shrinks the list when errors were fixed', () => {
    const baseline = { 'a.ts': { TS2345: 2 } }
    expect(rewriteBaseline(baseline, { 'a.ts': { TS2345: 2 }, 'b.ts': { TS2322: 1 } })).toEqual({
      ok: false, added: [{ file: 'b.ts', code: 'TS2322', was: 0, now: 1 }],
    })
    expect(rewriteBaseline(baseline, { 'a.ts': { TS2345: 1 } })).toEqual({ ok: true, baseline: { 'a.ts': { TS2345: 1 } } })
    expect(rewriteBaseline(baseline, {})).toEqual({ ok: true, baseline: {} })
  })

  for (const name of ['backend', 'ui', 'desktop-ui']) {
    it(`${name}: the committed baseline lists files and codes with counts, sorted, and no line`, () => {
      const text = readFileSync(join(ROOT, 'scripts/typecheck', `${name}.baseline.json`), 'utf8').replace(/\r\n/g, '\n')
      const counts = parseBaseline(text)
      expect(serializeCounts(counts)).toBe(text)
      for (const file of Object.keys(counts)) expect(file).not.toMatch(/\(\d+,\d+\)|:\d+/)
      expect(totalOf(counts)).toBeGreaterThanOrEqual(0)
    })
  }
})
