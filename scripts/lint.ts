/**
 * FR-32.5 (#797): the linter CI runs, against a committed baseline that may only get shorter.
 *
 *   bun run lint             check against scripts/lint/baseline.json
 *   bun run lint --update    rewrite the baseline once findings were fixed (refuses while any were added)
 *
 * oxlint (D-1: the fastest linter that has the rules; ~10 s over the repository), configured in
 * `.oxlintrc.json`, with four rules and no others:
 * - `lgr/no-empty-catch`: a catch block with nothing in it, not even a comment saying why;
 * - `lgr/catch-drops-error`: a `.catch()` handler that takes no error (and says nothing about why);
 * - `lgr/no-as-any`: a new `as any`, in the API packages and `services` only;
 * - `typescript/no-floating-promises`: a promise neither awaited, returned, handled nor `void`ed.
 *   It reads types (`--type-aware`, oxlint-tsgolint) through each package's tsconfig.json, so it
 *   sees `.ts` files and not the script blocks of `.vue` files.
 * The first two and the third are this repository's own (`scripts/lint/lgr-plugin.js`): oxlint
 * has no rule that is exactly them.
 *
 * The baseline counts findings by file and rule, never by line (`scripts/lib/typecheck-baseline.ts`).
 *
 * ⚠ oxlint runs under Bun (`bun <its entry>`), never through `node_modules/.bin`: that is a
 * `#!/usr/bin/env node` script, and the self-hosted CI runner has no Node.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gate } from './lib/baseline-gate'
import type { Diagnostic } from './lib/typecheck-baseline'

const ROOT = resolve(import.meta.dir, '..')
export const LINT_BASELINE = join(ROOT, 'scripts', 'lint', 'baseline.json')
/** A rule as the baseline names it: `lgr/no-empty-catch`, `typescript/no-floating-promises`. */
export const RULE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/

interface OxlintReport {
  diagnostics: {
    message: string
    code: string
    filename: string
    labels?: { span: { line: number; column: number } }[]
  }[]
}

/** oxlint's JSON report as diagnostics. `typescript(no-floating-promises)` becomes `typescript/no-floating-promises`. */
export function lintDiagnostics(report: OxlintReport): Diagnostic[] {
  return report.diagnostics.map(d => {
    const span = d.labels?.[0]?.span
    const m = /^([^()]+)\(([^()]+)\)$/.exec(d.code)
    return {
      file: d.filename.replace(/\\/g, '/'),
      line: span?.line ?? 0,
      col: span?.column ?? 0,
      code: m ? `${m[1]}/${m[2]}` : d.code,
      message: d.message,
    }
  })
}

async function main() {
  const update = process.argv.includes('--update')
  const started = performance.now()
  // ⚠ The report goes to a FILE, never a pipe. On Linux oxlint's launcher exits before a large
  // report has drained into a pipe, and the first CI run read 64 KB of a 900 KB report: "no
  // report", on a runner, while Windows (whose pipe writes block) read it whole.
  const dir = mkdtempSync(join(tmpdir(), 'lgr-lint-'))
  const out = join(dir, 'report.json')
  let stdout: string, stderr: string, code: number
  try {
    const proc = Bun.spawn([process.execPath, join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint'), '--type-aware', '--format', 'json', 'packages'], {
      cwd: ROOT,
      stdout: Bun.file(out),
      stderr: 'pipe',
    })
    ;[stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    stdout = readFileSync(out, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  let report: OxlintReport
  try {
    report = JSON.parse(stdout)
  } catch {
    // Not a report: oxlint itself failed (a broken config, a plugin that does not load). Never a pass.
    const shown = stdout.length > 4000 ? `${stdout.slice(0, 2000)}\n…\n${stdout.slice(-2000)}` : stdout
    console.error(`${shown}\n${stderr}`)
    throw new Error(`oxlint exited ${code} without a report (${stdout.length} characters of output)`)
  }
  const diagnostics = lintDiagnostics(report)
  const seconds = (performance.now() - started) / 1000

  const r = gate({ name: 'lint', diagnostics, baselinePath: LINT_BASELINE, key: RULE, update, updateCommand: 'bun run lint --update' })

  const byRule = new Map<string, number>()
  for (const d of diagnostics) byRule.set(d.code, (byRule.get(d.code) ?? 0) + 1)
  const rules = [...byRule].sort(([a], [b]) => a.localeCompare(b))
  console.log(`\nlint: ${r.current} findings open, baseline ${r.baseline} (oxlint, ${seconds.toFixed(0)} s)`)
  for (const [rule, n] of rules) console.log(`  ${rule}: ${n}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = ['| rule | open |', '|---|---:|', ...rules.map(([rule, n]) => `| \`${rule}\` | ${n} |`)].join('\n')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lint (FR-32.5)\n\n${table}\n\n**${r.current}** findings open, baseline ${r.baseline}.\n`)
  }
  process.exit(r.failed ? 1 : 0)
}

if (import.meta.main) await main()
