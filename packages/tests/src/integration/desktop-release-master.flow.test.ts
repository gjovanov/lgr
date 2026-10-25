import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Desktop } from 'db/models'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { resetDesktopReleaseCache } from 'services/biz/desktop/release-download'
import { cachedFile, cachedRelease } from 'services/biz/desktop/release-cache'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'

/**
 * Desktop updates through the master (FR-20.56, plan step P2-7).
 *
 * On global, `/api/node/v1/desktop-release` tells a registered master which release to keep: the
 * configured version, its files and the updater signatures. On a master, the tills' `/update`,
 * `latest-release` and downloads are answered from the release the supervisor keeps, linked on the
 * master's LAN address, with every name and path checked.
 */

const d = config.desktop as any
const original = { token: d.releaseGithubToken, repo: d.releaseRepo, version: d.releaseVersion, dir: d.releasesDir }
const realFetch = globalThis.fetch
const lanBefore = { ...(config.front as any).lan }
let app: any
let cache: string

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  await clearCollections()
  globalThis.fetch = realFetch
  Object.assign(d, { releaseGithubToken: original.token, releaseRepo: original.repo, releaseVersion: original.version, releasesDir: original.dir })
  ;(config.node as any).role = 'global'
  ;(config.front as any).lan = lanBefore
  resetDesktopReleaseCache()
  if (cache) rmSync(cache, { recursive: true, force: true })
})

const SETUP = 'LGR.Desktop_1.2.3_x64-setup.exe'

/** A cache as the supervisor leaves it: a version directory, its release.json, current.json. */
function writeCache(): string {
  cache = mkdtempSync(join(tmpdir(), 'lgr-desktop-releases-'))
  const v = join(cache, '1.2.3')
  mkdirSync(v)
  writeFileSync(join(v, SETUP), 'INSTALLER!')
  writeFileSync(join(v, `${SETUP}.sig`), 'c2ln')
  writeFileSync(join(v, 'LGR.Desktop_1.2.3_x64_en-US.msi'), 'partial') // listed at another size: never served
  writeFileSync(join(v, 'evil.txt'), 'not a release file')
  writeFileSync(join(v, 'release.json'), JSON.stringify({
    version: '1.2.3',
    notes: 'faster',
    minVersion: '0.1.0',
    files: [
      { name: SETUP, size: 10 },
      { name: `${SETUP}.sig`, size: 4 },
      { name: 'LGR.Desktop_1.2.3_x64_en-US.msi', size: 999 },
      { name: 'evil.txt', size: 18 },
    ],
    updater: { 'windows-x86_64': { file: SETUP, signature: 'c2ln' }, 'darwin-aarch64': { file: 'not-listed.app.tar.gz', signature: 'x' } },
  }))
  writeFileSync(join(cache, 'current.json'), JSON.stringify({ version: '1.2.3', previous: null }))
  return cache
}

async function aDesktopToken() {
  const org = await createTestOrg()
  const desktop = await Desktop.create({ orgId: org._id, name: 'TILL-1', installationId: `inst-${Math.random()}`, machineId: 'machine-1', publicKey: 'x'.repeat(60), status: 'active' })
  return signDesktopToken({ desktopId: String(desktop._id), orgId: String(org._id), keyEpoch: 1 }).token
}

const call = (path: string, token?: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }))

