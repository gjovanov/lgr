/**
 * What a night's run does not say by itself. Playwright's line reporter ends on "429 passed", and a
 * green run keeps no report, so nobody could see what it skipped or what only passed on a retry: a
 * flake here has been a real race twice, and a skip can be a seed that lost its data.
 *
 * Passed to Playwright by `nightly.ts`. The job summary on a runner, and stdout everywhere.
 */
import { appendFileSync } from 'node:fs'

type Test = {
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

function line(test: Test) {
  const name = test.titlePath().filter(Boolean).join(' › ')
  const skip = test.annotations.find(a => a.type === 'skip' || a.type === 'fixme')
  return `- ${name}${skip?.description ? `: ${skip.description}` : ''}`
}

export default class NightSummary {
  private suite?: Suite

  onBegin(_config: unknown, suite: Suite) {
    this.suite = suite
  }

  onEnd() {
    const tests = this.suite?.allTests() ?? []
    const out = (outcome: string) => tests.filter(t => t.outcome() === outcome)
    const parts = [
      `### e2e: ${out('expected').length} passed, ${out('flaky').length} flaky, ` +
        `${out('unexpected').length} failed, ${out('skipped').length} skipped`,
    ]
    for (const [outcome, title] of LISTS) {
      const list = out(outcome)
      if (list.length) parts.push(`**${title}**\n\n${list.map(line).join('\n')}`)
    }
    const text = `${parts.join('\n\n')}\n`
    console.log(`\n${text}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  }
}
