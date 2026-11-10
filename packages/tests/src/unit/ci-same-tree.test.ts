import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * ci.yml's two Linux jobs do nothing when their exact tree already passed (.github/actions/same-tree):
 * every step after the lookup is conditional on its answer. That is one condition per step, by hand,
 * and a step added without it does not fail the pull request that adds it. It runs on a commit whose
 * setup steps were skipped, so `Clippy` finds no toolchain and `Test` no dependencies: master goes
 * red on the first merge whose tree had passed, for a reason that is not in the commit.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const text = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const SKIP = "steps.same.outputs.skip != 'true'"

interface Step { title: string; lines: string[] }

/** A job's steps: each starts at `      - name:` or `      - uses:` and runs to the next. */
function stepsOf(job: string): Step[] {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(`  ${job}:`)
  if (start < 0) throw new Error(`ci.yml has no job ${job}`)
  let end = lines.findIndex((l, i) => i > start && /^  [a-z][a-z0-9-]*:\s*$/.test(l))
  if (end < 0) end = lines.length
  const out: Step[] = []
  for (const l of lines.slice(start, end)) {
    const head = /^      - (?:name|uses): (.*)$/.exec(l)
    if (head) out.push({ title: head[1], lines: [l] })
    else if (out.length && !/^\s*#/.test(l)) out.at(-1)!.lines.push(l)
  }
  return out
}
const conditionOf = (s: Step) => s.lines.map(l => /^        if: (.*)$/.exec(l)?.[1]).find(Boolean) ?? ''

describe('a job whose tree already passed does nothing, and says so', () => {
  for (const [job, lane] of [['test-shard', 'test'], ['build', 'build']] as const) {
    const steps = stepsOf(job)
    const at = steps.findIndex(s => s.lines.some(l => l.trim() === 'id: same'))

    it(`${job}: the lookup comes right after the checkout, for its own lane`, () => {
      expect(at).toBeGreaterThan(0)
      expect(steps[at - 1].lines[0]).toContain('actions/checkout@')
      expect(steps[at].lines.some(l => l.trim() === 'uses: ./.github/actions/same-tree')).toBe(true)
      expect(steps[at].lines.some(l => l.trim() === `lane: ${lane}`)).toBe(true)
    })

    it(`${job}: every step after it is conditional on its answer`, () => {
      const unconditional = steps.slice(at + 1).filter(s => !conditionOf(s).startsWith(SKIP)).map(s => s.title)
      expect({ job, unconditional }).toEqual({ job, unconditional: [] })
      // `always()` or `failure()` in a condition would run the step whatever the lookup said.
      const overriding = steps.slice(at + 1).filter(s => /\b(always|failure|cancelled)\(\)/.test(conditionOf(s))).map(s => s.title)
      expect({ job, overriding }).toEqual({ job, overriding: [] })
    })

    it(`${job}: the marker is its last step, so it exists only for a job that passed whole`, () => {
      const last = steps.at(-1)!
      expect(last.lines.some(l => l.includes('actions/upload-artifact@'))).toBe(true)
      expect(last.lines.some(l => l.trim() === 'name: ${{ steps.same.outputs.marker }}')).toBe(true)
    })
  }

  it('the two lanes have markers of their own', () => {
    const lanes = [...text.matchAll(/^\s+lane: (\S+)$/gm)].map(m => m[1])
    expect(lanes.sort()).toEqual(['build', 'test'])
  })

  it('the workflow may list artifacts, which is how a marker is found', () => {
    expect(text).toMatch(/^permissions:\r?\n  contents: read\r?\n(?:  #.*\r?\n)*  actions: read$/m)
  })

  it('only master\'s first run of a commit can skip, and a fork\'s marker is not one', () => {
    const action = readFileSync(join(ROOT, '.github/actions/same-tree/action.yml'), 'utf8')
    expect(action).toContain("MAY_SKIP: ${{ github.event_name == 'push' && github.ref == 'refs/heads/master' && github.run_attempt == 1 }}")
    expect(action).toContain('.workflow_run.head_repository_id == (env.REPO_ID | tonumber)')
    expect(action).toContain('.expired == false')
  })
})

describe('with one shard, the shard is the check a release gate reads', () => {
  it('the shard job is named `test (ubuntu)` when it is the only one', () => {
    expect(text).toContain("name: ${{ strategy.job-total == 1 && 'test (ubuntu)' || format('test (ubuntu, shard {0}/{1})', matrix.shard, strategy.job-total) }}")
  })

  it('the aggregate job runs only for several shards, and never under that name when skipped', () => {
    const several = "(github.event.pull_request.head.repo.fork || !contains(vars.LGR_LINUX_RUNNER, 'self-hosted'))"
    expect(text).toContain(`name: \${{ ${several} && 'test (ubuntu)' || 'test shards together (not needed with one shard)' }}`)
    expect(text).toContain(`if: \${{ !cancelled() && ${several} }}`)
    // The same predicate as the matrix: one shard exactly where the aggregate does not run.
    expect(text).toContain("shard: ${{ fromJSON(!github.event.pull_request.head.repo.fork && contains(vars.LGR_LINUX_RUNNER, 'self-hosted') && '[1]' || '[1, 2, 3]') }}")
  })
})
