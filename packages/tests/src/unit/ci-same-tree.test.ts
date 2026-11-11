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
    expect(action).toContain('.workflow_run.head_repository_id == $repo')
    expect(action).toContain('--argjson repo "$REPO_ID"')
    expect(action).toContain('.expired == false')
  })
})

/**
 * The self-hosted runner image has git, curl and jq, and no `gh` (infra/ci-runner/Dockerfile). The
 * hosted image has all four, so a step written with `gh` passes every check that runs on a hosted
 * runner or on a developer's machine, and fails only where ci.yml's Linux jobs really run. The
 * same-tree lookup did exactly that: `gh: command not found`, and since it fails safe, nothing
 * went red: it simply never skipped (master run 42947738395, 2026-11-11).
 */
describe('nothing in the self-hosted jobs needs a tool the runner image does not have', () => {
  /** `gh <subcommand>` as a command, not inside a comment. */
  const callsGh = (line: string) => !/^\s*#/.test(line) && /(^|[\s"'$(|;&])gh\s+(api|run|pr|issue|release|workflow|attestation|auth)\b/.test(line)
  const image = readFileSync(join(ROOT, 'infra/ci-runner/Dockerfile'), 'utf8')

  it('the runner image is the one this is about: curl and jq, no gh', () => {
    expect(image).toMatch(/apt-get install[^\n]*\\\r?\n\s+ca-certificates curl git gnupg jq /)
    // If gh is ever installed there, this guard has nothing left to guard: delete it then.
    expect(/\bgh\b/.test(image.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n'))).toBe(false)
  })

  it('no step of ci.yml\'s Linux jobs calls gh, itself or through a local action', () => {
    const offenders: string[] = []
    for (const job of ['test-shard', 'test', 'build']) {
      for (const step of stepsOf(job)) {
        for (const line of step.lines) {
          if (callsGh(line)) offenders.push(`${job}: ${step.title}: ${line.trim().slice(0, 80)}`)
          const local = /uses: \.\/\.github\/actions\/([a-z0-9-]+)/.exec(line)?.[1]
          if (!local) continue
          const action = readFileSync(join(ROOT, '.github/actions', local, 'action.yml'), 'utf8')
          for (const l of action.split(/\r?\n/)) if (callsGh(l)) offenders.push(`${job}: ${step.title}: action ${local}: ${l.trim().slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the lookup asks the API with curl and reads the answer with jq', () => {
    const action = readFileSync(join(ROOT, '.github/actions/same-tree/action.yml'), 'utf8')
    expect(action).toContain('"$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts?name=$marker&per_page=30"')
    expect(action).toContain('curl -fsS')
    expect(action).toContain('jq -r --argjson repo "$REPO_ID"')
  })
})

describe('with one shard, the shard is the check a release gate reads', () => {
  it('the shard job is named `test (ubuntu)` when it is the only one', () => {
    expect(text).toContain("name: ${{ strategy.job-total == 1 && 'test (ubuntu)' || format('test (ubuntu, shard {0}/{1})', matrix.shard, strategy.job-total) }}")
  })

  it('the aggregate job runs only for several shards, under a plain name of its own', () => {
    const several = "(github.event.pull_request.head.repo.fork || !contains(vars.LGR_LINUX_RUNNER, 'self-hosted'))"
    // Plain: GitHub shows a SKIPPED job's `name:` unevaluated, so an expression there is what
    // every pull request lists. Its own: a second, skipped `test (ubuntu)` would fail the gate.
    const aggregate = text.split(/\r?\n/).slice(text.split(/\r?\n/).indexOf('  test:'))
    expect(aggregate[1]).toBe('    name: test (ubuntu, all shards)')
    expect(text).toContain(`if: \${{ !cancelled() && ${several} }}`)
    // The same predicate as the matrix: one shard exactly where the aggregate does not run.
    expect(text).toContain("shard: ${{ fromJSON(!github.event.pull_request.head.repo.fork && contains(vars.LGR_LINUX_RUNNER, 'self-hosted') && '[1]' || '[1, 2, 3]') }}")
  })

  it('the release gate reads the suite under either name, the one-shard name first', () => {
    const promote = readFileSync(join(ROOT, '.github/workflows/desktop-promote.yml'), 'utf8')
    expect(promote).toContain("'test (ubuntu)|test (ubuntu, all shards)|test + build (ubuntu)'")
  })

  it('no job that an `if:` can skip is named by an expression', () => {
    // A job's own `if:` is what skips it; `test-shard` has none, so its expression is always evaluated.
    const lines = text.split(/\r?\n/)
    const raw: string[] = []
    lines.forEach((l, i) => {
      if (!/^  [a-z][a-z0-9-]*:\s*$/.test(l)) return
      const body = lines.slice(i + 1, lines.findIndex((x, j) => j > i && /^  [a-z][a-z0-9-]*:\s*$/.test(x)) >>> 0)
      const name = body.find(x => /^    name: /.test(x)) ?? ''
      const skippable = body.some(x => /^    if: /.test(x))
      if (skippable && name.includes('${{')) raw.push(`${l.trim()} ${name.trim()}`)
    })
    expect(raw).toEqual([])
  })
})
