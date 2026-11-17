import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMMUTABLE, isHashedAsset, uiStaticPlugin } from '../../../portal-api/src/spa-fallback.js'
import { compressDir } from '../../../web/scripts/compress-assets.ts'

/**
 * FR-30.24 / .26 (#795, slice G): the web app's files as the server sends them.
 *
 * A file whose name carries its content hash is served `public, max-age=31536000, immutable`; a file without one is
 * not. A browser that accepts Brotli or gzip gets the build's precompressed copy of a hashed file, with its type.
 * Both static modes (`alwaysStatic`, which NODE_ENV=production selects, and the dynamic one).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let dir = ''
const JS = 'console.log("the first load")\n'.repeat(50)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lgr-static-cache-'))
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui', 'index-D5rzSlo0.js'), JS)
  writeFileSync(join(dir, 'ui', 'index-B9xq_Lk2.css'), 'body{color:red}'.repeat(30))
  writeFileSync(join(dir, 'ui', 'favicon.svg'), '<svg/>')
  writeFileSync(join(dir, 'ui', 'app-settings.js'), 'console.log(1)')
  compressDir(join(dir, 'ui'))
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('which names carry a content hash', () => {
  it('Vite\'s eight characters after the last dash, not a word of eight letters', () => {
    expect(isHashedAsset('/ui/index-D5rzSlo0.js')).toBe(true)
    expect(isHashedAsset('/ui/mdi-subset-Bq1-x_9a.woff2')).toBe(true)
    expect(isHashedAsset('/ui/app-settings.js')).toBe(false)
    expect(isHashedAsset('/ui/favicon.svg')).toBe(false)
    expect(isHashedAsset('/index.html')).toBe(false)
  })
})

for (const alwaysStatic of [true, false]) {
  describe(`alwaysStatic=${alwaysStatic}`, () => {
    let app: Elysia
    beforeAll(async () => {
      app = new Elysia().use(await uiStaticPlugin({ assets: join(dir, 'ui'), prefix: '/ui' }, { alwaysStatic })) as any
      await app.handle(new Request('http://localhost/ui/favicon.svg'))
    })
    const get = (path: string, encoding?: string) => app.handle(new Request(`http://localhost${path}`, { headers: encoding ? { 'accept-encoding': encoding } : {} }))

    it('a hashed file is cached for good, an unhashed one is not', async () => {
      const hashed = await get('/ui/index-D5rzSlo0.js')
      expect(hashed.status).toBe(200)
      expect(hashed.headers.get('cache-control')).toBe(IMMUTABLE)
      expect(await hashed.text()).toBe(JS)
      for (const path of ['/ui/favicon.svg', '/ui/app-settings.js']) {
        const res = await get(path)
        expect({ path, status: res.status, immutable: (res.headers.get('cache-control') ?? '').includes('immutable') }).toEqual({ path, status: 200, immutable: false })
      }
    })

    it('a browser that accepts Brotli or gzip gets the precompressed copy, with its type', async () => {
      const br = await get('/ui/index-D5rzSlo0.js', 'gzip, deflate, br')
      expect(br.headers.get('content-encoding')).toBe('br')
      expect(br.headers.get('content-type') ?? '').toContain('javascript')
      expect(br.headers.get('cache-control')).toBe(IMMUTABLE)
      expect(Buffer.from(await br.arrayBuffer())).toEqual(Buffer.from(await Bun.file(join(dir, 'ui', 'index-D5rzSlo0.js.br')).arrayBuffer()))
      const gz = await get('/ui/index-B9xq_Lk2.css', 'gzip')
      expect(gz.headers.get('content-encoding')).toBe('gzip')
      expect(gz.headers.get('content-type') ?? '').toContain('css')
      // No encoding asked for: the file as it is.
      const plain = await get('/ui/index-D5rzSlo0.js')
      expect(plain.headers.get('content-encoding')).toBeNull()
    })
  })
}

describe('a build of more than 1 024 files, as NODE_ENV=production serves it', () => {
  // The static plugin's `alwaysStatic` registers nothing over its `staticLimit` (1 024 by default), and every asset
  // answered 404: the `.br`/`.gz` copies took the web build past it (the server package's boot test, 2026-11-17).
  let big = ''
  beforeAll(() => {
    big = mkdtempSync(join(tmpdir(), 'lgr-static-many-'))
    mkdirSync(join(big, 'ui'))
    for (let i = 0; i < 400; i++) writeFileSync(join(big, 'ui', `chunk${i}-D5rzSl${String(i).padStart(3, '0').slice(-2)}.js`), JS)
    compressDir(join(big, 'ui'))
  })
  afterAll(() => {
    if (big) rmSync(big, { recursive: true, force: true })
  })

  it('still serves each file, and its precompressed copy is no route of its own', async () => {
    const app = new Elysia().use(await uiStaticPlugin({ assets: join(big, 'ui'), prefix: '/ui' }, { alwaysStatic: true })) as any
    const name = 'chunk399-D5rzSl99.js'
    const plain = await app.handle(new Request(`http://localhost/ui/${name}`))
    expect({ status: plain.status, body: await plain.text() }).toEqual({ status: 200, body: JS })
    const br = await app.handle(new Request(`http://localhost/ui/${name}`, { headers: { 'accept-encoding': 'br' } }))
    expect({ status: br.status, encoding: br.headers.get('content-encoding') }).toEqual({ status: 200, encoding: 'br' })
    expect((await app.handle(new Request(`http://localhost/ui/${name}.br`))).status).toBe(404)
  })
})
