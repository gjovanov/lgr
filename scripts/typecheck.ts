/**
 * FR-32.2 / FR-32.3 (#797): the type-check CI runs, against a committed baseline that may only
 * get shorter.
 *
 *   bun run typecheck                    check every program against its baseline
 *   bun run typecheck --update           rewrite the baselines once errors were fixed (refuses
 *                                        while any were added)
 *   bun run typecheck --only backend     one program (backend | ui | desktop-ui)
 *
 * Three programs, each with its own baseline in `scripts/typecheck/<name>.baseline.json`:
 * - `backend`: `tsc` over the server's packages (`scripts/typecheck/backend.tsconfig.json`);
 * - `ui`: `vue-tsc` over the web app's packages (`scripts/typecheck/ui.tsconfig.json`);
 * - `desktop-ui`: `vue-tsc` over the desktop shell's own pages (its own tsconfig.json).
 * They run side by side: each compiler is single-threaded.
 *
 * ⚠ The compilers run under Bun (`bun <their entry file>`), never through `node_modules/.bin`:
 * those are `#!/usr/bin/env node` scripts, and the self-hosted CI runner has no Node.
 *
 * Why a baseline, and how it is keyed: `scripts/lib/typecheck-baseline.ts`. The linter
 * (`scripts/lint.ts`) runs its findings through the same gate (`scripts/lib/baseline-gate.ts`).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDiagnostics, TS_CODE, type Diagnostic } from './lib/typecheck-baseline'
import { gate } from './lib/baseline-gate'

const ROOT = resolve(import.meta.dir, '..')

interface Program {
  name: string
  compiler: 'tsc' | 'vue-tsc'
  project: string
}

export const PROGRAMS: Program[] = [
  { name: 'backend', compiler: 'tsc', project: 'scripts/typecheck/backend.tsconfig.json' },
  { name: 'ui', compiler: 'vue-tsc', project: 'scripts/typecheck/ui.tsconfig.json' },
  { name: 'desktop-ui', compiler: 'vue-tsc', project: 'packages/desktop-ui/tsconfig.json' },
]

export const baselinePath = (name: string) => join(ROOT, 'scripts', 'typecheck', `${name}.baseline.json`)

const ENTRY = {
  tsc: () => require.resolve('typescript/lib/tsc.js', { paths: [ROOT] }),
  'vue-tsc': () => require.resolve('vue-tsc/bin/vue-tsc.js', { paths: [ROOT] }),
}

interface Result {
  program: Program
  diagnostics: Diagnostic[]
  seconds: number
}

async function run(program: Program): Promise<Result> {
  const started = performance.now()
  // ⚠ The compiler's output goes to a FILE, never a pipe. A process that exits while its output
  // is still draining into a pipe loses the rest on Linux (Windows pipe writes block, so it never
  // shows there): the linter's first CI run read 64 KB of its report. Here a lost tail would be
  // errors that look fixed.
  const dir = mkdtempSync(join(tmpdir(), 'lgr-typecheck-'))
  const out = join(dir, 'out.txt')
  let stdout: string, stderr: string, code: number
  try {
    const proc = Bun.spawn([process.execPath, ENTRY[program.compiler](), '--noEmit', '--pretty', 'false', '-p', program.project], {
      cwd: ROOT,
      stdout: Bun.file(out),
      stderr: 'pipe',
    })
    ;[stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    stdout = readFileSync(out, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const diagnostics = parseDiagnostics(stdout + '\n' + stderr, ROOT)
  // 0: clean. 1 or 2: it printed errors. Anything else, or a failure that printed none, is the
  // compiler itself failing, and never a pass.
  if ((code !== 0 && !diagnostics.length) || code > 2) {
    console.error(stdout + stderr)
    throw new Error(`${program.compiler} -p ${program.project} exited ${code}`)
  }
  return { program, diagnostics, seconds: (performance.now() - started) / 1000 }
}

async function main() {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
  const programs = PROGRAMS.filter(p => !only || p.name === only)
  if (!programs.length) {
    console.error(`--only: no program named ${only} (${PROGRAMS.map(p => p.name).join(', ')})`)
    process.exit(2)
  }

  const results = await Promise.all(programs.map(run))
  let failed = false
  const summary: string[] = ['| program | errors | baseline | took |', '|---|---:|---:|---:|']

  for (const { program, diagnostics, seconds } of results) {
    const r = gate({
      name: program.name,
      diagnostics,
      baselinePath: baselinePath(program.name),
      key: TS_CODE,
      update,
      updateCommand: 'bun run typecheck --update',
    })
    console.log(`${program.name}: ${r.current} errors, baseline ${r.baseline} (${program.compiler}, ${seconds.toFixed(0)} s)`)
    summary.push(`| ${program.name} | ${r.current} | ${r.baseline} | ${seconds.toFixed(0)} s |`)
    failed ||= r.failed
  }

  const total = results.reduce((n, r) => n + r.diagnostics.length, 0)
  console.log(`\ntotal: ${total} type errors open (${results.map(r => `${r.program.name} ${r.diagnostics.length}`).join(', ')})`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Type-check (FR-32)\n\n${summary.join('\n')}\n\n**${total}** type errors open.\n`)
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.main) await main()
