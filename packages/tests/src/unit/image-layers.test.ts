import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * The production image is built so that a deploy rebuilds, pushes and pulls only what its commit
 * changed (the Dockerfile's header has the measurements). That rests on two things a harmless
 * looking edit can undo without any build failing:
 *
 *   1. ORDER. A whole-repository `COPY . …` above the OS packages, the install or the SPA build
 *      makes all three run on every commit again. That was the Dockerfile until 2026-11: nothing
 *      was wrong with any single line, and every deploy took five minutes instead of one.
 *   2. THE SPA'S INPUTS. The `web` stage is given only the packages the SPA is built from, so a
 *      backend commit reuses the built SPA. A UI file that starts importing from another package
 *      would not go stale, it would fail to build: at deploy time, on the build host, which is
 *      the worst place to learn it. This test says so in CI instead.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
/**
 * For the two tests that read the tree. `bun run test` passes its own limit; a file run alone gets
 * Bun's 5 s, and a fresh checkout on Windows (cold cache, a virus scanner on every new file) took
 * longer than that to walk once.
 */
const WALK_TIMEOUT = 60_000
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')

interface Stage { name: string; from: string; lines: string[] }

/** The Dockerfile's stages, with continuation lines joined and comments dropped. */
function stages(text: string): Stage[] {
  const joined = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const out: Stage[] = []
  for (const line of joined) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line)
    if (from) out.push({ name: from[2] ?? `#${out.length}`, from: from[1], lines: [] })
    else out.at(-1)?.lines.push(line)
  }
  return out
}

const all = stages(dockerfile)
const stage = (name: string) => {
  const s = all.find(x => x.name === name)
  if (!s) throw new Error(`the Dockerfile has no stage named ${name}`)
  return s
}
/** A stage's own instructions and those of every stage it is built FROM, oldest first. */
function lineage(name: string): string[] {
  const s = stage(name)
  return [...(all.some(x => x.name === s.from) ? lineage(s.from) : []), ...s.lines]
}
/** `COPY . <dest>`: the whole build context, which changes with every commit. */
const copiesTheRepository = (line: string) => /^COPY\s+(?!--from=)(?:--\S+\s+)*\.\s+\S+$/i.test(line)

