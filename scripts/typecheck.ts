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
 * Why a baseline, and how it is keyed: `scripts/lib/typecheck-baseline.ts`.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  compareCounts, countDiagnostics, parseBaseline, parseDiagnostics, rewriteBaseline, serializeCounts, totalOf,
  type Change, type Counts, type Diagnostic,
} from './lib/typecheck-baseline'

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
  const proc = Bun.spawn([process.execPath, ENTRY[program.compiler](), '--noEmit', '--pretty', 'false', '-p', program.project], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const diagnostics = parseDiagnostics(stdout + '\n' + stderr, ROOT)
  // 0: clean. 1 or 2: it printed errors. Anything else, or a failure that printed none, is the
  // compiler itself failing, and never a pass.
  if ((code !== 0 && !diagnostics.length) || code > 2) {
    console.error(stdout + stderr)
    throw new Error(`${program.compiler} -p ${program.project} exited ${code}`)
  }
  return { program, diagnostics, seconds: (performance.now() - started) / 1000 }
}

function readBaseline(name: string): Counts {
  const path = baselinePath(name)
  return existsSync(path) ? parseBaseline(readFileSync(path, 'utf8')) : {}
}

const annotate = process.env.GITHUB_ACTIONS === 'true'
const escape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

function explainAdded(name: string, added: Change[], diagnostics: Diagnostic[]) {
  console.log(`\n${name}: ${added.length} new or grown (file, code):`)
  for (const a of added) {
    console.log(`  ${a.file}  ${a.code}: baseline ${a.was}, now ${a.now}`)
    // The baseline has no lines, so which of them is the new one cannot be told: all are shown.
    for (const d of diagnostics.filter(x => x.file === a.file && x.code === a.code)) {
      console.log(`    ${d.file}(${d.line},${d.col}): ${d.message}`)
      if (annotate) console.log(`::error file=${d.file},line=${d.line},col=${d.col},title=${d.code}::${escape(d.message)}`)
    }
  }
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
    const baseline = readBaseline(program.name)
    const current = countDiagnostics(diagnostics)
    const { added, fixed } = compareCounts(baseline, current)
    console.log(`${program.name}: ${totalOf(current)} errors, baseline ${totalOf(baseline)} (${program.compiler}, ${seconds.toFixed(0)} s)`)
    summary.push(`| ${program.name} | ${totalOf(current)} | ${totalOf(baseline)} | ${seconds.toFixed(0)} s |`)

    if (update) {
      // The first baseline of a program is what it reports: there is nothing for it to shrink from.
      if (!existsSync(baselinePath(program.name))) {
        writeFileSync(baselinePath(program.name), serializeCounts(current))
        console.log(`${program.name}: first baseline written, ${totalOf(current)} errors`)
        continue
      }
      const next = rewriteBaseline(baseline, current)
      if (!next.ok) {
        failed = true
        console.log(`${program.name}: the baseline is NOT rewritten: it may only get shorter, and these are new.`)
        console.log('  Fix them. (A file that was moved or renamed takes its errors with it: they count as new under its new name.)')
        explainAdded(program.name, next.added, diagnostics)
      } else if (fixed.length) {
        writeFileSync(baselinePath(program.name), serializeCounts(next.baseline))
        console.log(`${program.name}: baseline rewritten, ${totalOf(baseline)} -> ${totalOf(next.baseline)}`)
      } else {
        console.log(`${program.name}: the baseline is current`)
      }
      continue
    }

    if (added.length) {
      failed = true
      explainAdded(program.name, added, diagnostics)
    }
    if (fixed.length) {
      failed = true
      console.log(`\n${program.name}: ${fixed.length} (file, code) have fewer errors than the baseline says. Well done:`)
      for (const f of fixed) console.log(`  ${f.file}  ${f.code}: baseline ${f.was}, now ${f.now}`)
      console.log('  Shrink the baseline with `bun run typecheck --update` and commit it, so they cannot come back unseen.')
      if (annotate) console.log(`::error title=typecheck baseline::${program.name}: errors were fixed; run \`bun run typecheck --update\` and commit the baseline`)
    }
  }

  const total = results.reduce((n, r) => n + r.diagnostics.length, 0)
  console.log(`\ntotal: ${total} type errors open (${results.map(r => `${r.program.name} ${r.diagnostics.length}`).join(', ')})`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Type-check (FR-32)\n\n${summary.join('\n')}\n\n**${total}** type errors open.\n`)
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.main) await main()
