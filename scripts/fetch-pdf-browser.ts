#!/usr/bin/env bun
/**
 * The Chrome a master prints its PDFs with (FR-20.25): `chrome-headless-shell`, at the build the
 * repo's puppeteer pins, checked against `packages/server/pdf-browser.lock.json` and placed in
 * `<home>/chrome/`, where `lgr-server` finds it.
 *
 *   bun scripts/fetch-pdf-browser.ts --platform win64 --out <home>   # one platform, into a home
 *   bun scripts/fetch-pdf-browser.ts --update-lock                   # after a puppeteer bump
 *
 * `--platform` is `win64`, `linux`, `mac` or `mac_arm` (Chrome for Testing publishes no Linux ARM
 * build: a Linux ARM master names a browser itself, `PUPPETEER_EXECUTABLE_PATH` in api.env).
 * `--cache <dir>` keeps the downloads between runs (default `~/.cache/lgr-pdf-browser`).
 *
 * ⚠ Why not the machine's own Edge or Chrome: on Windows, a system browser with an update pending
 * (`new_msedge.exe` beside it, which is how an update waits while anyone has the browser open)
 * swaps and RELAUNCHES itself on start. Puppeteer sees its process exit with code 0 ("Failed to
 * launch the browser process: Code: 0") and the relaunched headless browser runs on, owned by
 * nobody: three per PDF, since a render is tried three times. Measured on 2026-10-25: 74 headless
 * Edge processes left behind by a handful of renders. Chrome for Testing has no updater, so nothing
 * ever stages a new executable beside it.
 *
 * ⚠ The lock pins the unpacked TREE (each file's path and sha256), not the archive, so a bump is a
 * reviewed diff of four digests and a release can never ship bytes nobody has checked.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const LOCK_FILE = join(ROOT, 'packages', 'server', 'pdf-browser.lock.json')
const BROWSER = 'chrome-headless-shell'
/** Chrome for Testing's platforms, by @puppeteer/browsers' names. */
export const PLATFORMS = ['win64', 'linux', 'mac', 'mac_arm'] as const
export type Platform = (typeof PLATFORMS)[number]

export interface PdfBrowserLock {
  browser: typeof BROWSER
  buildId: string
  /** Per platform: `sha256:<hex>` over the unpacked tree, as `treeDigest` computes it. */
  tree: Record<Platform, string>
}

/** puppeteer as `packages/reporting` (the renderer) resolves it, with what it pins and installs with. */
async function puppeteerTools() {
  const pkg = Bun.resolveSync('puppeteer/package.json', join(ROOT, 'packages', 'reporting'))
  const from = dirname(pkg)
  const { PUPPETEER_REVISIONS } = await import(Bun.resolveSync('puppeteer-core/internal/revisions.js', from))
  const browsers = await import(Bun.resolveSync('@puppeteer/browsers', from))
  return { buildId: PUPPETEER_REVISIONS[BROWSER] as string, browsers }
}

/**
 * One digest for a directory: the sorted `path\tsha256` lines of every file in it (a symlink as
 * `path\t-> target`), hashed. Paths are relative and `/`-separated, so a tree unpacked on Windows
 * and on Linux digests the same.
 */
export async function treeDigest(dir: string): Promise<{ digest: string, files: number, bytes: number }> {
  const lines: string[] = []
  let bytes = 0
  const walk = async (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const rel = relative(dir, path).split(sep).join('/')
      const st = lstatSync(path)
      if (st.isSymbolicLink()) lines.push(`${rel}\t-> ${readlinkSync(path)}`)
      else if (st.isDirectory()) await walk(path)
      else {
        const hasher = new Bun.CryptoHasher('sha256')
        for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
        lines.push(`${rel}\t${hasher.digest('hex')}`)
        bytes += st.size
      }
    }
  }
  await walk(dir)
  lines.sort()
  return { digest: `sha256:${new Bun.CryptoHasher('sha256').update(lines.join('\n')).digest('hex')}`, files: lines.length, bytes }
}

/** The unpacked build in the cache, installed if it is not there; the folder holding the executable. */
async function cached(platform: Platform, cacheDir: string, again = false): Promise<string> {
  const { buildId, browsers } = await puppeteerTools()
  if (again) await browsers.uninstall({ browser: BROWSER, buildId, platform, cacheDir })
  const installed = await browsers.install({ browser: BROWSER, buildId, platform, cacheDir })
  return dirname(installed.executablePath)
}

export function readLock(): PdfBrowserLock {
  return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
}

/** Into `<home>/chrome/`, only once the tree matches the lock; the executable's path. */
export async function fetchInto(platform: Platform, home: string, cacheDir: string): Promise<string> {
  const lock = readLock()
  const { buildId } = await puppeteerTools()
  if (lock.buildId !== buildId) {
    throw new Error(`puppeteer pins ${BROWSER} ${buildId}, the lock ${lock.buildId}: run \`bun scripts/fetch-pdf-browser.ts --update-lock\` and review the digests`)
  }
  const want = lock.tree[platform]
  if (!want) throw new Error(`the lock has no ${platform} build`)
  let source = await cached(platform, cacheDir)
  if ((await treeDigest(source)).digest !== want) {
    // A download cut off part-way leaves a tree that is not the build: fetch it once more.
    source = await cached(platform, cacheDir, true)
    const got = await treeDigest(source)
    if (got.digest !== want) throw new Error(`${BROWSER} ${buildId} for ${platform} is ${got.digest}, the lock says ${want}: refusing it`)
  }
  const target = join(home, 'chrome')
  const staging = `${target}.new`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  cpSync(source, staging, { recursive: true, verbatimSymlinks: true })
  const copied = await treeDigest(staging)
  if (copied.digest !== want) throw new Error(`the copy in ${staging} is ${copied.digest}, not ${want}`)
  const old = `${target}.old`
  rmSync(old, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, old)
  renameSync(staging, target)
  rmSync(old, { recursive: true, force: true })
  return join(target, platform === 'win64' ? `${BROWSER}.exe` : BROWSER)
}

async function updateLock(cacheDir: string) {
  const { buildId } = await puppeteerTools()
  const tree = {} as Record<Platform, string>
  for (const platform of PLATFORMS) {
    const got = await treeDigest(await cached(platform, cacheDir, true))
    tree[platform] = got.digest
    console.log(`${platform.padEnd(8)} ${got.digest}  ${got.files} files, ${(got.bytes / 2 ** 20).toFixed(0)} MB`)
  }
  const lock: PdfBrowserLock = { browser: BROWSER, buildId, tree }
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n')
  console.log(`${relative(ROOT, LOCK_FILE)}: ${BROWSER} ${buildId}`)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const cacheDir = resolve(value('--cache') ?? join(homedir(), '.cache', 'lgr-pdf-browser'))
  try {
    if (args.includes('--update-lock')) {
      await updateLock(cacheDir)
    } else {
      const platform = value('--platform') as Platform | undefined
      const out = value('--out')
      if (!platform || !PLATFORMS.includes(platform) || !out) {
        console.error(`usage: bun scripts/fetch-pdf-browser.ts --platform <${PLATFORMS.join('|')}> --out <home> [--cache <dir>]\n       bun scripts/fetch-pdf-browser.ts --update-lock [--cache <dir>]`)
        process.exit(2)
      }
      console.log(await fetchInto(platform, resolve(out), cacheDir))
    }
  } catch (err: any) {
    console.error(String(err?.message ?? err))
    process.exit(1)
  }
}
