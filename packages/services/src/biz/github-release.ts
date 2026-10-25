import { fetchWithTimeout } from './outbound-fetch.js'

/**
 * A published GitHub release, read the way LGR serves its own: the desktop installers
 * (`desktop/release-download.ts`) and the server's update bundles (`node/server-release.service.ts`).
 *
 * - **No token is needed** for a public repository: the release is looked up anonymously, and a
 *   file streams from its public download address, which this module builds from the repository,
 *   the tag and the asset's name, never from an address in the API's answer. A token, when set, is
 *   used for GitHub's higher API limit, and is what a private repository needs: its files then come
 *   through the API's asset endpoint.
 * - ⚠ Either way GitHub answers a file with a REDIRECT to a short-lived signed storage URL, and a
 *   token must not follow it there: the redirect is taken by hand, and the request to storage
 *   carries no Authorization header at all (storage rejects one it did not sign, and it is not ours
 *   to send).
 */

export interface GithubSource {
  fetch: typeof fetch
  repo: string
  token: string
}

/** A file of a release, as the GitHub API reports it. */
export interface ReleaseAsset {
  id: number
  name: string
  size: number
}

export class GithubReleaseError extends Error {
  constructor(readonly statusCode: 502, readonly code: 'upstream', message: string) {
    super(message)
  }
}

/** GitHub API headers; anonymous (no Authorization) when there is no token. */
export function githubHeaders(token: string, accept: string, agent: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: accept,
    'User-Agent': agent,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * The release under `tag`, or null when there is none. The tags endpoint never returns a draft (a
 * draft has no tag). A GitHub error other than 404 throws, so a caller never caches an outage as
 * "no such release".
 */
export async function releaseByTag(src: GithubSource, tag: string, agent: string): Promise<{ prerelease: boolean; assets: ReleaseAsset[] } | null> {
  const res = await src.fetch(`https://api.github.com/repos/${src.repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(src.token, 'application/vnd.github+json', agent),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new GithubReleaseError(502, 'upstream', `GitHub answered ${res.status} for the release lookup.`)
  const rel: any = await res.json()
  if (rel?.draft) return null
  const assets = (Array.isArray(rel?.assets) ? rel.assets : [])
    .map((a: any) => ({ id: Number(a.id), name: String(a.name || ''), size: Number(a.size) || 0 }))
    .filter((a: ReleaseAsset) => Number.isFinite(a.id) && a.name)
  return { prerelease: !!rel?.prerelease, assets }
}

/**
 * One file of the release under `tag`, as a streaming Response. The caller has already checked the
 * file is one it may serve, and one of THAT release's assets.
 */
export async function openReleaseAsset(src: GithubSource, tag: string, asset: ReleaseAsset, agent: string): Promise<Response> {
  const first = src.token
    ? await src.fetch(`https://api.github.com/repos/${src.repo}/releases/assets/${asset.id}`, {
      headers: githubHeaders(src.token, 'application/octet-stream', agent),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    : await src.fetch(`https://github.com/${src.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`, {
      headers: { 'User-Agent': agent },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
  let res = first
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    if (!location) throw new GithubReleaseError(502, 'upstream', 'GitHub redirected without a location.')
    // FR-20.53: the redirect target streams the file on to the client, so only the wait for its
    // response is bounded — a slow but healthy download is never cut off.
    res = await fetchWithTimeout(location, { headers: { 'User-Agent': agent } }, { timeoutMs: 15_000, until: 'headers', fetchImpl: src.fetch })
  }
  if (!res.ok) throw new GithubReleaseError(502, 'upstream', `The file could not be fetched (${res.status}).`)
  return res
}
