/**
 * The desktop installers, served from THIS server (`/api/desktop/download/*`).
 *
 * ⚠ Why not a link to GitHub: the releases live in a PRIVATE repository, so a link to one 404s for
 * every till operator, and `DESKTOP_RELEASE_URL` could point nowhere a till can open. Streaming them
 * through the LGR domain is also what corporate allow-lists trust (roomler serves its installers the
 * same way, for the same reason).
 *
 * ⚠ Only what a published `desktop-v<version>` release carries, and only the installer kinds below.
 * The GitHub token here can read the whole repository; the route must never become a way to fetch
 * anything else with it. So: a strict version shape, a tag the route builds itself, an allow-list
 * of file names, and the file must be one of THAT release's assets.
 */
import { config } from 'config'

export const DESKTOP_DOWNLOAD_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** A file of a release, as the GitHub API reports it. */
export interface DesktopReleaseAsset {
  id: number
  name: string
  size: number
}

export interface DesktopAssetKind {
  /** Sort key: the order the download page lists the files in. */
  order: number
  /** Platform, for the page. */
  platform: 'windows' | 'macos' | 'linux' | 'any'
  /** i18n key suffix for the page's label. */
  label: 'win-setup' | 'win-msi' | 'mac-arm' | 'mac-intel' | 'linux-deb' | 'linux-rpm' | 'signature' | 'pubkey'
}

const NAME_RE = /^[A-Za-z0-9._-]{1,200}$/

/**
 * What a release file is, from its name; `null` for anything the route must not serve.
 *
 * GitHub turns the space in `LGR Desktop_0.1.5_x64-setup.exe` into a dot, so names arrive as
 * `LGR.Desktop_0.1.5_x64-setup.exe`. Matching is on the suffix the bundler gives each kind.
 */
export function classifyDesktopAsset(name: string): DesktopAssetKind | null {
  if (!NAME_RE.test(name) || name.includes('..')) return null
  if (name === 'roomler-release-pubkey.asc') return { order: 90, platform: 'any', label: 'pubkey' }
  // `.asc` = roomler's GPG signature; `.sig` = the Tauri updater's minisign signature (FR-14.28).
  if (name.endsWith('.asc') || name.endsWith('.sig')) {
    const base = classifyDesktopAsset(name.slice(0, -4))
    return base && base.label !== 'signature' && base.label !== 'pubkey'
      ? { order: base.order + 0.5, platform: base.platform, label: 'signature' }
      : null
  }
  if (name.endsWith('_x64-setup.exe')) return { order: 10, platform: 'windows', label: 'win-setup' }
  if (name.endsWith('_x64_en-US.msi')) return { order: 11, platform: 'windows', label: 'win-msi' }
  if (name.endsWith('_aarch64.dmg')) return { order: 20, platform: 'macos', label: 'mac-arm' }
  if (name.endsWith('_x64.dmg')) return { order: 21, platform: 'macos', label: 'mac-intel' }
  if (name.endsWith('_amd64.deb')) return { order: 30, platform: 'linux', label: 'linux-deb' }
  if (name.endsWith('.x86_64.rpm')) return { order: 31, platform: 'linux', label: 'linux-rpm' }
  return null
}

export class DesktopDownloadError extends Error {
  constructor(public statusCode: 404 | 502 | 503, public code: string, message: string) {
    super(message)
  }
}

interface Deps {
  fetch: typeof fetch
  repo: string
  token: string
  now: () => number
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    fetch: over.fetch ?? fetch,
    repo: over.repo ?? config.desktop.releaseRepo,
    token: over.token ?? config.desktop.releaseGithubToken,
    now: over.now ?? Date.now,
  }
}

/** True when this server can serve downloads at all. */
export function desktopDownloadsConfigured(): boolean {
  return !!config.desktop.releaseGithubToken && !!config.desktop.releaseRepo
}

const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; assets: DesktopReleaseAsset[] | null }>()

/** Tests only. */
export function resetDesktopReleaseCache(): void {
  cache.clear()
  sigCache.clear()
}

