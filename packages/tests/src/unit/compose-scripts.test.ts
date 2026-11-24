import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

/**
 * #935: the root docker-compose.yml started the app with `bun run start:unified`, a script no
 * package.json had defined for a long time, so `docker compose up` brought `app` up only to exit
 * with `Script not found`. Nothing else runs that file (production is lgr-deploy's manifest and
 * the image's own CMD), so nothing noticed. This test reads every `bun run <x>` a compose service
 * starts and checks `<x>` against the package.json of that service's `working_dir`.
 *
 * The image is the repository copied to /app (Dockerfile: `COPY . /app`), so a `working_dir` under
 * /app is the same path under the repository root.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const IMAGE_ROOT = '/app'

interface Service { working_dir?: string; command?: string | string[]; entrypoint?: string | string[] }

/** A compose `command`/`entrypoint` as argv. The string form is split the way compose splits it, on whitespace (no quoting in this repo). */
const argv = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : v.trim().split(/\s+/))

/** What follows `bun run` (its flags skipped), or null when the argv is not a `bun run`. */
function bunRunTarget(args: string[]): string | null {
  const i = args.findIndex((a, k) => a === 'run' && /(^|\/)bun$/.test(args[k - 1] ?? ''))
  if (i < 0) return null
  return args.slice(i + 1).find(a => !a.startsWith('-')) ?? null
}

/** Every `bun run` in a compose file whose target does not exist, as readable lines. Empty when all resolve. */
function missingTargets(composeText: string): { checked: string[]; missing: string[] } {
  const services = (Bun.YAML.parse(composeText) as { services?: Record<string, Service> }).services ?? {}
  const checked: string[] = []
  const missing: string[] = []
  for (const [name, svc] of Object.entries(services)) {
    const target = bunRunTarget([...argv(svc.entrypoint), ...argv(svc.command)])
    if (target === null) continue
    checked.push(name)
    const wd = svc.working_dir
    if (!wd || (wd !== IMAGE_ROOT && !wd.startsWith(`${IMAGE_ROOT}/`))) {
      missing.push(`${name}: runs \`bun run ${target}\` but its working_dir (${wd ?? 'none'}) is not under ${IMAGE_ROOT}, so the test cannot find its package.json`)
      continue
    }
    const dir = join(ROOT, posix.relative(IMAGE_ROOT, wd))
    // `bun run <file>` runs a file rather than a script.
    if (target.includes('/') || /\.[cm]?[jt]sx?$/.test(target)) {
      if (!existsSync(join(dir, target))) missing.push(`${name}: \`bun run ${target}\`, and ${wd}/${target} does not exist`)
      continue
    }
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) {
      missing.push(`${name}: \`bun run ${target}\` in ${wd}, which has no package.json`)
      continue
    }
    const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
    if (!(target in scripts)) missing.push(`${name}: \`bun run ${target}\`, but ${wd}/package.json has no such script (it has: ${Object.keys(scripts).join(', ') || 'none'})`)
  }
  return { checked, missing }
}

const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')

describe('docker-compose.yml starts only scripts that exist (#935)', () => {
  it('every `bun run <script>` names a script in the package.json of its service\'s working_dir', () => {
    const { checked, missing } = missingTargets(compose)
    expect(missing).toEqual([])
    // Not vacuous: the app service is a `bun run`, and it was the one that was wrong.
    expect(checked).toContain('app')
  })

  it('the check catches the name compose used to run', () => {
    const before = compose.replace(/command:\s*\[[^\]]*\]/, 'command: ["bun", "run", "start:unified"]')
    expect(before).not.toBe(compose)
    expect(missingTargets(before).missing).toEqual([expect.stringContaining('start:unified')])
    const asString = compose.replace(/command:\s*\[[^\]]*\]/, 'command: bun run start:unified')
    expect(missingTargets(asString).missing).toEqual([expect.stringContaining('start:unified')])
  })
})
