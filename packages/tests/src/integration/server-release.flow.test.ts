import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { resetServerReleaseCache, serverReleaseOffer } from 'services/biz/node/server-release.service'

/**
 * What lgrai.app offers its masters to update to (FR-20.20, plan step P1-8): the promoted version's
 * update bundles, per target, with the minisign and GPG signatures and the digest beside each, and
 * the bundle's bytes, streamed from the (public) release. Nothing else of any release.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const realFetch = globalThis.fetch
const saved = { ...config.serverRelease }
const V = '0.2.0'
const WIN = `lgr-server-${V}-x86_64-pc-windows-msvc.zip`
const LINUX = `lgr-server-${V}-x86_64-unknown-linux-gnu.tar.gz`
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK'
const ASC = '-----BEGIN PGP SIGNATURE-----\n\niHUEABYKAB0WIQRdu...\n=abcd\n-----END PGP SIGNATURE-----'
const HEX = 'a'.repeat(64)
const FILES: Record<string, string> = {
  [WIN]: 'WINDOWS-BUNDLE', [`${WIN}.sig`]: SIG, [`${WIN}.asc`]: ASC, [`${WIN}.sha256`]: `${HEX}  ${WIN}\n`,
  // The Linux bundle is published without its .asc: not offered.
  [LINUX]: 'LINUX-BUNDLE', [`${LINUX}.sig`]: SIG, [`${LINUX}.sha256`]: `${'b'.repeat(64)}  ${LINUX}\n`,
  [`lgr-server-${V}-x86_64-pc-windows-msvc.msi`]: 'MSI',
  // FR-20.50 (P3-8c): the release's SUPTO version.
  [`lgr-server-${V}.supto`]: '1\n',
}
let calls: Array<{ url: string; auth: string | null }> = []

/** GitHub, for a public repository: the release by tag, and each file through a storage redirect. */
function fakeGitHub(opts: { prerelease?: boolean; status?: number } = {}) {
  const assets = Object.keys(FILES).map((name, i) => ({ id: i + 1, name, size: FILES[name].length }))
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    if (url.includes('/releases/tags/')) {
      if (opts.status) return new Response('{}', { status: opts.status })
      return url.endsWith(`/server-v${V}`) ? Response.json({ draft: false, prerelease: opts.prerelease ?? true, assets }) : new Response('{}', { status: 404 })
    }
    const pub = url.match(/^https:\/\/github\.com\/gjovanov\/lgr\/releases\/download\/server-v[\d.]+\/(.+)$/)
    if (pub) return new Response(null, { status: 302, headers: { location: `https://storage.example/${encodeURIComponent(decodeURIComponent(pub[1]))}` } })
    const stored = url.match(/^https:\/\/storage\.example\/(.+)$/)
    if (stored) {
      const body = FILES[decodeURIComponent(stored[1])]
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { headers: { 'content-length': String(body.length) } })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
beforeEach(() => {
  calls = []
  resetServerReleaseCache()
  Object.assign(config.serverRelease, { version: V, repo: 'gjovanov/lgr', githubToken: '' })
})
afterEach(async () => {
  globalThis.fetch = realFetch
  Object.assign(config.serverRelease, saved)
  await clearCollections()
})

async function aMaster() {
  const org = await createTestOrg()
  const admin: any = await createTestUser(org._id, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const token = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  const app = new Elysia().use(createApiApp())
  const get = (path: string, auth = true) => app.handle(new Request(`http://localhost${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} }))
  return { get }
}

describe('the server release lgrai.app offers', () => {
  it('names each complete target\'s bundle with its signatures inline, and leaves out a half-published one', async () => {
    const m = await aMaster()
    fakeGitHub()
    expect((await m.get('/api/node/v1/server-release', false)).status).toBe(401)
    const res = await m.get('/api/node/v1/server-release')
    expect(res.status).toBe(200)
    const offer = await res.json()
    expect(offer.version).toBe(V)
    expect(offer.minVersion).toBe(config.node.minMasterVersion)
    expect(offer.targets['windows-x64']).toEqual({ bundle: { name: WIN, size: 'WINDOWS-BUNDLE'.length }, signature: SIG, platform: ASC, sha256: HEX })
    expect(offer.targets['linux-x64']).toBeUndefined()
    // A prerelease is served (the promoted version is the gate), and GitHub is asked anonymously.
    expect(calls.every(c => c.auth === null)).toBe(true)
    // FR-20.50: its SUPTO version; nothing is declared yet, so nothing waits.
    expect(offer.supto).toEqual({ version: '1', declared: false, enforced: false })
  })

  it("marks the release's SUPTO version declared or not against this build's list; one that names none is null (P3-8c)", async () => {
    fakeGitHub()
    expect((await serverReleaseOffer(V, { declared: ['1'] }))!.supto).toEqual({ version: '1', declared: true, enforced: true })
    // From the cache, against another list: a declaration needs no new release.
    expect((await serverReleaseOffer(V, { declared: ['0', '2'] }))!.supto).toEqual({ version: '1', declared: false, enforced: true })
    resetServerReleaseCache()
    const without = { ...FILES }
    delete FILES[`lgr-server-${V}.supto`]
    // A release published without one: not among its assets.
    fakeGitHub()
    try {
      expect((await serverReleaseOffer(V, { declared: ['1'] }))!.supto).toEqual({ version: null, declared: false, enforced: true })
    } finally {
      Object.assign(FILES, without)
    }
  })

  it('offers nothing when no version is promoted, or the release does not exist; GitHub trouble is 502, not cached', async () => {
    const m = await aMaster()
    fakeGitHub()
    config.serverRelease.version = ''
    expect((await m.get('/api/node/v1/server-release')).status).toBe(204)
    config.serverRelease.version = '0.9.9'
    expect((await m.get('/api/node/v1/server-release')).status).toBe(204)
    config.serverRelease.version = V
    fakeGitHub({ status: 500 })
    expect((await m.get('/api/node/v1/server-release')).status).toBe(502)
    fakeGitHub()
    expect((await m.get('/api/node/v1/server-release')).status).toBe(200)
  })
})

describe('the bundle', () => {
  it('streams only a bundle of the offered version, with no credentials anywhere', async () => {
    const m = await aMaster()
    fakeGitHub()
    expect((await m.get(`/api/node/v1/server-release/${V}/${WIN}`, false)).status).toBe(401)
    const res = await m.get(`/api/node/v1/server-release/${V}/${WIN}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${WIN}"`)
    expect(await res.text()).toBe('WINDOWS-BUNDLE')
    expect(calls.every(c => c.auth === null)).toBe(true)

    for (const path of [
      `/api/node/v1/server-release/${V}/lgr-server-${V}-x86_64-pc-windows-msvc.msi`, // a release file, not a bundle
      `/api/node/v1/server-release/${V}/${LINUX}`, // a bundle the offer leaves out
      `/api/node/v1/server-release/${V}/${WIN}.sig`,
      `/api/node/v1/server-release/0.1.0/lgr-server-0.1.0-x86_64-pc-windows-msvc.zip`, // not the version on offer
    ]) expect((await m.get(path)).status).toBe(404)
  })
})
