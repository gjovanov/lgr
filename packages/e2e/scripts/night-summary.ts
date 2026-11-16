/**
 * What a night's run does not say by itself. Playwright's line reporter ends on "429 passed", and a
 * green run keeps no report, so nobody could see what it skipped or what only passed on a retry: a
 * flake here has been a real race twice, and a skip can be a seed that lost its data.
 *
 * Passed to Playwright by `nightly.ts`. The job summary on a runner, and stdout everywhere.
 *
 * Where `NIGHT_FINDINGS_FILE` is set it also adds the failed and the retried tests to that file, a
 * line each. `night-findings.ts` reads it for the night's issue, which nobody has to open a run to
 * find. A night is two Playwright runs (the suite, then the master project), and both add to it.
 */
import { appendFileSync } from 'node:fs'

export type Test = {
  titlePath(): string[]
  outcome(): string
  annotations: { type: string; description?: string }[]
}
type Suite = { allTests(): Test[] }

const LISTS = [
  ['unexpected', 'Failed'],
  ['flaky', 'Passed only on a retry'],
  ['skipped', 'Skipped'],
] as const

/** What the findings file calls a test's outcome. Passed and skipped tests are not in it. */
const FINDING: Record<string, string> = { unexpected: 'failed', flaky: 'retried' }

/** A test's name on one line: its project, file and titles. */
export function testName(test: Test) {
  return test.titlePath().filter(Boolean).join(' › ').replace(/\s+/g, ' ').trim()
}

function line(test: Test) {
  const skip = test.annotations.find(a => a.type === 'skip' || a.type === 'fixme')
  return `- ${testName(test)}${skip?.description ? `: ${skip.description}` : ''}`
}

/** The summary: the counts, then the failed, the retried and the skipped tests by name. */
export function summaryText(tests: Test[]) {
  const out = (outcome: string) => tests.filter(t => t.outcome() === outcome)
  const parts = [
    `### e2e: ${out('expected').length} passed, ${out('flaky').length} flaky, ` +
      `${out('unexpected').length} failed, ${out('skipped').length} skipped`,
  ]
  for (const [outcome, title] of LISTS) {
    const list = out(outcome)
    if (list.length) parts.push(`**${title}**\n\n${list.map(line).join('\n')}`)
  }
  return `${parts.join('\n\n')}\n`
}

/** The lines for `NIGHT_FINDINGS_FILE`: `failed<TAB>name` or `retried<TAB>name`, and nothing for a clean run. */
export function findingLines(tests: Test[]) {
  return tests
    .filter(t => FINDING[t.outcome()])
    .map(t => `${FINDING[t.outcome()]}\t${testName(t)}\n`)
    .join('')
}

export default class NightSummary {
  private suite?: Suite

  onBegin(_config: unknown, suite: Suite) {
    this.suite = suite
  }

  onEnd() {
    const tests = this.suite?.allTests() ?? []
    const text = summaryText(tests)
    console.log(`\n${text}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
    if (process.env.NIGHT_FINDINGS_FILE) appendFileSync(process.env.NIGHT_FINDINGS_FILE, findingLines(tests))
  }
}