describe('the image is layered by how often a layer changes', () => {
  it('nothing copies the whole repository under the OS packages, the install or the SPA build', () => {
    for (const name of ['base', 'deps', 'web']) {
      expect({ stage: name, copiesTheRepository: lineage(name).filter(copiesTheRepository) }).toEqual({ stage: name, copiesTheRepository: [] })
    }
  })

  it('each slow step sits in the stage its inputs belong to', () => {
    expect(stage('base').lines.some(l => /^RUN\b.*apt-get install/.test(l))).toBe(true)
    expect(stage('deps').lines.filter(l => l.startsWith('COPY'))).toEqual(['COPY --from=src /manifests/ /app/'])
    expect(stage('deps').lines).toContain('RUN bun install --frozen-lockfile')
    expect(stage('web').lines.filter(l => l.startsWith('COPY'))).toEqual(['COPY --from=src /ui/ /app/'])
    expect(stage('web').lines.some(l => /^RUN\b.*bun run build/.test(l))).toBe(true)
  })

  it('the runtime adds the repository last, on top of the dependencies and the built SPA', () => {
    const runtime = stage('runtime')
    expect(runtime.from).toBe('deps')
    const copies = runtime.lines.filter(l => l.startsWith('COPY'))
    expect(copies).toEqual(['COPY --from=web /app/packages/web/dist /app/packages/web/dist', 'COPY . /app'])
    // Below the last COPY there is only metadata: a RUN there would make a layer on every commit.
    const after = runtime.lines.slice(runtime.lines.indexOf('COPY . /app') + 1)
    expect(after.filter(l => /^(RUN|COPY|ADD)\b/.test(l))).toEqual([])
    expect(all.at(-1)?.name).toBe('runtime')
  })

  it('the install is given every manifest and the lockfile, and nothing else', () => {
    const cut = stage('src').lines.find(l => l.startsWith('RUN')) ?? ''
    expect(cut).toContain('cp --parents package.json bun.lock packages/*/package.json /manifests/')
    // A manifest the glob would miss changes what `bun install` resolves without changing the layer.
    const manifests = walk(ROOT, f => f.endsWith(`${sep}package.json`)).map(f => relative(ROOT, f).split(sep).join('/'))
    expect(manifests.filter(m => m !== 'package.json' && !/^packages\/[^/]+\/package\.json$/.test(m))).toEqual([])
    // What else `bun install` reads, if it ever appears, has to be copied with them.
    for (const also of ['bunfig.toml', '.npmrc', 'patches']) expect({ also, exists: existsSync(join(ROOT, also)) }).toEqual({ also, exists: false })
  }, WALK_TIMEOUT)

  it('the install is keyed on each manifest as it reads it: the copies are cut before anything uses them', () => {
    // Right after the copy, in the same RUN, on /manifests and nowhere else. The `deps` stage then
    // copies /manifests, so a change to a key the install never opens is not a new 1.15 GB layer
    // (scripts/install-manifests.ts; unit/install-manifests.test.ts holds what it may cut).
    const cut = stage('src').lines.find(l => l.startsWith('RUN')) ?? ''
    expect(cut).toMatch(/cp --parents package\.json bun\.lock packages\/\*\/package\.json \/manifests\/\s+&& bun scripts\/install-manifests\.ts \/manifests\s+&& /)
    expect(existsSync(join(ROOT, 'scripts/install-manifests.ts'))).toBe(true)
    // Nothing between the cut and the install may put a whole manifest back.
    expect(stage('deps').lines).toEqual(['WORKDIR /app', 'COPY --from=src /manifests/ /app/', 'RUN bun install --frozen-lockfile'])
  })
})

/** Files under `dir`, skipping what never reaches the build context. */
function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', '.git', '.claude'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, out)
    else if (keep(full)) out.push(full)
  }
  return out
}

