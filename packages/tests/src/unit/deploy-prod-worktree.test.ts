import { describe, it, expect, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * #926: the production image carried 18 empty `packages/*` directories. A `git pull` on the build
 * host removed moved packages' tracked files, not their ignored `node_modules`/`dist`, and the
 * build context was that working copy. `scripts/deploy-prod.sh` now builds from a clean, detached
 * `git worktree` of the commit in a temp dir, removed by its EXIT trap: the build context, the
 * Dockerfile, both gates' JSON and the prune script are read from there, never from the checkout.
 *
 * Read as text first (the shape), then run end to end in a throwaway repo with `docker` and
 * `kubectl` stubbed (`--dry-run` / a stubbed build), so no host, registry or cluster is touched.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const SCRIPT_PATH = join(ROOT, 'scripts', 'deploy-prod.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n')
const code = SCRIPT.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')

describe('deploy-prod.sh builds from a clean worktree of the commit (#926)', () => {
  it('builds the image from the worktree: context and Dockerfile, in the build and in its --dry-run line', () => {
    expect(code).toContain('docker build --progress=plain "$@" -f "$WT/$dockerfile" -t "$tmp" "$WT"')
    expect(code).toContain(`"$*" "$WT/$dockerfile" "$tmp" "$WT"`)
    expect(code).not.toMatch(/docker build[^\n]*"\$SRC"/)
  })

  it('reads both gates and the prune script from the worktree', () => {
    expect(code).toContain('local file="$WT/packages/config/src/supto.json"')
    expect(code).toContain('local file="$WT/packages/config/src/build-kind.json"')
    expect(code).toContain('run "$WT/scripts/prune-docker-tags.sh" --apply')
  })

  it('reads no file of the checkout but its .git: every `$SRC/` path is `$SRC/.git`', () => {
    const paths = [...code.matchAll(/\$SRC\/[^\s"']*/g)].map(m => m[0])
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter(p => p !== '$SRC/.git')).toEqual([])
  })

  it('makes a detached worktree in a temp dir outside the repo, prunes stale ones first, and never uses git archive', () => {
    expect(code).toContain('mktemp -d "${TMPDIR:-/tmp}/lgr-deploy-src.XXXXXX"')
    expect(code).toMatch(/git -C "\$SRC" worktree add --detach --quiet "\$WT" "\$commit"\)\s*\\\n\s*\|\| die /)
    const prune = code.indexOf('git -C "$SRC" worktree prune\n')
    expect(prune).toBeGreaterThan(-1)
    expect(prune).toBeLessThan(code.indexOf('worktree add'))
    expect(SCRIPT).not.toMatch(/git(\s+-C\s+\S+)?\s+archive/)
  })

  it('has ONE EXIT trap, which reports a failure as before and removes the worktree; INT and TERM exit through it', () => {
    expect(code.match(/^trap .* EXIT$/gm)).toEqual(['trap on_exit EXIT'])
    expect(code).toContain("trap 'exit 130' INT")
    expect(code).toContain("trap 'exit 143' TERM")
    const onExit = code.slice(code.indexOf('on_exit() {'), code.indexOf('trap on_exit EXIT'))
    expect(onExit).toContain('echo "DEPLOY_FAILED $SHA (exit $rc)"')
    expect(onExit).toContain('remove_worktree')
    expect(onExit).toContain('exit "$rc"')
  })

  it('says in its usage that --no-pull deploys the checkout\'s commit, not its files', () => {
    expect(SCRIPT).toMatch(/--no-pull\s+# deploy the checkout's commit \(HEAD\)/)
    expect(SCRIPT).not.toContain('deploy the host checkout as-is')
  })
})

// ── End to end, in a throwaway repo ──────────────────────────────────────────
const bash = Bun.which('bash')
const runnable = process.platform !== 'win32' && !!bash && !!Bun.which('git') && !!Bun.which('jq')
const BOX = mkdtempSync(join(tmpdir(), 'lgr-926-'))
afterAll(() => rmSync(BOX, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function setup() {
  const bin = join(BOX, 'bin'), tmp = join(BOX, 'tmp'), src = join(BOX, 'src'), deploy = join(BOX, 'deploy')
  for (const d of [bin, tmp, join(src, 'packages', 'config', 'src'), join(src, 'scripts'), join(deploy, 'k8s', 'overlays', 'prod')]) mkdirSync(d, { recursive: true })
  // docker: `info -f` names a root dir; `build` lists its context so the test can see what it was given.
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nif [[ "$1" == info && "${2:-}" == -f ]]; then echo /; fi\nif [[ "$1" == build ]]; then ctx="${@: -1}"; echo "CONTEXT $ctx"; ls -A "$ctx/packages"; fi\nexit 0\n')
  writeFileSync(join(bin, 'kubectl'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(bin, 'docker'), 0o755); chmodSync(join(bin, 'kubectl'), 0o755)
  writeFileSync(join(deploy, 'k8s', 'overlays', 'prod', 'kustomization.yaml'), 'images: []\n')
  git(BOX, 'init', '-q', '-b', 'master', src)
  writeFileSync(join(src, 'packages', 'config', 'src', 'supto.json'), '{"version":"1","declared":[]}\n')
  writeFileSync(join(src, 'packages', 'config', 'src', 'build-kind.json'), '{"testKeys":false}\n')
  writeFileSync(join(src, 'Dockerfile'), 'FROM scratch\n')
  writeFileSync(join(src, 'scripts', 'prune-docker-tags.sh'), '#!/usr/bin/env bash\necho "PRUNE $0"\n')
  chmodSync(join(src, 'scripts', 'prune-docker-tags.sh'), 0o755)
  git(src, 'add', '-A'); git(src, 'commit', '-qm', 'init')
  return { bin, tmp, src, deploy }
}

function deployRun(env: ReturnType<typeof setup>, ...flags: string[]) {
  const r = Bun.spawnSync([bash!, SCRIPT_PATH, ...flags], {
    env: { ...process.env, PATH: `${env.bin}:${process.env.PATH}`, TMPDIR: env.tmp, LGR_SRC: env.src, LGR_DEPLOY: env.deploy },
  })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

describe.skipIf(!runnable)('deploy-prod.sh end to end with docker and kubectl stubbed (#926)', () => {
  const env = runnable ? setup() : (null as never)
  const worktrees = () => git(env.src, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length

  it('builds what the commit holds, not the checkout\'s leftovers or uncommitted edits, then removes the worktree', () => {
    // A stale record of a run that died, a moved package's leftovers, and an uncommitted edit that would fail the gate.
    git(env.src, 'worktree', 'add', '-q', '--detach', join(BOX, 'stale'), 'HEAD')
    rmSync(join(BOX, 'stale'), { recursive: true, force: true })
    mkdirSync(join(env.src, 'packages', 'portal-api', 'node_modules'), { recursive: true })
    writeFileSync(join(env.src, 'packages', 'portal-api', 'leftover.txt'), 'untracked\n')
    writeFileSync(join(env.src, 'packages', 'config', 'src', 'build-kind.json'), '{"testKeys":true}\n')

    const r = deployRun(env, '--no-pull', '--build-only')
    expect(r.out).toContain('Not a test build')
    expect(r.out).toContain('--no-pull deploys its commit')
    const ctx = r.out.match(/^CONTEXT (.+)$/m)?.[1] ?? ''
    expect(ctx.startsWith(join(env.tmp, 'lgr-deploy-src.'))).toBe(true)
    expect(r.out).toContain(`PRUNE ${ctx}/scripts/prune-docker-tags.sh`)
    expect(r.out).not.toContain('portal-api')
    // The stub makes no image, so the run fails after the build: the trap still cleans up, with the old output.
    expect(r.code).toBe(1)
    expect(r.out).toContain('DEPLOY_FAILED')
    expect(existsSync(ctx)).toBe(false)
    expect(readdirSync(env.tmp).filter(f => f.startsWith('lgr-deploy-src.'))).toEqual([])
    expect(worktrees()).toBe(1)
    git(env.src, 'checkout', '-q', '--', '.')
  })

  it('a --dry-run reads the gates from the worktree too, succeeds with DEPLOY_DONE, and leaves nothing behind', () => {
    const r = deployRun(env, '--no-pull', '--dry-run', '--build-only')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/DEPLOY_DONE [0-9a-f]+ v00000000-000000000000/)
    expect(readdirSync(env.tmp).filter(f => f.startsWith('lgr-deploy-src.'))).toEqual([])
    expect(worktrees()).toBe(1)
  })

  it('a commit that fails a gate exits 1 with DEPLOY_FAILED, and the worktree is removed', () => {
    writeFileSync(join(env.src, 'packages', 'config', 'src', 'build-kind.json'), '{"testKeys":true}\n')
    git(env.src, 'commit', '-qam', 'test build')
    const r = deployRun(env, '--no-pull', '--dry-run', '--build-only')
    expect(r.code).toBe(1)
    expect(r.out).toContain('does not say "testKeys": false')
    expect(r.out).toContain('DEPLOY_FAILED')
    expect(readdirSync(env.tmp).filter(f => f.startsWith('lgr-deploy-src.'))).toEqual([])
    expect(worktrees()).toBe(1)
    git(env.src, 'reset', '-q', '--hard', 'HEAD~1')
  })

  it('a --tag redeploy builds nothing and makes no worktree', () => {
    const r = deployRun(env, '--no-pull', '--build-only', '--tag', 'v20260101-aaaaaaaaaaaa')
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('clean worktree')
    expect(r.out).toContain('DEPLOY_DONE')
  })
})