describe('a master serves its tills from the release it keeps', () => {
  it('reads only what the supervisor completed, and only release files at their recorded size', () => {
    d.releasesDir = writeCache()
    const r = cachedRelease()!
    expect(r.version).toBe('1.2.3')
    expect(r.files.map(f => f.name)).not.toContain('evil.txt')
    // An updater entry naming a file that is not listed is dropped.
    expect(Object.keys(r.updater)).toEqual(['windows-x86_64'])
    expect(cachedFile('1.2.3', SETUP)?.size).toBe(10)
    expect(cachedFile('1.2.3', 'LGR.Desktop_1.2.3_x64_en-US.msi')).toBeNull() // a part-file's size
    expect(cachedFile('1.2.3', 'evil.txt')).toBeNull()
    expect(cachedFile('1.2.3', '../current.json')).toBeNull()
    expect(cachedFile('../1.2.3', SETUP)).toBeNull()
    d.releasesDir = join(cache, 'nowhere')
    expect(cachedRelease()).toBeNull()
  })

  it('answers /update, latest-release and the download on its LAN address', async () => {
    d.releasesDir = writeCache()
    // The till is enrolled first: on a master the write guard refuses an org that is not homed here.
    const token = await aDesktopToken()
    ;(config.node as any).role = 'master'
    ;(config.front as any).lan = { ...lanBefore, url: 'https://192.168.1.10:4443', caFingerprint: 'sha256:test', stateFile: '' }
    app = new Elysia().use(createApiApp())

    const update = await call('/api/desktop/v1/update?platform=windows-x86_64', token)
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual({ version: '1.2.3', url: `https://192.168.1.10:4443/api/desktop/download/1.2.3/${SETUP}`, signature: 'c2ln', notes: 'faster' })
    expect((await call('/api/desktop/v1/update?platform=darwin-aarch64', token)).status).toBe(204)

    const latest = await (await call('/api/desktop/v1/latest-release', token)).json()
    expect(latest.release).toEqual({ version: '1.2.3', url: 'https://192.168.1.10:4443/api/desktop/download/1.2.3', notes: 'faster' })

    const file = await call(`/api/desktop/download/1.2.3/${SETUP}`)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('INSTALLER!')
    expect((await call('/api/desktop/download/1.2.3/evil.txt')).status).toBe(404)
    const page = await call('/api/desktop/download/1.2.3')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain(SETUP)
  })

  it('without a release kept, or without its LAN address, there is nothing to install', async () => {
    const token = await aDesktopToken()
    ;(config.node as any).role = 'master'
    d.releasesDir = ''
    app = new Elysia().use(createApiApp())
    expect((await call('/api/desktop/v1/update?platform=windows-x86_64', token)).status).toBe(204)
    expect((await call(`/api/desktop/download/1.2.3/${SETUP}`)).status).toBe(404)
  })
})

describe('global tells a registered master which release to keep', () => {
  async function nodeToken() {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const stub = makeNodeStub()
    const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
    await enrollNode({ ...nodeEnrollBody(stub, 'https://lgrai.app/api/node/v1/enroll'), code } as any, ['https://lgrai.app/api/node/v1/enroll'])
    return (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: 'https://lgrai.app/api/node/v1/token' }), ['https://lgrai.app/api/node/v1/token'])).token
  }

  it('is 204 when no release, or no download, is configured; and denies a caller without a node token', async () => {
    app = new Elysia().use(createApiApp())
    expect((await call('/api/node/v1/desktop-release')).status).toBe(401)
    d.releaseRepo = ''
    expect((await call('/api/node/v1/desktop-release', await nodeToken())).status).toBe(204)
  })

  it('names the version, its servable files and the updater signature per platform', async () => {
    Object.assign(d, { releaseGithubToken: 'test-token', releaseRepo: 'gjovanov/lgr', releaseVersion: '1.2.3' })
    const assets = [
      { id: 1, name: SETUP, size: 10 },
      { id: 2, name: `${SETUP}.sig`, size: 4 },
      { id: 3, name: 'lane-results.tsv', size: 1 }, // not a release file
    ]
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.includes('/releases/tags/desktop-v1.2.3')) return Response.json({ draft: false, prerelease: false, assets })
      if (url.endsWith('/releases/assets/2')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/2' } })
      if (url.startsWith('https://storage.example/2')) return new Response('c2ln', { status: 200, headers: { 'content-length': '4' } })
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    app = new Elysia().use(createApiApp())
    const res = await call('/api/node/v1/desktop-release', await nodeToken())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('1.2.3')
    expect(body.files).toEqual([{ name: SETUP, size: 10 }, { name: `${SETUP}.sig`, size: 4 }])
    expect(body.updater).toEqual({ 'windows-x86_64': { file: SETUP, signature: 'c2ln' } })
  })
})
