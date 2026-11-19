import { describe, it, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { MANIFEST, REPO_ROOT } from '../../../../scripts/lib/server-package.ts'
import { checkBuildKind, packageTestKeys, supervisorTestKeys } from '../../../../scripts/check-build-kind.ts'

/**
 * A TEST build of the server (FR-20 plan F.4.4) is how the field lanes' masters come to trust the keys
 * their throwaway global makes for one run. The release workflow makes one only on a dispatch with
 * `test_keys`, through the server-version action, and never signs or publishes it. Here: the action's
 * own script, run in bash against a scratch checkout; the check that reads a build's kind back from
 * its bytes; and the wiring that puts both in every job that builds.
 */

const scratch = mkdtempSync(join(tmpdir(), 'lgr-test-build-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

const KIND = join(REPO_ROOT, 'packages', 'config', 'src', 'build-kind.json')
type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }
type Job = { if?: string; steps: Step[] }
const ACTION = Bun.YAML.parse(readFileSync(join(REPO_ROOT, '.github', 'actions', 'server-version', 'action.yml'), 'utf8')) as {
  runs: { steps: Step[] }
}
const WORKFLOW = Bun.YAML.parse(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'server-release.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } }
  jobs: Record<string, Job>
}

/** Git's bash on Windows (never WSL's System32 launcher), any bash elsewhere. */
function findBash(): string | null {
  if (process.platform !== 'win32') return Bun.which('bash')
  const candidates = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), Bun.which('bash')]
  return candidates.find((p): p is string => !!p && existsSync(p) && !/system32/i.test(p)) ?? null
}
const BASH = findBash()

/** A checkout holding what the action reads: Cargo.toml's version and build-kind.json. */
function checkout(kind = readFileSync(KIND, 'utf8'), version = '0.1.15'): string {
  const dir = join(scratch, `tree-${++n}`)
  mkdirSync(join(dir, 'packages', 'config', 'src'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'server'), { recursive: true })
  writeFileSync(join(dir, 'packages', 'server', 'Cargo.toml'), `[package]\nname = "lgr-server"\nversion = "${version}"\n`)
  writeFileSync(join(dir, 'packages', 'config', 'src', 'build-kind.json'), kind)
  return dir
}

/** Runs the action's script in `dir` as the runner would, with `env` for the event and inputs. */
function runAction(dir: string, env: Record<string, string>) {
  const output = join(dir, 'github-output').replace(/\\/g, '/')
  writeFileSync(output, '')
  writeFileSync(join(dir, 'github-env'), '')
  const path = process.platform === 'win32' && BASH
    ? [dirname(BASH), join(dirname(dirname(BASH)), 'usr', 'bin'), process.env.PATH].join(delimiter)
    : process.env.PATH ?? ''
  // The runner's own GITHUB_* and INPUT_* (when this runs in CI) are all overridden here.
  const r = Bun.spawnSync([BASH!, '-c', ACTION.runs.steps[0].run!], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: path, GITHUB_OUTPUT: output, GITHUB_ENV: join(dir, 'github-env').replace(/\\/g, '/'),
      GITHUB_REF: '', INPUT_VERSION: '', INPUT_PUBLISH: 'false', INPUT_TEST_KEYS: '', ...env,
    },
  })
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  return { code: r.exitCode, log: r.stdout.toString() + r.stderr.toString(), outputs, kind: readFileSync(join(dir, 'packages', 'config', 'src', 'build-kind.json'), 'utf8') }
}

const DISPATCH = { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_VERSION: '0.1.15' }

describe.skipIf(!BASH)('the server-version action makes a test build only where it may (FR-20 plan F.4.4)', () => {
  it('a dispatch that asks for one makes this checkout a test build, unsigned and unpublished', () => {
    const committed = readFileSync(KIND, 'utf8')
    const r = runAction(checkout(), { ...DISPATCH, INPUT_TEST_KEYS: 'true' })
    expect(r.code).toBe(0)
    expect(r.outputs).toEqual({ version: '0.1.15', tag: 'server-v0.1.15', release: 'false', sign: 'false', test_keys: 'true' })
    expect(JSON.parse(r.kind).testKeys).toBe(true)
    // One value changed, nothing else in the file.
    expect(r.kind).toBe(committed.replace('"testKeys": false', '"testKeys": true'))
  })

  it('keeps a Windows checkout CRLF and valid', () => {
    const crlf = readFileSync(KIND, 'utf8').replace(/\r?\n/g, '\r\n')
    const r = runAction(checkout(crlf), { ...DISPATCH, INPUT_TEST_KEYS: 'true' })
    expect(r.code).toBe(0)
    expect(r.kind).toBe(crlf.replace('"testKeys": false', '"testKeys": true'))
    expect(JSON.parse(r.kind).testKeys).toBe(true)
  })

  it('refuses one that would be published, one on a tag or a pull request, and an input that is not a boolean', () => {
    const refusals: [Record<string, string>, string][] = [
      [{ ...DISPATCH, INPUT_TEST_KEYS: 'true', INPUT_PUBLISH: 'true' }, 'never published'],
      [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/server-v0.1.15', INPUT_TEST_KEYS: 'true' }, 'only a dispatch'],
      [{ GITHUB_EVENT_NAME: 'pull_request', INPUT_TEST_KEYS: 'true' }, 'only a dispatch'],
      [{ ...DISPATCH, INPUT_TEST_KEYS: 'yes' }, 'not true or false'],
    ]
    for (const [env, why] of refusals) {
      const r = runAction(checkout(), env)
      expect(r.code).toBe(1)
      expect(r.log).toContain(why)
      expect(r.outputs).toEqual({})
      expect(JSON.parse(r.kind).testKeys).toBe(false)
    }
  })

  it('refuses a checkout whose file does not say false: what it would flip is not there', () => {
    for (const kind of ['{\n  "testKeys": true\n}\n', '{"testKeys":false}\n', '{\n  "about": "x"\n}\n']) {
      const r = runAction(checkout(kind), { ...DISPATCH, INPUT_TEST_KEYS: 'true' })
      expect(r.code).toBe(1)
      expect(r.kind).toBe(kind)
    }
  })

  it('leaves every other run as it was: a release dispatch, a tag and a pull request', () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ ...DISPATCH, INPUT_TEST_KEYS: 'false' }, { release: 'false', sign: 'true' }],
      [{ ...DISPATCH, INPUT_PUBLISH: 'true' }, { release: 'true', sign: 'true' }],
      [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/server-v0.1.15' }, { release: 'true', sign: 'true' }],
      [{ GITHUB_EVENT_NAME: 'pull_request' }, { release: 'false', sign: 'false' }],
    ]
    for (const [env, want] of cases) {
      const committed = readFileSync(KIND, 'utf8')
      const r = runAction(checkout(committed), env)
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual({ version: '0.1.15', tag: 'server-v0.1.15', ...want, test_keys: 'false' })
      expect(r.kind).toBe(committed)
    }
  })
})

