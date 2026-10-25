import { existsSync, readFileSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { config } from 'config'
import { DESKTOP_DOWNLOAD_VERSION_RE, classifyDesktopAsset } from './release-download.js'

/**
 * The desktop release a master keeps for its tills (FR-20.56, plan step P2-7).
 *
 * The supervisor fetches it from lgrai.app (\`/api/node/v1/desktop-release\` and the public download
 * endpoint) into \`<data>/desktop-releases/\`: one directory per version with its files and a
 * \`release.json\`, and \`current.json\` naming the version that is complete. The API only reads.
 *
 * ⚠ Every name and path is checked here as if the directory were hostile: a version must look like
 * one, a file must be a release file the download page would serve, and the resolved path must stay
 * inside the directory. The files themselves need no trust: each till verifies the updater
 * signature against a key pinned in its binary.
 */

export interface CachedRelease {
  version: string
  notes: string | null
  minVersion: string | null
  files: Array<{ name: string; size: number }>
  updater: Record<string, { file: string; signature: string }>
}

const NAME_RE = /^[A-Za-z0-9._-]{1,200}$/

function dir(): string | null {
  return config.desktop.releasesDir || null
}

let memo: { key: string; release: CachedRelease } | null = null

/** The complete release on this master, or null when there is none (or the cache is not there). */
export function cachedRelease(): CachedRelease | null {
  const base = dir()
  if (!base) return null
  try {
    const current = join(base, 'current.json')
    const version = JSON.parse(readFileSync(current, 'utf8'))?.version
    if (typeof version !== 'string' || !DESKTOP_DOWNLOAD_VERSION_RE.test(version)) return null
    const manifest = join(base, version, 'release.json')
    const key = `${version}:${statSync(manifest).mtimeMs}`
    if (memo?.key === key) return memo.release
    const raw = JSON.parse(readFileSync(manifest, 'utf8'))
    if (raw?.version !== version) return null
    const files = (Array.isArray(raw.files) ? raw.files : [])
      .filter((f: any) => typeof f?.name === 'string' && NAME_RE.test(f.name) && classifyDesktopAsset(f.name) && typeof f.size === 'number')
      .map((f: any) => ({ name: f.name, size: f.size }))
    const updater: CachedRelease['updater'] = {}
    for (const [platform, u] of Object.entries(raw.updater ?? {})) {
      const file = (u as any)?.file
      const signature = (u as any)?.signature
      if (typeof file === 'string' && NAME_RE.test(file) && typeof signature === 'string' && signature.length <= 4096 && files.some((f: any) => f.name === file)) {
        updater[platform] = { file, signature }
      }
    }
    const release: CachedRelease = {
      version,
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : null,
      minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : null,
      files,
      updater,
    }
    memo = { key, release }
    return release
  } catch {
    return null
  }
}

/** A file of the cached release, by version and name, or null. */
export function cachedFile(version: string, name: string): { path: string; size: number } | null {
  const base = dir()
  if (!base || !DESKTOP_DOWNLOAD_VERSION_RE.test(version) || !NAME_RE.test(name) || !classifyDesktopAsset(name)) return null
  const root = resolve(base, version)
  const path = resolve(root, name)
  if (!path.startsWith(root + sep)) return null
  if (!existsSync(path)) return null
  const release = cachedRelease()
  // Only the files of the release on record, at their recorded size: a part-file or a leftover is not served.
  const listed = release?.version === version ? release.files.find(f => f.name === name) : undefined
  const size = statSync(path).size
  if (!listed || listed.size !== size) return null
  return { path, size }
}
