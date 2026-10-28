#!/usr/bin/env bun
/**
 * A master's home, ready to package (FR-20.10, plan step P1-7): what the MSI, the .deb and the
 * tarball install, laid out as `lgr-server` expects it (`packages/server/src/config.rs`):
 *
 *   lgr-server[.exe]      the supervisor (built and, on Windows, signed before this runs)
 *   bin/bun[.exe]         the runtime, pinned by packages/server/runtime.lock.json
 *   bin/mongod[.exe]      the database, the same
 *   bin/*.dll             on Windows, the VC++ runtime mongod links (app-local, as roomler ships it)
 *   chrome/               chrome-headless-shell, pinned by packages/server/pdf-browser.lock.json
 *   package/              `bun run build:server`'s output (dist/lgr-server)
 *   licences/             mongod's SSPL and notices and where its source is; Chrome's are in chrome/
 *   HOME.json             what this home is: version, commit, target, SUPTO version, and what it carries
 *
 *   bun scripts/assemble-server-home.ts --target windows-x64 --version 0.1.0 \
 *     --server-bin packages/server/target/release/lgr-server.exe --package dist/lgr-server \
 *     --crt <dir with msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll> --out dist/home
 *
 * ⚠ It assembles, it does not build: a step after the signing must never rebuild the supervisor.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TARGETS, fetchServerRuntime, readRuntimeLock, type Target } from './fetch-server-runtime.ts'

const ROOT = resolve(import.meta.dir, '..')
const MARKER = 'HOME.json'
const CRT = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
/** Chrome for Testing's platform for each target. None for Linux ARM: that master names a browser. */
const CHROME: Record<Target, string | null> = { 'windows-x64': 'win64', 'linux-x64': 'linux', 'linux-arm64': null }

function sizeOf(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const s = sizeOf(p)
      files += s.files
      bytes += s.bytes
    } else {
      files++
      bytes += statSync(p).size
    }
  }
  return { files, bytes }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const target = arg('--target') as Target | undefined
  const version = arg('--version')
  const serverBin = arg('--server-bin')
  const pkg = arg('--package') ?? join(ROOT, 'dist', 'lgr-server')
  const crt = arg('--crt')
  const out = arg('--out')
  if (!target || !TARGETS.includes(target) || !version || !/^\d+\.\d+\.\d+$/.test(version) || !serverBin || !out) {
    console.error(`usage: bun scripts/assemble-server-home.ts --target ${TARGETS.join('|')} --version N.N.N --server-bin <lgr-server> [--package dist/lgr-server] [--crt <dir>] --out <home>`)
    process.exit(2)
  }
  const windows = target.startsWith('windows')
  if (windows && !crt) {
    console.error('A Windows home carries the VC++ runtime mongod links: name its directory with --crt.')
    process.exit(2)
  }
  const home = resolve(out)
  // Refuse to delete anything that is not a previous home: `--out` is a path a person typed.
  if (existsSync(home) && readdirSync(home).length && !existsSync(join(home, MARKER))) {
    console.error(`${home} exists and is not a server home (no ${MARKER}). Choose another --out.`)
    process.exit(1)
  }
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(resolve(pkg), 'server-manifest.json'), 'utf8'))
  if (manifest.dirty) console.warn('⚠ the package was built from a DIRTY working tree: not a release')

  const exe = join(home, windows ? 'lgr-server.exe' : 'lgr-server')
  cpSync(resolve(serverBin), exe)
  if (!windows) chmodSync(exe, 0o755)
  cpSync(resolve(pkg), join(home, 'package'), { recursive: true })
  await fetchServerRuntime(target, home, arg('--cache'))
  if (windows) {
    for (const dll of CRT) {
      const from = join(resolve(crt!), dll)
      if (!existsSync(from)) throw new Error(`${dll} is not in ${crt}`)
      cpSync(from, join(home, 'bin', dll))
    }
  }
  const chrome = CHROME[target]
  if (chrome) {
    const r = Bun.spawnSync(['bun', join(ROOT, 'scripts', 'fetch-pdf-browser.ts'), '--platform', chrome, '--out', home], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) throw new Error('fetch-pdf-browser failed')
  }

  const lock = readRuntimeLock()
  const pdf = JSON.parse(readFileSync(join(ROOT, 'packages', 'server', 'pdf-browser.lock.json'), 'utf8'))
  const { files, bytes } = sizeOf(home)
  writeFileSync(join(home, MARKER), JSON.stringify({
    name: 'lgr-server',
    version,
    target,
    commit: manifest.commit,
    commitDate: manifest.commitDate,
    // FR-20.50 (P3-8c): the SUPTO version this source implements. The helper checks the offer's
    // claim against it: inside the signed bytes, it is the one that counts.
    supto: JSON.parse(readFileSync(join(ROOT, 'packages', 'config', 'src', 'supto.json'), 'utf8')).version,
    bun: lock.bun.version,
    mongod: lock.mongod.version,
    chrome: chrome ? pdf.buildId : null,
    files: files + 1,
    bytes,
  }, null, 2) + '\n')
  console.log(`Assembled ${home}: ${target}, ${version}, ${files + 1} files, ${(bytes / 1e6).toFixed(0)} MB`)
}