describe('check-build-kind reads a build back from its bytes', () => {
  const pkg = (manifest: string | null) => {
    const dir = join(scratch, `pkg-${++n}`)
    mkdirSync(dir, { recursive: true })
    if (manifest !== null) writeFileSync(join(dir, MANIFEST), manifest)
    return dir
  }
  const noise = Buffer.from([0, 1, 2, 0xff, 0x7f, 10, 13, 0])
  const binary = (...parts: string[]) => Buffer.concat([noise, ...parts.map(p => Buffer.from(p)), noise])

  it('the API package: its manifest, and only a boolean counts', () => {
    expect(packageTestKeys(pkg('{"testKeys": true}'))).toBe(true)
    expect(packageTestKeys(pkg('{"testKeys": false}'))).toBe(false)
    for (const m of ['{"testKeys": "true"}', '{}', 'not json', null]) expect(packageTestKeys(pkg(m))).toBeNull()
  })

  it('the supervisor: the line of build-kind.json it embeds, as committed and as a test build makes it', () => {
    const committed = readFileSync(KIND, 'utf8')
    expect(supervisorTestKeys(binary(committed))).toBe(false)
    expect(supervisorTestKeys(binary(committed.replace(/\r?\n/g, '\r\n')))).toBe(false)
    expect(supervisorTestKeys(binary(committed.replace('"testKeys": false', '"testKeys": true')))).toBe(true)
    // Neither or both is no answer.
    expect(supervisorTestKeys(binary('{"about": "x"}'))).toBeNull()
    expect(supervisorTestKeys(binary('"testKeys": true', '"testKeys": false'))).toBeNull()
  })

  it('finds every part of another kind, or of none, and passes the parts of the kind it wants', () => {
    const release = pkg('{"testKeys": false}')
    const test = pkg('{"testKeys": true}')
    const none = pkg(null)
    const sup = join(scratch, `sup-${++n}`)
    const missing = join(scratch, 'no-such-binary')
    writeFileSync(sup, binary('"testKeys": false'))
    expect(checkBuildKind(false, { packages: [release], supervisors: [sup] })).toEqual([])
    const found = checkBuildKind(true, { packages: [release, test, none], supervisors: [sup, missing] })
    expect(found.map(f => f.path)).toEqual([join(release, MANIFEST), join(none, MANIFEST), sup, missing])
    expect(found[0].detail).toBe('is a release build, and this run makes a TEST build')
    expect(found[1].detail).toContain('does not say')
    expect(found[3].detail).toContain('no such file')
  })
})

describe('the release workflow wires it into every job that builds', () => {
  const jobs = WORKFLOW.jobs
  const stepNamed = (job: string, name: string) => jobs[job].steps.find(s => s.name === name)

  it('a dispatch asks for a test build with a boolean that is off unless set', () => {
    expect(WORKFLOW.on.workflow_dispatch.inputs.test_keys).toMatchObject({ type: 'boolean', default: false })
  })

  it('every job that runs the action passes the input on, but `adopt`, which only a tag runs', () => {
    const callers = Object.entries(jobs).filter(([, j]) => j.steps.some(s => s.uses === './.github/actions/server-version'))
    expect(callers.map(([name]) => name)).toEqual(['adopt', 'package', 'windows', 'linux', 'linux-test', 'image'])
    for (const [name, job] of callers.slice(1)) {
      const v = job.steps.find(s => s.uses === './.github/actions/server-version')!
      expect(v.with?.test_keys, name).toBe('${{ inputs.test_keys }}')
    }
  })

  it('each building job reads back the kind it made, and `sign` refuses a test build before it signs anything', () => {
    expect(stepNamed('package', 'Check the package')?.run).toContain('bun scripts/check-build-kind.ts --want "$TEST_KEYS" --package dist/lgr-server')
    for (const [job, bin] of [['windows', 'lgr-server.exe'], ['linux', 'lgr-server']]) {
      expect(stepNamed(job, 'One kind of build')?.run, job).toContain(`--package dist/lgr-server --supervisor packages/server/target/release/${bin}`)
    }
    const sign = jobs.sign.steps.map(s => s.name)
    const guard = sign.indexOf("Not a test build's bytes")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(sign.indexOf('Sign the update bundles with the updater key'))
    expect(jobs.sign.steps[guard].run).toContain('check-build-kind.ts --want false')
    // A test build never reaches it: the action turns signing off for one.
    expect(jobs.sign.if).toContain("needs.package.outputs.sign == 'true'")
  })
})
