import { config } from 'config'
import { SUPTO_DECLARED, suptoOffer, type SuptoOffer } from 'config/supto'
import { GithubReleaseError, openReleaseAsset, releaseByTag, type GithubSource, type ReleaseAsset } from '../github-release.js'

/**
 * FR-20.20 (plan step P1-8) — what lgrai.app offers its masters to update to, and the bytes. Global
 * only. Read from the repository's `server-v<version>` release (`github-release.ts`: no token
 * needed, the repository is public).
 *
 * Per target, an UPDATE BUNDLE (the whole server home, one top-level directory) with three small
 * files beside it, served inline in the offer so the master downloads only the bundle:
 * - `<bundle>.sig`: the minisign signature, with the updater key whose public half the master's
 *   package carries (`packages/desktop/src-tauri/updater.pub`, FR-14.28);
 * - `<bundle>.asc`: roomler's release GPG signature, the platform signature on Linux (on Windows the
 *   platform signature is the Authenticode one on `lgr-server.exe`, inside the bundle);
 * - `<bundle>.sha256`: a transport check, never a trust anchor.
 *
 * And one per release, `lgr-server-<version>.supto`: its SUPTO version (FR-20.50, P3-8c), which the
 * offer marks declared or not against this build's `config/supto`. A master holds an undeclared one
 * once anything is declared, and checks the bundle's own `HOME.json` against the claim.
 *
 * ⚠ Nothing here is a trust boundary: the master checks every byte against keys built into its own
 * package, whoever served them (FR-20.53 lets a TLS-inspecting proxy in). This only says which
 * version to fetch, and streams it from where corporate allow-lists trust.
 *
 * ⚠ A prerelease is served: server releases are published as previews, and the gate is the version
 * a human promoted (`SERVER_RELEASE_VERSION`), never "the latest".
 */

export const SERVER_RELEASE_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** A target the release builds an update bundle for: the name's tail after `lgr-server-<version>-`. */
export const SERVER_BUNDLE_TARGETS = {
  'windows-x64': 'x86_64-pc-windows-msvc.zip',
  'linux-x64': 'x86_64-unknown-linux-gnu.tar.gz',
} as const
export type ServerTarget = keyof typeof SERVER_BUNDLE_TARGETS

export const serverBundleName = (version: string, target: ServerTarget) => `lgr-server-${version}-${SERVER_BUNDLE_TARGETS[target]}`

/** The one file of a release a master may download from here: a bundle of `version`, and its target. */
export function serverBundleTarget(version: string, name: string): ServerTarget | null {
  for (const target of Object.keys(SERVER_BUNDLE_TARGETS) as ServerTarget[]) {
    if (name === serverBundleName(version, target)) return target
  }
  return null
}

export class ServerReleaseError extends Error {
  constructor(readonly statusCode: 404 | 502, readonly code: string, message: string) {
    super(message)
  }
}

export interface ServerTargetOffer {
  bundle: { name: string; size: number }
  /** The `.sig` file's content: minisign, base64 text. */
  signature: string
  /** The `.asc` file's content: an armored OpenPGP signature. */
  platform: string
  sha256: string
}

export interface ServerReleaseOffer {
  version: string
  /** FR-20.58: the oldest master build global talks to. */
  minVersion: string
  /** FR-20.50: the release's SUPTO version, whether it is declared, and whether that is enforced yet. */
  supto: SuptoOffer
  targets: Partial<Record<ServerTarget, ServerTargetOffer>>
}

const AGENT = 'lgr-server-release'
const SMALL_MAX_BYTES = 8192
const CACHE_TTL_MS = 10 * 60_000
/** Per version: the offer (its SUPTO version as the release names it), and the assets of its bundles (a download needs their ids). */
const cache = new Map<string, { at: number; offer: (Omit<ServerReleaseOffer, 'supto'> & { supto: string | null }) | null; bundles: Map<string, ReleaseAsset> }>()

/** Tests only. */
export function resetServerReleaseCache(): void {
  cache.clear()
}

function source(over: Partial<GithubSource> = {}): GithubSource {
  return {
    fetch: over.fetch ?? fetch,
    repo: over.repo ?? config.serverRelease.repo,
    token: over.token ?? config.serverRelease.githubToken,
  }
}