describe('the SPA is built from the packages the `web` stage is given', () => {
  // The Dockerfile is the one list: `cp -a --parents <patterns> /ui/`.
  const cut = stage('src').lines.find(l => l.startsWith('RUN')) ?? ''
  const patterns = (/cp -a --parents (.+?) \/ui\//.exec(cut)?.[1] ?? '').split(/\s+/).filter(Boolean)
  const packagesDir = join(ROOT, 'packages')
  const dirs = readdirSync(packagesDir).filter(d => statSync(join(packagesDir, d)).isDirectory())
  const matches = (dir: string) => patterns.some(p => new RegExp(`^${p.replace(/^packages\//, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(dir))
  const given = dirs.filter(matches)

  it('the list names the SPA, the shared UI packages, every module UI and `config`', () => {
    expect(patterns).toEqual(['packages/web', 'packages/config', 'packages/ui-*', 'packages/*-ui'])
    for (const must of ['web', 'config', 'ui-shared', 'ui-shell', 'portal-ui', 'invoicing-ui']) expect(given).toContain(must)
    expect(cut).toContain('cp -a scripts/check-web-bundle.ts /ui/scripts/')
  })

  it('no file of those packages imports from a package outside them', () => {
    // A workspace package is imported by its NAME (`services/biz/…`) or by a relative path.
    const nameToDir = new Map<string, string>()
    for (const d of dirs) {
      const manifest = join(packagesDir, d, 'package.json')
      if (existsSync(manifest)) nameToDir.set(JSON.parse(readFileSync(manifest, 'utf8')).name, d)
    }
    const outside: string[] = []
    for (const pkg of given) {
      const files = walk(join(packagesDir, pkg), f => /\.(ts|vue|js|mjs)$/.test(f) && !/\.(test|spec)\.ts$/.test(f) && !f.endsWith('.d.ts'))
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        // `import type … from` is erased before bundling; everything else is followed by the bundler.
        const specifiers = [
          ...[...text.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"\n]+)['"]/g)].filter(m => !m[1]).map(m => m[2]),
          ...[...text.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)].map(m => m[1]),
        ]
        for (const spec of specifiers) {
          let dir: string | undefined
          if (spec.startsWith('.')) {
            const target = relative(packagesDir, resolve(dirname(file), spec)).split(sep)
            // Inside `packages/`: its first segment is the package. Outside it: not a package at all.
            dir = target[0] === '..' ? `(outside packages/) ${spec}` : target[0]
          } else {
            const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
            dir = nameToDir.get(name) // undefined: an npm dependency, which the `deps` stage installed
          }
          if (dir && !given.includes(dir)) outside.push(`${relative(ROOT, file).split(sep).join('/')} imports '${spec}' (packages/${dir})`)
        }
      }
    }
    // Fix it by importing from a package on the Dockerfile's list (or `import type`), or by adding
    // the package to that list. The second costs: every commit to that package then rebuilds the SPA.
    expect(outside).toEqual([])
  }, WALK_TIMEOUT)
})

describe('the build context', () => {
  // `.dockerignore` leaves out every TypeScript file at the root: a script someone left in the build host's
  // checkout (`backup-diag.ts`, 2026-11-11) was copied into every image. That holds only while the repository
  // keeps none there itself, or the image would silently lose it.
  it('leaves out TypeScript at the root, and the repository keeps none there', () => {
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/).map(l => l.trim())
    expect(ignore).toContain('*.ts')
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT, stdout: 'pipe' }).stdout.toString().split(/\r?\n/)
    expect(tracked.filter(f => !f.includes('/') && f.endsWith('.ts'))).toEqual([])
  })

  // The `src` stage runs these from the copy of the context it is given. One of them left out, and
  // the image does not build: a deploy that fails on the build host, the worst place to learn it.
  it('keeps the scripts the image\'s build runs', () => {
    const patterns = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const cut = stage('src').lines.find(l => l.startsWith('RUN')) ?? ''
    const run = [...new Set([...cut.matchAll(/\bscripts\/[\w.-]+\.ts\b/g)].map(m => m[0]))].sort()
    expect(run).toEqual(['scripts/check-web-bundle.ts', 'scripts/install-manifests.ts'])
    for (const script of run) expect({ script, leftOut: leftOut(patterns, script) }).toEqual({ script, leftOut: false })
    // The reading of the patterns itself, on paths whose answer is known.
    expect(leftOut(patterns, 'backup-diag.ts')).toBe(true)
    expect(leftOut(patterns, 'packages/web/dist/index.html')).toBe(true)
    expect(leftOut(patterns, 'packages/portal-api/.env')).toBe(true)
    expect(leftOut(patterns, '.env.example')).toBe(false)
    expect(leftOut(patterns, 'packages/portal-api/src/unified.ts')).toBe(false)
  })
})

/**
 * Whether a `.dockerignore` leaves a path out of the build context. Its rules, as far as that file
 * uses them: a pattern is matched from the root of the context; `*` stays inside one name and `**`
 * crosses directories; a directory that is left out takes its files with it; a later `!pattern`
 * puts a path back.
 */
function leftOut(patterns: string[], path: string): boolean {
  const name = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  const regex = (pattern: string) => new RegExp(`^${pattern.replace(/\/+$/, '').split('**/').map(part => part.split('**').map(name).join('.*')).join('(?:.*/)?')}$`)
  const names = path.split('/')
  // The path itself and every directory above it.
  const reaches = names.map((_, i) => names.slice(0, i + 1).join('/'))
  let out = false
  for (const raw of patterns) {
    const back = raw.startsWith('!')
    const re = regex(back ? raw.slice(1) : raw)
    if (reaches.some(p => re.test(p))) out = !back
  }
  return out
}
