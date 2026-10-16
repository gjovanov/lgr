import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from 'config'
import { createApiApp } from '../../../portal-api/src/api.js'
import { classifyDesktopAsset, resetDesktopReleaseCache, updaterManifest } from 'services/biz/desktop/release-download'

/**
 * `/api/desktop/download/*` — the installers, streamed from the private repository's releases.
 *
 * The releases live in a PRIVATE repository, so the link a till is offered could point nowhere an
 * operator can open. These routes serve exactly the installers of a published `desktop-v*`
 * release, through this server, with a GitHub token that must never be usable for anything else.
 *
 * GitHub is replaced by a fake `fetch`: no network, and every request the server makes is recorded
 * so the token's handling can be asserted, not assumed.
 */

const d = config.desktop as { releaseGithubToken: string; releaseRepo: string }
const original = { token: d.releaseGithubToken, repo: d.releaseRepo }
const realFetch = globalThis.fetch

type Call = { url: string; auth: string | null; redirect?: string }
let calls: Call[] = []

const ASSETS = [
  { id: 1, name: 'LGR.Desktop_0.1.5_x64-setup.exe', size: 5_000_000 },
  { id: 2, name: 'LGR.Desktop_0.1.5_x64_en-US.msi', size: 6_000_000 },
  { id: 3, name: 'LGR.Desktop_0.1.5_amd64.deb', size: 7_000_000 },
  { id: 4, name: 'LGR.Desktop_0.1.5_amd64.deb.asc', size: 800 },
  { id: 5, name: 'LGR.Desktop-0.1.5-1.x86_64.rpm', size: 7_000_000 },
  { id: 6, name: 'roomler-release-pubkey.asc', size: 3000 },
  { id: 7, name: 'lane-results.tsv', size: 100 }, // a release file that is NOT an installer
]

/** A minisign signature file is base64 text; this is the shape, not a real signature. */
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK'
const SIG_ASSET = { id: 8, name: 'LGR.Desktop_0.1.5_x64-setup.exe.sig', size: SIG.length }
/** Per-asset file content; anything not listed streams as `INSTALLER-BYTES`. */
const BODIES: Record<string, string> = { '8': SIG }

function fakeGitHub(release: any | null, opts: { status?: number } = {}) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, auth: headers.get('authorization'), redirect: init?.redirect })
    if (url.includes('/releases/tags/')) {
      if (opts.status) return new Response('{}', { status: opts.status })
      return release ? Response.json(release) : new Response('{"message":"Not Found"}', { status: 404 })
    }
    const asset = url.match(/\/releases\/assets\/(\d+)$/)
    if (asset) return new Response(null, { status: 302, headers: { location: `https://storage.example/${asset[1]}?sig=x` } })
    if (url.startsWith('https://storage.example/')) {
      const id = url.match(/^https:\/\/storage\.example\/(\d+)/)?.[1] ?? ''
      const body = BODIES[id] ?? 'INSTALLER-BYTES'
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

let app: Elysia
beforeEach(() => {
  calls = []
  resetDesktopReleaseCache()
  d.releaseGithubToken = 'test-token'
  d.releaseRepo = 'gjovanov/lgr'
  app = new Elysia().use(createApiApp())
})
afterEach(() => {
  globalThis.fetch = realFetch
  d.releaseGithubToken = original.token
  d.releaseRepo = original.repo
})

const get = (path: string, lang = 'en') =>
  app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-language': lang } }))

describe('the desktop download page', () => {
  it('lists the installers of a published release, with their signatures, and nothing else', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    const res = await get('/api/desktop/download/0.1.5')
    expect(res.status).toBe(200)
    const body = await res.text()
    for (const name of ['x64-setup.exe', 'x64_en-US.msi', 'amd64.deb', 'x86_64.rpm', 'roomler-release-pubkey.asc']) {
      expect(body).toContain(name)
    }
    expect(body).toContain('/api/desktop/download/0.1.5/LGR.Desktop_0.1.5_amd64.deb.asc')
    expect(body).not.toContain('lane-results.tsv')
    // Anonymous: no cookie, no token, and still served.
    expect(calls[0].url).toBe('https://api.github.com/repos/gjovanov/lgr/releases/tags/desktop-v0.1.5')
    expect(calls[0].auth).toBe('Bearer test-token')
  })

  it('speaks Bulgarian to a Bulgarian browser', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    expect(await (await get('/api/desktop/download/0.1.5', 'bg-BG,bg;q=0.9')).text()).toContain('Изтеглете инсталатора')
  })

  it('answers 404 for a version with no published release, and for a prerelease', async () => {
    fakeGitHub(null)
    expect((await get('/api/desktop/download/9.9.9')).status).toBe(404)
    resetDesktopReleaseCache()
    fakeGitHub({ draft: false, prerelease: true, assets: ASSETS })
    expect((await get('/api/desktop/download/0.1.6')).status).toBe(404)
  })

  it('never asks GitHub about a version that is not a plain N.N.N', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    for (const v of ['latest', '0.1', '0.1.5-rc.1', '..%2F..%2Fcontents']) {
      expect((await get(`/api/desktop/download/${v}`)).status).toBe(404)
    }
    expect(calls).toEqual([])
  })

  it('says it is not configured, rather than failing, when there is no token', async () => {
    d.releaseGithubToken = ''
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    const res = await get('/api/desktop/download/0.1.5')
    expect(res.status).toBe(503)
    expect(calls).toEqual([])
  })

  it('reports GitHub trouble as 502 and does not cache it', async () => {
    fakeGitHub(null, { status: 500 })
    expect((await get('/api/desktop/download/0.1.5')).status).toBe(502)
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    expect((await get('/api/desktop/download/0.1.5')).status).toBe(200)
  })
})

