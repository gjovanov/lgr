/**
 * What a night's issue says about its tests (`.github/workflows/e2e-nightly.yml`): how many failed,
 * how many passed only on a retry, and which. It reads the file `night-summary.ts` wrote during the
 * night's Playwright runs:
 *
 *   bun packages/e2e/scripts/night-findings.ts <file>
 *
 * It prints the three values, and on a runner they are the step's outputs. No file is an empty file:
 * the job ended before a test reported, and the issue says that instead.
 *
 * Why a retried test gets an issue at all: a retry starts a fresh worker, so "passed on its second
 * try" can be a test that one runner loses every time. On 2026-11-13 such a test failed 20 times of
 * 20 on the faster runner and passed 20 of 20 on the other, and the night had called it flaky.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export type Findings = { failed: string[]; retried: string[] }

/** The file's lines, `failed<TAB>name` or `retried<TAB>name`. Anything else in it is ignored. */
export function readFindings(text: string): Findings {
  const found: Findings = { failed: [], retried: [] }
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const kind = line.slice(0, tab)
    const name = line.slice(tab + 1).trim()
    if (name && (kind === 'failed' || kind === 'retried')) found[kind].push(name)
  }
  return found
}

const LISTS = [
  ['failed', 'Failed'],
  ['retried', 'Passed only on a retry'],
] as const

/**
 * The two lists as the issue shows them. A code block each, so a name is never read as markup or as
 * a mention. A list longer than `cap` says how many it leaves out: a job output has a size limit.
 */
export function findingsMarkdown(found: Findings, cap = 30) {
  const parts: string[] = []
  for (const [kind, title] of LISTS) {
    const names = found[kind]
    if (!names.length) continue
    const shown = names.slice(0, cap)
    if (names.length > cap) shown.push(`(and ${names.length - cap} more: the run's summary names them all)`)
    parts.push(`**${title} (${names.length})**\n\n\`\`\`\n${shown.join('\n')}\n\`\`\``)
  }
  return parts.join('\n\n')
}

/** The step's outputs as `$GITHUB_OUTPUT` takes them. The lists are several lines, fenced by a word no line of theirs is. */
export function stepOutputs(found: Findings, cap?: number) {
  const list = findingsMarkdown(found, cap)
  let fence = 'NIGHT_FINDINGS'
  while (list.split('\n').includes(fence)) fence += '_'
  return `failed=${found.failed.length}\nretried=${found.retried.length}\nfindings<<${fence}\n${list}\n${fence}\n`
}

if (import.meta.main) {
  const file = process.argv[2]
  const found = readFindings(file && existsSync(file) ? readFileSync(file, 'utf8') : '')
  const out = stepOutputs(found)
  console.log(out)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out)
}
