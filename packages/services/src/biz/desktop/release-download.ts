/**
 * The desktop installers, served from THIS server (`/api/desktop/download/*`).
 *
 * Why not a link to GitHub: corporate allow-lists trust the LGR domain, not github.com, and a till
 * fetches its update from the server it already talks to (roomler serves its installers the same
 * way, for the same reason).
 *
 * **No token is needed.** The repository is public: the release is looked up anonymously and a file
 * streams from its public download address. A token (`DESKTOP_RELEASE_GITHUB_TOKEN`, read-only) is
 * still used when set, for GitHub's higher API limit, and would be needed if the repository went
 * private again (its files then come through the API's asset endpoint).
 *
 * ⚠ Only what a published `desktop-v<version>` release carries, and only the installer kinds below.
 * A token here can read the whole repository; the route must never become a way to fetch anything
 * else with it. So: a strict version shape, a tag the route builds itself, an allow-list of file
 * names, the file must be one of THAT release's assets, and the public address is built here from
 * those, never taken from the API's answer.
 */
import { config } from 'config'
import { GithubReleaseError, openReleaseAsset, releaseByTag } from '../github-release.js'

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
  /** `updater` = an archive only the desktop's updater downloads (never listed on the page). */
  label: 'win-setup' | 'win-msi' | 'mac-arm' | 'mac-intel' | 'linux-deb' | 'linux-rpm' | 'updater' | 'signature' | 'pubkey'
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
  // FR-14.28 — the signed, notarised `.app` packed for the updater. A person wants the DMG.
  if (name.endsWith('_aarch64.app.tar.gz')) return { order: 22, platform: 'macos', label: 'updater' }
  if (name.endsWith('_x64.app.tar.gz')) return { order: 23, platform: 'macos', label: 'updater' }
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

/** True when this server can serve downloads at all: it knows the repository (a token is optional). */
export function desktopDownloadsConfigured(): boolean {
  return !!config.desktop.releaseRepo
}

const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; assets: DesktopReleaseAsset[] | null }>()

/** Tests only. */
export function resetDesktopReleaseCache(): void {
  cache.clear()
  sigCache.clear()
}

const AGENT = 'lgr-desktop-download'

/** The shared GitHub reader's errors, as this route's. */
function asDownloadError(e: unknown): unknown {
  return e instanceof GithubReleaseError ? new DesktopDownloadError(502, 'upstream', e.message) : e
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
  if (!d.repo) throw new DesktopDownloadError(503, 'not_configured', 'Desktop downloads are not configured on this server.')
  if (!DESKTOP_DOWNLOAD_VERSION_RE.test(version)) return null

  const hit = cache.get(version)
  if (hit && d.now() - hit.at < CACHE_TTL_MS) return hit.assets

  // Not cached on error: a GitHub outage must not pin "no such release" for ten minutes.
  const rel = await releaseByTag(d, `desktop-v${version}`, AGENT).catch(e => { throw asDownloadError(e) })
  const assets = rel && !rel.prerelease
    ? rel.assets
      .filter(a => classifyDesktopAsset(a.name))
      .sort((a, b) => classifyDesktopAsset(a.name)!.order - classifyDesktopAsset(b.name)!.order)
    : null
  cache.set(version, { at: d.now(), assets })
  return assets
}

/**
 * Open one file of a published release, as a streaming Response.
 *
 * - **With a token**, through the API's asset endpoint.
 * - **Without one**, from the release's public download address, which this function builds itself
 *   from the repository, the tag and the (allow-listed) name.
 *
 * ⚠ Either answers with a REDIRECT to a short-lived signed storage URL, and a token must not follow
 * it there: the redirect is taken by hand, and the second request carries no Authorization header at
 * all (storage rejects one it did not sign, and it is not ours to send).
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

  const res = await openReleaseAsset(d, `desktop-v${version}`, asset, AGENT).catch(e => { throw asDownloadError(e) })
  return { asset, body: res.body, length: res.headers.get('content-length') ?? undefined }
}

/**
 * FR-14.28 — which installer the updater installs, per Tauri `<target>-<arch>`.
 *
 * ⚠ Windows per-user NSIS and macOS `.app.tar.gz`. The MSI is per-machine and never self-installs
 * (C13); Linux ships deb/rpm, which the Tauri updater can only install by elevating, and the shell
 * never elevates. A platform not listed here is offered nothing, which the shell reads as "up to
 * date" rather than as an error. The shell's `install::artifact_suffix` names the same files.
 */
export const UPDATER_INSTALLERS: Readonly<Record<string, string>> = {
  'windows-x86_64': '_x64-setup.exe',
  'darwin-aarch64': '_aarch64.app.tar.gz',
  'darwin-x86_64': '_x64.app.tar.gz',
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