const asReleaseError = (e: unknown) => (e instanceof GithubReleaseError ? new ServerReleaseError(502, e.code, e.message) : e)

/** A small text file of the release (a signature, a digest), or null when it is not one. */
async function smallText(src: GithubSource, tag: string, asset: ReleaseAsset | undefined): Promise<string | null> {
  if (!asset || asset.size > SMALL_MAX_BYTES) return null
  const res = await openReleaseAsset(src, tag, asset, AGENT)
  const text = (await res.text()).trim()
  return text && text.length <= SMALL_MAX_BYTES ? text : null
}

/**
 * The offer for `version`: per target, its bundle and the three files beside it. A target missing
 * any of them, or with one that is not what it should be, is left out, so a master never reads a
 * half-published release as an update. Null when there is no such release or no complete target.
 * Cached ten minutes, misses included.
 */
export async function serverReleaseOffer(version: string, over: Partial<GithubSource> & { now?: () => number; declared?: readonly string[] } = {}): Promise<ServerReleaseOffer | null> {
  const offer = (await cachedRelease(version, over))?.offer
  // Declared or not against this build's list, as it is now: a declaration needs no new release.
  return offer ? { ...offer, supto: suptoOffer(offer.supto, over.declared ?? SUPTO_DECLARED) } : null
}

async function cachedRelease(version: string, over: Partial<GithubSource> & { now?: () => number } = {}) {
  if (!SERVER_RELEASE_VERSION_RE.test(version)) return null
  const now = (over.now ?? Date.now)()
  const hit = cache.get(version)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit

  const src = source(over)
  const tag = `server-v${version}`
  // Not cached on error: a GitHub outage must not pin "no such release" for ten minutes.
  const rel = await releaseByTag(src, tag, AGENT).catch(e => { throw asReleaseError(e) })
  let offer: (Omit<ServerReleaseOffer, 'supto'> & { supto: string | null }) | null = null
  const bundles = new Map<string, ReleaseAsset>()
  if (rel) {
    const byName = new Map(rel.assets.map(a => [a.name, a]))
    const targets: Partial<Record<ServerTarget, ServerTargetOffer>> = {}
    for (const target of Object.keys(SERVER_BUNDLE_TARGETS) as ServerTarget[]) {
      const name = serverBundleName(version, target)
      const bundle = byName.get(name)
      if (!bundle) continue
      const [signature, platform, digest] = await Promise.all([
        smallText(src, tag, byName.get(`${name}.sig`)),
        smallText(src, tag, byName.get(`${name}.asc`)),
        smallText(src, tag, byName.get(`${name}.sha256`)),
      ]).catch(e => { throw asReleaseError(e) })
      const sha256 = digest?.match(/^([0-9a-f]{64})\s+\*?(\S+)$/)
      if (!signature || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) continue
      if (!platform || !platform.startsWith('-----BEGIN PGP SIGNATURE-----')) continue
      if (!sha256 || sha256[2] !== name) continue
      targets[target] = { bundle: { name, size: bundle.size }, signature, platform, sha256: sha256[1] }
      bundles.set(name, bundle)
    }
    if (Object.keys(targets).length) {
      // A release from before P3-8c names none: null, which waits once anything is declared.
      const supto = await smallText(src, tag, byName.get(`lgr-server-${version}.supto`)).catch(e => { throw asReleaseError(e) })
      offer = { version, minVersion: config.node.minMasterVersion, supto, targets }
    }
  }
  const entry = { at: now, offer, bundles }
  cache.set(version, entry)
  return entry
}

/** A bundle of `version`, streaming. Only a bundle the offer names: nothing else of the release. */
export async function openServerBundle(
  version: string,
  name: string,
  over: Partial<GithubSource> = {},
): Promise<{ body: ReadableStream<Uint8Array> | null; length?: string }> {
  const target = serverBundleTarget(version, name)
  const release = target ? await cachedRelease(version, over) : null
  const asset = release?.offer?.targets[target!] ? release.bundles.get(name) : undefined
  if (!asset) throw new ServerReleaseError(404, 'not_found', 'No such file in this release.')
  const res = await openReleaseAsset(source(over), `server-v${version}`, asset, AGENT).catch(e => { throw asReleaseError(e) })
  return { body: res.body, length: res.headers.get('content-length') ?? undefined }
}