function apiHeaders(token: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'User-Agent': 'lgr-desktop-download',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * The servable files of the PUBLISHED release `desktop-v<version>`, sorted for the page; `null`
 * when there is no such release.
 *
 * ⚠ The tags endpoint never returns a draft (a draft has no tag), and a prerelease is refused here
 * too: neither is something to hand a till. Cached for ten minutes, misses included, so an
 * anonymous visitor cannot turn page loads into GitHub API calls.
 */
export async function findDesktopRelease(
  version: string,
  over: Partial<Deps> = {},
): Promise<DesktopReleaseAsset[] | null> {
  const d = deps(over)
  if (!d.token) throw new DesktopDownloadError(503, 'not_configured', 'Desktop downloads are not configured on this server.')
  if (!DESKTOP_DOWNLOAD_VERSION_RE.test(version)) return null

  const hit = cache.get(version)
  if (hit && d.now() - hit.at < CACHE_TTL_MS) return hit.assets

  const res = await d.fetch(
    `https://api.github.com/repos/${d.repo}/releases/tags/desktop-v${encodeURIComponent(version)}`,
    { headers: apiHeaders(d.token, 'application/vnd.github+json'), signal: AbortSignal.timeout(10_000) },
  )
  let assets: DesktopReleaseAsset[] | null = null
  if (res.ok) {
    const rel: any = await res.json()
    if (!rel?.draft && !rel?.prerelease) {
      assets = (Array.isArray(rel?.assets) ? rel.assets : [])
        .map((a: any) => ({ id: Number(a.id), name: String(a.name || ''), size: Number(a.size) || 0 }))
        .filter((a: DesktopReleaseAsset) => Number.isFinite(a.id) && classifyDesktopAsset(a.name))
        .sort((a: DesktopReleaseAsset, b: DesktopReleaseAsset) =>
          classifyDesktopAsset(a.name)!.order - classifyDesktopAsset(b.name)!.order)
    }
  } else if (res.status !== 404) {
    // Not cached: a GitHub outage must not pin "no such release" for ten minutes.
    throw new DesktopDownloadError(502, 'upstream', `GitHub answered ${res.status} for the release lookup.`)
  }
  cache.set(version, { at: d.now(), assets })
  return assets
}

/**
 * Open one file of a published release, as a streaming Response.
 *
 * ⚠ The asset endpoint answers with a REDIRECT to a short-lived signed storage URL, and the token
 * must not follow it there: the redirect is taken by hand, and the second request carries no
 * Authorization header at all (storage rejects one it did not sign, and it is not ours to send).
 */
export async function openDesktopAsset(
  version: string,
  name: string,
  over: Partial<Deps> = {},
): Promise<{ asset: DesktopReleaseAsset; body: ReadableStream<Uint8Array> | null; length?: string }> {
  const d = deps(over)
  if (!classifyDesktopAsset(name)) throw new DesktopDownloadError(404, 'not_found', 'No such file.')
  const assets = await findDesktopRelease(version, over)
  const asset = assets?.find(a => a.name === name)
  if (!asset) throw new DesktopDownloadError(404, 'not_found', 'No such file in this release.')

  const first = await d.fetch(`https://api.github.com/repos/${d.repo}/releases/assets/${asset.id}`, {
    headers: apiHeaders(d.token, 'application/octet-stream'),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  let res = first
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    if (!location) throw new DesktopDownloadError(502, 'upstream', 'GitHub redirected without a location.')
    res = await d.fetch(location, { headers: { 'User-Agent': 'lgr-desktop-download' } })
  }
  if (!res.ok) throw new DesktopDownloadError(502, 'upstream', `The file could not be fetched (${res.status}).`)
  return { asset, body: res.body, length: res.headers.get('content-length') ?? undefined }
}

/**
 * FR-14.28 — which installer the updater installs, per Tauri `<target>-<arch>`.
 *
 * ⚠ Windows per-user NSIS only. The MSI is per-machine and never self-installs (C13); macOS needs
 * the Developer ID check on the shell side first; Linux ships deb/rpm, which the Tauri updater
 * can only install by elevating, and the shell never elevates. A platform not listed here is
 * offered nothing, which the shell reads as "up to date" rather than as an error.
 */
export const UPDATER_INSTALLERS: Readonly<Record<string, string>> = {
  'windows-x86_64': '_x64-setup.exe',
}

/** What the Tauri updater plugin reads: its "dynamic" manifest shape. */
export interface UpdaterManifest {
  version: string
  url: string
  /** The `.sig` file's content: base64 of the minisign signature over the installer's bytes. */
  signature: string
  notes?: string
}

/** A minisign signature file is a few hundred bytes of base64. Anything else is not one. */
const SIG_MAX_BYTES = 4096
const SIG_RE = /^[A-Za-z0-9+/=\r\n]+$/

/** Release files never change once published, so a signature read once is good for the process. */
const sigCache = new Map<string, string>()

/**
 * The updater manifest for `version` on `platform`, or `null` when that release cannot be
 * installed automatically there.
 *
 * ⚠ `null` — never a manifest without a signature — when the `.sig` is missing. The shell would
 * refuse it anyway (the signature is checked against a key pinned in the binary), but a release
 * built before the updater existed should read as "nothing to install", not as a failed attempt
 * on every till every four hours.
 *
 * ⚠ The signature is NOT what makes this safe, and this function does not verify it: the hub is
 * not a trust boundary (C13 §2). It only carries the file the release pipeline produced.
 */
export async function updaterManifest(
  version: string,
  platform: string,
  over: Partial<Deps> = {},
): Promise<UpdaterManifest | null> {
  const suffix = UPDATER_INSTALLERS[platform]
  if (!suffix) return null
  const assets = await findDesktopRelease(version, over)
  const installer = assets?.find(a => a.name.endsWith(suffix))
  const sigAsset = installer && assets!.find(a => a.name === `${installer.name}.sig`)
  if (!installer || !sigAsset) return null

  const key = `${version}/${sigAsset.name}`
  let signature = sigCache.get(key)
  if (!signature) {
    if (sigAsset.size > SIG_MAX_BYTES) return null
    const { body } = await openDesktopAsset(version, sigAsset.name, over)
    const text = (body ? await new Response(body).text() : '').trim()
    if (!text || text.length > SIG_MAX_BYTES || !SIG_RE.test(text)) return null
    signature = text
    sigCache.set(key, signature)
  }

  const base = config.email.appUrl.replace(/\/$/, '')
  return {
    version,
    url: `${base}/api/desktop/download/${version}/${encodeURIComponent(installer.name)}`,
    signature,
  }
}

/** The page link the hub offers with a release, or '' when this server cannot serve one. */
export function desktopDownloadPageUrl(version: string): string {
  if (!desktopDownloadsConfigured() || !DESKTOP_DOWNLOAD_VERSION_RE.test(version)) return ''
  return `${config.email.appUrl.replace(/\/$/, '')}/api/desktop/download/${version}`
}
