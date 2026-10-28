#!/usr/bin/env bun
/**
 * The Bun and the `mongod` a server package carries (FR-20.10, plan step P1-7): downloaded, checked
 * against `packages/server/runtime.lock.json`, and placed in `<home>/bin/`, with mongod's licence
 * texts in `<home>/licences/mongodb/`.
 *
 *   bun scripts/fetch-server-runtime.ts --target windows-x64 --out <home>
 *
 * `--target` is `windows-x64`, `linux-x64` or `linux-arm64`. `--cache <dir>` keeps the archives
 * between runs (default `~/.cache/lgr-server-runtime`).
 *
 * ⚠ An archive is used only when its sha256 is the one pinned, and the lock pins the vendor's own
 * published digest (`SHASUMS256.txt` for Bun, `<url>.sha256` for MongoDB). A bump is a reviewed diff.
 * Only the files a home needs are unpacked: Windows' MongoDB zip carries a 1 GB `mongod.pdb`.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
export const RUNTIME_LOCK = join(ROOT, 'packages', 'server', 'runtime.lock.json')
export const TARGETS = ['windows-x64', 'linux-x64', 'linux-arm64'] as const
export type Target = (typeof TARGETS)[number]

interface Pinned { url: string; sha256: string; path: string; licences?: string[] }
interface RuntimeLock {
  bun: { version: string; targets: Record<Target, Pinned> }
  mongod: { version: string; licence: string; targets: Record<Target, Pinned> }
}

export function readRuntimeLock(): RuntimeLock {
  return JSON.parse(require('node:fs').readFileSync(RUNTIME_LOCK, 'utf8'))
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of Bun.file(file).stream()) h.update(chunk)
  return h.digest('hex')
}

/** The archive in the cache, downloaded when missing; refused unless it is the pinned bytes. */
async function archive(pin: Pinned, cache: string): Promise<string> {
  mkdirSync(cache, { recursive: true })
  const file = join(cache, `${pin.sha256.slice(0, 16)}-${basename(new URL(pin.url).pathname)}`)
  if (!existsSync(file) || (await sha256Of(file)) !== pin.sha256) {
    console.log(`downloading ${pin.url}`)
    const res = await fetch(pin.url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!res.ok) throw new Error(`${pin.url}: ${res.status}`)
    await Bun.write(`${file}.part`, res)
    const got = await sha256Of(`${file}.part`)
    if (got !== pin.sha256) {
      rmSync(`${file}.part`, { force: true })
      throw new Error(`${pin.url} is not the pinned archive: sha256 ${got}, the lock says ${pin.sha256}`)
    }
    require('node:fs').renameSync(`${file}.part`, file)
  }
  return file
}

/** Unpack only `members` of a zip or a tgz into `dir`. */
function unpack(file: string, members: string[], dir: string): void {
  const zip = file.endsWith('.zip')
  // bsdtar (Windows 10+, macOS) reads zips; GNU tar does not, so Linux uses unzip.
  // ⚠ On Windows, System32's bsdtar by its full path: a GNU tar from Git or MSYS earlier on PATH reads no zip.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const cmd = zip && process.platform === 'linux'
    ? ['unzip', '-o', '-q', file, ...members, '-d', dir]
    : [tar, zip ? '-xf' : '-xzf', file, '-C', dir, ...members]
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString() || r.stdout.toString()}`)
  for (const m of members) if (!existsSync(join(dir, m))) throw new Error(`${basename(file)} has no ${m}`)
}

export async function fetchServerRuntime(target: Target, home: string, cache = join(homedir(), '.cache', 'lgr-server-runtime')): Promise<void> {
  const lock = readRuntimeLock()
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'lgr-runtime-'))
  try {
    for (const [what, pin] of [['bun', lock.bun.targets[target]], ['mongod', lock.mongod.targets[target]]] as const) {
      if (!pin) throw new Error(`no ${what} is pinned for ${target}`)
      const file = await archive(pin, cache)
      unpack(file, [pin.path, ...(pin.licences ?? [])], work)
      const exe = join(bin, basename(pin.path))
      cpSync(join(work, pin.path), exe)
      if (!exe.endsWith('.exe')) chmodSync(exe, 0o755)
      if (pin.licences?.length) {
        const dir = join(home, 'licences', what === 'mongod' ? 'mongodb' : what)
        mkdirSync(dir, { recursive: true })
        for (const l of pin.licences) cpSync(join(work, l), join(dir, basename(l)))
      }
      console.log(`  ${what.padEnd(7)} ${exe}`)
    }
    // SSPL: the binaries are unmodified, and here is where their source is.
    writeText(join(home, 'licences', 'mongodb', 'SOURCE.txt'), `${lock.mongod.licence}\n`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function writeText(file: string, text: string) {
  mkdirSync(join(file, '..'), { recursive: true })
  require('node:fs').writeFileSync(file, text)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const target = arg('--target') as Target | undefined
  const out = arg('--out')
  if (!target || !TARGETS.includes(target) || !out) {
    console.error(`usage: bun scripts/fetch-server-runtime.ts --target ${TARGETS.join('|')} --out <home> [--cache <dir>]`)
    process.exit(2)
  }
  await fetchServerRuntime(target, resolve(out), arg('--cache'))
}
