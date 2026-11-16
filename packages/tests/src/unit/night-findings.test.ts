import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findingLines, summaryText, testName, type Test } from '../../../e2e/scripts/night-summary'
import { findingsMarkdown, readFindings, stepOutputs } from '../../../e2e/scripts/night-findings'

/**
 * A scheduled e2e night says what it did not get through cleanly where somebody reads it: an issue
 * that names the failed tests, and one for a night that passed only because a test was tried again.
 * Until 2026-11-13 a green night with a retried test opened nothing, and that night's "1 flaky" was
 * a test the faster runner lost 20 times of 20: a retry starts a fresh worker, which hid it.
 *
 * Three parts carry it and each can be broken alone: the reporter leaves the names in a file
 * (`night-summary.ts`), a step turns the file into the job's outputs (`night-findings.ts`), and the
 * `report` job of `e2e-nightly.yml` decides from them. The last part is one condition and a script,
 * by hand, in a job that runs on nothing but a night that went wrong.
 */

const ROOT = resolve(import.meta.dir, '../../../..')

const test = (outcome: string, ...titles: string[]): Test => ({
  titlePath: () => ['', ...titles],
  outcome: () => outcome,
  annotations: outcome === 'skipped' ? [{ type: 'skip', description: 'no device on this runner' }] : [],
})
const NIGHT = [
  test('expected', 'portal', 'auth.spec.ts', 'signs in'),
  test('unexpected', 'invoicing-inventory', 'invoicing-crud.spec.ts', 'Invoicing CRUD', 'a quantity typed with a comma'),
  test('flaky', 'portal', 'reports.spec.ts', 'Reports app', 'the sales register  exports\tto PDF'),
  test('skipped', 'cash-register-fiscal', 'cash-register-fiscal.spec.ts', 'prints on the device'),
]

describe('the reporter leaves the failed and the retried tests for the issue', () => {
  it('names a test on one line, by project, file and titles', () => {
    expect(testName(NIGHT[1])).toBe('invoicing-inventory › invoicing-crud.spec.ts › Invoicing CRUD › a quantity typed with a comma')
    // A title's own tab or line break would be read as the file's.
    expect(testName(NIGHT[2])).toBe('portal › reports.spec.ts › Reports app › the sales register exports to PDF')
  })

  it('writes a line for each failed and each retried test, and none for the rest', () => {
    expect(findingLines(NIGHT)).toBe(
      'failed\tinvoicing-inventory › invoicing-crud.spec.ts › Invoicing CRUD › a quantity typed with a comma\n' +
      'retried\tportal › reports.spec.ts › Reports app › the sales register exports to PDF\n',
    )
    expect(findingLines([NIGHT[0], NIGHT[3]])).toBe('')
  })

  it('still prints the summary it printed before', () => {
    expect(summaryText(NIGHT)).toBe(
      '### e2e: 1 passed, 1 flaky, 1 failed, 1 skipped\n\n' +
      '**Failed**\n\n- invoicing-inventory › invoicing-crud.spec.ts › Invoicing CRUD › a quantity typed with a comma\n\n' +
      '**Passed only on a retry**\n\n- portal › reports.spec.ts › Reports app › the sales register exports to PDF\n\n' +
      '**Skipped**\n\n- cash-register-fiscal › cash-register-fiscal.spec.ts › prints on the device: no device on this runner\n',
    )
  })
})

