import { describe, it, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NOT_READ_BY_INSTALL, installManifest, manifestsUnder } from '../../../../scripts/install-manifests'

/**
 * The image's dependency layer (1.15 GB) is made, pushed and pulled again whenever the manifests
 * the install is given change (Dockerfile, stages `src` and `deps`). They are given without the
 * keys the install never opens, so that a new line in `exports` is not such a change. That is
 * right only while the cut takes out nothing the install reads: a key cut by mistake would leave
 * an old node_modules under new code, and no build step would say so.
 */

const ROOT = resolve(import.meta.dir, '../../../..')
const SCRIPT = join(ROOT, 'scripts/install-manifests.ts')

/** What `bun install` reads of a manifest, or may. None of these is ever cut. */
const READ_BY_INSTALL = [
  'name', 'version', 'workspaces', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'patchedDependencies',
  'trustedDependencies', 'scripts', 'bin', 'os', 'cpu', 'packageManager', 'engines',
]

describe('a manifest as the install is given it', () => {
  const whole = {
    name: 'config',
    version: '1.0.0',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts', './pos-totals': './src/pos-totals.ts' },
    scripts: { postinstall: 'echo installed', dev: 'bun run src/index.ts' },
    dependencies: { zod: '^3.23.0' },
    devDependencies: { typescript: '^5.6.0' },
  }

  it('is the manifest without `exports`: every other key as it was, in its order', () => {
    const given = JSON.parse(installManifest(JSON.stringify(whole)))
    const { exports: _cut, ...rest } = whole
    expect(given).toEqual(rest)
    expect(Object.keys(given)).toEqual(Object.keys(rest))
  })

  it('does not change for a new module, nor for how the file is laid out', () => {
    const base = installManifest(JSON.stringify(whole, null, 2))
    const oneMore = { ...whole, exports: { ...whole.exports, './fiscal-clock': './src/fiscal-clock.ts' } }
    expect(installManifest(JSON.stringify(oneMore, null, 2))).toBe(base)
    expect(installManifest(JSON.stringify(whole))).toBe(base)
    expect(installManifest(`${JSON.stringify(whole, null, 4)}\r\n\r\n`)).toBe(base)
  })

  it('changes for whatever the install reads', () => {
    const base = installManifest(JSON.stringify(whole))
    const changes: Record<string, unknown>[] = [
      { ...whole, dependencies: { zod: '^3.24.0' } },
      { ...whole, dependencies: { ...whole.dependencies, elysia: '^1.2.0' } },
      { ...whole, devDependencies: {} },
      { ...whole, scripts: { ...whole.scripts, postinstall: 'echo other' } },
      { ...whole, version: '1.0.1' },
      { ...whole, name: 'config-two' },
      { ...whole, trustedDependencies: ['puppeteer'] },
      { ...whole, workspaces: ['packages/*'] },
      { ...whole, bin: { lgr: './bin/lgr.ts' } },
    ]
    for (const changed of changes) expect(installManifest(JSON.stringify(changed))).not.toBe(base)
  })

  it('cuts nothing the install reads', () => {
    expect(NOT_READ_BY_INSTALL.filter(key => READ_BY_INSTALL.includes(key))).toEqual([])
    // One key today. A second belongs on that list only with the proof the first one has.
    expect([...NOT_READ_BY_INSTALL]).toEqual(['exports'])
  })

  it('refuses what is not a manifest', () => {
    expect(() => installManifest('[]')).toThrow()
    expect(() => installManifest('null')).toThrow()
    expect(() => installManifest('{ "name": ')).toThrow()
  })
})

describe('the manifests of this repository, as the install is given them', () => {
  const files = manifestsUnder(ROOT)

  it('are the root\'s and one for each package', () => {
    const packages = readdirSync(join(ROOT, 'packages')).filter(d => existsSync(join(ROOT, 'packages', d, 'package.json')))
    expect(files[0]).toBe(join(ROOT, 'package.json'))
    expect(files.length).toBe(1 + packages.length)
    expect(packages.length).toBeGreaterThan(20)
  })

  it('each keeps every key but the cut ones, and every key the install reads untouched', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const whole = JSON.parse(text)
      const given = JSON.parse(installManifest(text))
      const expected = { ...whole }
      for (const key of NOT_READ_BY_INSTALL) delete expected[key]
      expect({ file, given }).toEqual({ file, given: expected })
      for (const key of READ_BY_INSTALL) expect({ file, key, value: given[key] }).toEqual({ file, key, value: whole[key] })
    }
  })

  it('some of them do list their modules in `exports`, which is what the cut is for', () => {
    const withExports = files.filter(f => JSON.parse(readFileSync(f, 'utf8')).exports !== undefined)
    expect(withExports.length).toBeGreaterThan(0)
  })
})

describe('run on a tree, as the Dockerfile runs it on /manifests', () => {
  it('writes the root\'s manifest and each package\'s, and touches nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lgr-install-manifests-'))
    try {
      mkdirSync(join(dir, 'packages/a/src'), { recursive: true })
      mkdirSync(join(dir, 'packages/b'), { recursive: true })
      mkdirSync(join(dir, 'packages/no-manifest'), { recursive: true })
      const lock = '{ "lockfileVersion": 1 }\n'
      writeFileSync(join(dir, 'bun.lock'), lock)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }))
      writeFileSync(join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'a', exports: { '.': './src/index.ts' }, dependencies: { b: 'workspace:*' } }))
      writeFileSync(join(dir, 'packages/a/src/package.json'), JSON.stringify({ exports: 'deeper than a package: not one of the workspace\'s' }))
      writeFileSync(join(dir, 'packages/b/package.json'), JSON.stringify({ name: 'b' }))

      const run = Bun.spawnSync([process.execPath, SCRIPT, dir])
      expect({ exit: run.exitCode, err: run.stderr.toString() }).toEqual({ exit: 0, err: '' })
      expect(run.stdout.toString()).toContain('3 written without exports')

      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ name: 'root', workspaces: ['packages/*'] })
      expect(JSON.parse(readFileSync(join(dir, 'packages/a/package.json'), 'utf8'))).toEqual({ name: 'a', dependencies: { b: 'workspace:*' } })
      expect(JSON.parse(readFileSync(join(dir, 'packages/b/package.json'), 'utf8'))).toEqual({ name: 'b' })
      expect(JSON.parse(readFileSync(join(dir, 'packages/a/src/package.json'), 'utf8')).exports).toBeDefined()
      expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(lock)
      expect(existsSync(join(dir, 'packages/no-manifest/package.json'))).toBe(false)

      // Twice is once: the second pass writes the same bytes.
      const first = readFileSync(join(dir, 'packages/a/package.json'), 'utf8')
      expect(Bun.spawnSync([process.execPath, SCRIPT, dir]).exitCode).toBe(0)
      expect(readFileSync(join(dir, 'packages/a/package.json'), 'utf8')).toBe(first)
    } finally {
      // Only ever the directory made above: an empty or foreign path here would delete from wherever the test runs.
      if (dir.includes('lgr-install-manifests-')) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when it is not told where, or is told a place with no manifest', () => {
    expect(Bun.spawnSync([process.execPath, SCRIPT]).exitCode).toBe(2)
    const dir = mkdtempSync(join(tmpdir(), 'lgr-install-manifests-'))
    try {
      expect(Bun.spawnSync([process.execPath, SCRIPT, dir]).exitCode).not.toBe(0)
    } finally {
      if (dir.includes('lgr-install-manifests-')) rmSync(dir, { recursive: true, force: true })
    }
  })
})