describe('a desktop download', () => {
  it('streams the file as an attachment, and the token never follows the storage redirect', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    const res = await get('/api/desktop/download/0.1.5/LGR.Desktop_0.1.5_x64-setup.exe')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="LGR.Desktop_0.1.5_x64-setup.exe"')
    expect(await res.text()).toBe('INSTALLER-BYTES')

    const asset = calls.find(c => c.url.endsWith('/releases/assets/1'))!
    expect(asset.auth).toBe('Bearer test-token')
    expect(asset.redirect).toBe('manual')
    const storage = calls.find(c => c.url.startsWith('https://storage.example/'))!
    expect(storage.auth).toBeNull()
  })

  it('refuses a file that is not one of the release\'s installers', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    // In the release, but not an installer.
    expect((await get('/api/desktop/download/0.1.5/lane-results.tsv')).status).toBe(404)
    // An installer name, but not in this release.
    expect((await get('/api/desktop/download/0.1.5/LGR.Desktop_0.1.5_aarch64.dmg')).status).toBe(404)
    expect(calls.some(c => c.url.includes('/releases/assets/'))).toBe(false)
  })
})

describe('the updater manifest (FR-14.28)', () => {
  const appUrl = (config as any).email.appUrl.replace(/\/$/, '')

  it('names the per-user installer and carries its .sig content, in the plugin\'s shape', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: [...ASSETS, SIG_ASSET] })
    expect(await updaterManifest('0.1.5', 'windows-x86_64')).toEqual({
      version: '0.1.5',
      url: `${appUrl}/api/desktop/download/0.1.5/LGR.Desktop_0.1.5_x64-setup.exe`,
      signature: SIG,
    })
  })

  it('offers nothing for a release built before the updater, rather than an unsigned install', async () => {
    // ⚠ Every release up to 0.1.5 is like this. A manifest without a signature would be refused
    // on the till anyway — but as a failure every four hours, not as "up to date".
    fakeGitHub({ draft: false, prerelease: false, assets: ASSETS })
    expect(await updaterManifest('0.1.5', 'windows-x86_64')).toBeNull()
  })

  it('offers nothing where the updater cannot self-install', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: [...ASSETS, SIG_ASSET] })
    // MSI = per-machine (managed), deb/rpm would need elevation, macOS is not wired yet.
    for (const p of ['windows-i686', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64', '']) {
      expect(await updaterManifest('0.1.5', p), p).toBeNull()
    }
  })

  it('refuses a .sig that is not a signature file', async () => {
    BODIES['8'] = '<html>not a signature</html>'
    try {
      fakeGitHub({ draft: false, prerelease: false, assets: [...ASSETS, SIG_ASSET] })
      expect(await updaterManifest('0.1.5', 'windows-x86_64')).toBeNull()
    } finally {
      BODIES['8'] = SIG
    }
  })

  it('reads the signature once per release, and the token never follows the storage redirect', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: [...ASSETS, SIG_ASSET] })
    await updaterManifest('0.1.5', 'windows-x86_64')
    await updaterManifest('0.1.5', 'windows-x86_64')
    expect(calls.filter(c => c.url.endsWith('/releases/assets/8'))).toHaveLength(1)
    expect(calls.find(c => c.url.startsWith('https://storage.example/8'))!.auth).toBeNull()
  })

  it('serves the .sig itself as text, so the release\'s download route can hand it out', async () => {
    fakeGitHub({ draft: false, prerelease: false, assets: [...ASSETS, SIG_ASSET] })
    const res = await get('/api/desktop/download/0.1.5/LGR.Desktop_0.1.5_x64-setup.exe.sig')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe(SIG)
  })
})

describe('classifyDesktopAsset', () => {
  it('knows every installer kind and its signature, and nothing else', () => {
    expect(classifyDesktopAsset('LGR.Desktop_0.1.6_aarch64.dmg')?.label).toBe('mac-arm')
    expect(classifyDesktopAsset('LGR.Desktop_0.1.6_x64-setup.exe.sig')?.label).toBe('signature')
    expect(classifyDesktopAsset('LGR.Desktop_0.1.6_x64.dmg')?.label).toBe('mac-intel')
    expect(classifyDesktopAsset('LGR.Desktop-0.1.6-1.x86_64.rpm.asc')?.label).toBe('signature')
    expect(classifyDesktopAsset('roomler-release-pubkey.asc')?.label).toBe('pubkey')
    for (const bad of ['lane-results.tsv', 'notes.asc', 'notes.sig', 'x.sig.sig', 'x.asc.asc', '../secret_x64.dmg', 'a b_x64.dmg', '']) {
      expect(classifyDesktopAsset(bad), bad).toBeNull()
    }
  })
})