describe('the findings file becomes the job\'s outputs', () => {
  // A night is two Playwright runs, and both add to the one file.
  const file = findingLines(NIGHT) + findingLines([test('flaky', 'master', 'master-status.spec.ts', 'the supervisor fresh')])

  it('reads both runs, and nothing that is not a finding', () => {
    expect(readFindings(file)).toEqual({
      failed: ['invoicing-inventory › invoicing-crud.spec.ts › Invoicing CRUD › a quantity typed with a comma'],
      retried: ['portal › reports.spec.ts › Reports app › the sales register exports to PDF', 'master › master-status.spec.ts › the supervisor fresh'],
    })
    expect(readFindings('')).toEqual({ failed: [], retried: [] })
    expect(readFindings('passed\tportal › a\r\nno tab here\r\nretried\t\r\nretried\tportal › b\r\n')).toEqual({ failed: [], retried: ['portal › b'] })
  })

  it('shows each list with its count, in a code block', () => {
    expect(findingsMarkdown(readFindings(file))).toBe(
      '**Failed (1)**\n\n```\ninvoicing-inventory › invoicing-crud.spec.ts › Invoicing CRUD › a quantity typed with a comma\n```\n\n' +
      '**Passed only on a retry (2)**\n\n```\nportal › reports.spec.ts › Reports app › the sales register exports to PDF\nmaster › master-status.spec.ts › the supervisor fresh\n```',
    )
    expect(findingsMarkdown({ failed: [], retried: ['portal › b'] })).toBe('**Passed only on a retry (1)**\n\n```\nportal › b\n```')
    expect(findingsMarkdown({ failed: [], retried: [] })).toBe('')
  })

  it('cuts a long list and says how many it left out', () => {
    const failed = Array.from({ length: 34 }, (_, i) => `portal › t${i}`)
    const shown = findingsMarkdown({ failed, retried: [] }, 30).split('\n')
    expect(shown[0]).toBe('**Failed (34)**')
    expect(shown.filter(l => l.startsWith('portal › '))).toHaveLength(30)
    expect(shown.at(-2)).toBe("(and 4 more: the run's summary names them all)")
    // At the cap itself nothing is left out.
    expect(findingsMarkdown({ failed: failed.slice(0, 30), retried: [] }, 30)).not.toContain('more')
  })

  /** `$GITHUB_OUTPUT` as a runner reads it: `name=value`, or `name<<WORD` and lines up to that word. */
  function parseOutputs(text: string) {
    const out: Record<string, string> = {}
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const block = /^([a-z]+)<<(.+)$/.exec(lines[i])
      if (block) {
        const end = lines.indexOf(block[2], i + 1)
        out[block[1]] = lines.slice(i + 1, end).join('\n')
        i = end
      } else if (lines[i].includes('=')) {
        out[lines[i].slice(0, lines[i].indexOf('='))] = lines[i].slice(lines[i].indexOf('=') + 1)
      }
    }
    return out
  }

  it('gives the counts and the lists as a runner reads them back', () => {
    const found = readFindings(file)
    expect(parseOutputs(stepOutputs(found))).toEqual({ failed: '1', retried: '2', findings: findingsMarkdown(found) })
    // A clean night: the `report` job's condition compares this count with '0'.
    expect(parseOutputs(stepOutputs({ failed: [], retried: [] }))).toEqual({ failed: '0', retried: '0', findings: '' })
  })

  it('fences the lists with a word that no line of them is', () => {
    const found = { failed: ['NIGHT_FINDINGS', 'NIGHT_FINDINGS_'], retried: [] }
    expect(parseOutputs(stepOutputs(found)).findings).toBe(findingsMarkdown(found))
  })
})

describe('e2e-nightly.yml hands them to the job that files the issue', () => {
  const lines = readFileSync(join(ROOT, '.github/workflows/e2e-nightly.yml'), 'utf8').split(/\r?\n/)

  /** A job's own lines: from `  <job>:` to the next job. */
  function jobLines(job: string) {
    const start = lines.indexOf(`  ${job}:`)
    if (start < 0) throw new Error(`e2e-nightly.yml has no job ${job}`)
    const end = lines.findIndex((l, i) => i > start && /^  [a-z][a-z0-9-]*:\s*$/.test(l))
    return lines.slice(start, end < 0 ? lines.length : end)
  }
  /** A job's steps by name, each with its lines, comments left out. */
  function stepsOf(job: string) {
    const out: { title: string; lines: string[] }[] = []
    for (const l of jobLines(job)) {
      const head = /^      - (?:name|uses): (.*)$/.exec(l)
      if (head) out.push({ title: head[1], lines: [l] })
      else if (out.length && !/^\s*#/.test(l)) out.at(-1)!.lines.push(l)
    }
    return out
  }
  const conditionOf = (step: { lines: string[] }) => step.lines.map(l => /^        if: (.*)$/.exec(l)?.[1]).find(Boolean) ?? ''
  const e2e = stepsOf('e2e')
  const at = (title: string) => {
    const i = e2e.findIndex(s => s.title === title)
    if (i < 0) throw new Error(`the e2e job has no step "${title}"`)
    return i
  }

  it('both Playwright runs write to the file, and the count comes after both', () => {
    const named = e2e.findIndex(s => s.lines.some(l => l.includes('NIGHT_FINDINGS_FILE=') && l.includes('"$GITHUB_ENV"')))
    expect(named).toBeGreaterThan(0)
    // Started empty: a self-hosted runner keeps its folders, and last night's names are not tonight's.
    expect(e2e[named].lines.some(l => l.trim() === ': > "$RUNNER_TEMP/night-findings.tsv"')).toBe(true)
    const count = e2e.findIndex(s => s.lines.some(l => l.trim() === 'id: findings'))
    expect(at('Run the suite')).toBeGreaterThan(named)
    expect(at('Run the master project')).toBeGreaterThan(at('Run the suite'))
    expect(count).toBeGreaterThan(at('Run the master project'))
    expect(e2e[count].lines.some(l => l.trim() === 'run: bun packages/e2e/scripts/night-findings.ts "$NIGHT_FINDINGS_FILE"')).toBe(true)
    // It counts on a red night too, or that night's issue names nothing.
    expect(conditionOf(e2e[count])).toBe('${{ !cancelled() }}')
    // Both runs report through the reporter that writes the file.
    expect(e2e[at('Run the master project')].lines.join('\n')).toContain('./scripts/night-summary.ts')
    expect(readFileSync(join(ROOT, 'packages/e2e/scripts/nightly.ts'), 'utf8')).toContain('./scripts/night-summary.ts')
  })

  it('the job gives out the counts and the lists', () => {
    const job = jobLines('e2e').map(l => l.trim())
    for (const name of ['failed', 'retried', 'findings']) expect(job).toContain(`${name}: \${{ steps.findings.outputs.${name} }}`)
  })

  it('a red night keeps its report, and so does one that passed on a retry', () => {
    const upload = at('Upload the report')
    expect(conditionOf(e2e[upload])).toBe("${{ failure() || steps.findings.outputs.retried != '0' }}")
    // The count it reads has to exist by then.
    expect(upload).toBeGreaterThan(e2e.findIndex(s => s.lines.some(l => l.trim() === 'id: findings')))
  })

  it('the issue job runs for a night that did not pass or needed a retry, and not for a clean one', () => {
    const job = jobLines('report')
    const condition = job.map(l => /^    if: \$\{\{ (.*) \}\}$/.exec(l)?.[1]).find(Boolean) ?? ''
    // Without a status check first, GitHub adds `success() &&`: the job would be skipped whenever the night failed.
    expect(condition.startsWith('!cancelled() && ')).toBe(true)
    expect(condition).toContain("github.event_name != 'pull_request'")
    expect(condition.endsWith("(needs.e2e.result != 'success' || needs.e2e.outputs.retried != '0')")).toBe(true)
    expect(job.some(l => l.trim() === 'needs: e2e')).toBe(true)
  })

  it('test names reach the script as data, and only a scheduled night files', () => {
    const step = stepsOf('report').find(s => s.title === 'File or update an issue')!
    const run = step.lines.slice(step.lines.findIndex(l => l.trim() === 'run: |') + 1)
    expect(run.length).toBeGreaterThan(10)
    // An expression inside the script's text would paste a test's title into the shell.
    expect(run.filter(l => l.includes('${{'))).toEqual([])
    const env = step.lines.map(l => l.trim())
    expect(env).toContain('RETRIED: ${{ needs.e2e.outputs.retried }}')
    expect(env).toContain('FINDINGS: ${{ needs.e2e.outputs.findings }}')
    expect(env).toContain('RESULT: ${{ needs.e2e.result }}')
    // The exit for a run started by hand comes before the first call that writes.
    const text = run.map(l => l.trim())
    const byHand = text.indexOf('if [ "$GITHUB_EVENT_NAME" != schedule ]; then')
    const firstCall = text.findIndex(l => /\bgh issue\b/.test(l))
    expect(byHand).toBeGreaterThan(0)
    expect(text.slice(byHand, firstCall)).toContain('exit 0')
    expect(firstCall).toBeGreaterThan(byHand)
  })

  it('a pull request that changes any of the three runs the night itself', () => {
    const paths = lines.map(l => /^      - '(.+)'$/.exec(l)?.[1]).filter(Boolean)
    for (const p of ['.github/workflows/e2e-nightly.yml', 'packages/e2e/scripts/night-summary.ts', 'packages/e2e/scripts/night-findings.ts']) expect(paths).toContain(p)
  })
})
