import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isModulePath, oneSpaShell, spaErrorHandler, uiStaticPlugin, webBuildId } from '../../../portal-api/src/spa-fallback.js'
import { corsPlugin } from '../../../portal-api/src/cors.js'
import { isolationHeaders } from '../../../portal-api/src/isolation-headers.js'

/**
 * The unified server answers every browser route with the SPA's shell, status 200 (FR-24.21: one\n * SPA, in two variants: a module's page never carries the analytics tag, FR-24.18).
 *
 * Found in production on 2026-10-05: `/`, `/login` and every deep link were their HTML with
 * status **404**. Browsers rendered the page anyway, so nobody saw it; the deploy script's smoke
 * request to `/` did, and reported DEPLOY_FAILED on every rollout that had in fact succeeded.
 * The trigger was `NODE_ENV=production` (S-24): it switches `@elysiajs/static` into `alwaysStatic`
 * mode, under which Elysia overwrote the handler's `set.status = 200` with the error's 404. The
 * fix holds in both modes, so both are pinned here, through the real plugins in production order
 * (the isolation headers, CORS, the error handler, then the static mounts).
 */

let dir: string
const WEB = '<html><head><title>LGR</title><meta name="lgr-build" content="b1"></head><body></body></html>'
const SHELL = oneSpaShell(WEB, 'global')

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'spa-fallback-'))
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), WEB)
  writeFileSync(join(dir, 'ui', 'app.js'), 'console.log("web")')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function server(alwaysStatic: boolean, shell: typeof SHELL | null = SHELL) {
  const app = new Elysia()
    .use(isolationHeaders())
    .use(corsPlugin())
    .onError(spaErrorHandler(shell))
    .get('/api/health', () => ({ ok: true }))
  // Awaited here, as in `unified.ts`.
  app.use(await uiStaticPlugin({ assets: join(dir, 'ui'), prefix: '/ui' }, { alwaysStatic }))
  // A fresh Elysia app can answer its very first request before compilation settles.
  await app.handle(new Request('http://localhost/api/health'))
  return app
}
async function get(app: Elysia, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`))
  return { status: res.status, type: res.headers.get('content-type') ?? '', cache: res.headers.get('cache-control') ?? '', body: await res.text() }
}

// `alwaysStatic: true` is what NODE_ENV=production selects; `false` is NODE_ENV unset.
for (const alwaysStatic of [true, false]) {
  describe(`@elysiajs/static alwaysStatic=${alwaysStatic}`, () => {
    it('answers the root and every portal route with the portal shell, 200, never cached', async () => {
      const app = await server(alwaysStatic)
      for (const path of ['/', '/login', '/app-hub', '/auth/activate']) {
        const res = await get(app, path)
        expect({ path, status: res.status }).toEqual({ path, status: 200 })
        expect(res.type).toContain('text/html')
        expect(res.cache).toContain('no-store')
        expect(res.body).toBe(SHELL.portal)
      }
    })

    it("answers a module's deep link with the module shell: the same app, no analytics (FR-24.18)", async () => {
      const app = await server(alwaysStatic)
      for (const path of ['/inventory/products/123/edit', '/invoicing/pos/terminal', '/reports']) {
        const res = await get(app, path)
        expect({ path, status: res.status }).toEqual({ path, status: 200 })
        expect(res.body).toBe(SHELL.module)
        expect(res.body).not.toContain('purestat')
      }
      expect((await get(app, '/apps')).body).toContain('purestat')
    })

    it('serves real files, and 404s a missing file or an unknown API route instead of a shell', async () => {
      const app = await server(alwaysStatic)
      expect((await get(app, '/ui/app.js')).status).toBe(200)
      for (const path of ['/ui/missing.js', '/assets/app.js', '/inventory/assets/inv.js', '/api/nothing-here']) {
        const res = await get(app, path)
        expect({ path, status: res.status }).toEqual({ path, status: 404 })
        expect(res.body).not.toContain('<html>')
      }
      expect((await get(app, '/api/health')).status).toBe(200)
    })

    it('answers no page at all when no web app is built', async () => {
      const app = await server(alwaysStatic, null)
      expect((await get(app, '/')).status).toBe(404)
      expect((await get(app, '/api/health')).status).toBe(200)
    })

    // FR-24 Phase 0: the POS pages are routes of the invoicing module. Desktops hold `startPath: /pos/`.
    it('answers the old POS addresses with a 302 to /invoicing/pos/*, query kept, and nothing else', async () => {
      const app = await server(alwaysStatic)
      for (const [path, to] of [
        ['/pos', '/invoicing/pos'],
        ['/pos/', '/invoicing/pos/'],
        ['/pos/terminal', '/invoicing/pos/terminal'],
        ['/pos/orders?session=abc&q=CS-1', '/invoicing/pos/orders?session=abc&q=CS-1'],
        ['/pos/devices/123', '/invoicing/pos/devices/123'],
      ]) {
        const res = await app.handle(new Request(`http://localhost${path}`, { redirect: 'manual' }))
        expect({ path, status: res.status, location: res.headers.get('location') }).toEqual({ path, status: 302, location: to })
      }
      // Not POS: a path that only starts with the letters, and a POST.
      expect((await get(app, '/posts')).body).toBe(SHELL.portal)
      const post = await app.handle(new Request('http://localhost/pos/terminal', { method: 'POST' }))
      expect(post.status).not.toBe(302)
    })

    // FR-24.21: the shell switch of FR-24.13 is gone; its addresses go home and drop the old choice.
    it('sends /__ui/one and /__ui/split home, clearing the lgr_ui cookie', async () => {
      const app = await server(alwaysStatic)
      for (const choice of ['one', 'split']) {
        const res = await app.handle(new Request(`http://localhost/__ui/${choice}`, { headers: { cookie: 'lgr_ui=split' }, redirect: 'manual' }))
        expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status: 302, location: '/' })
        expect(res.headers.get('set-cookie')).toContain('lgr_ui=;')
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
      }
      // The cookie itself changes nothing any more: every browser gets the one shell.
      const withCookie = await app.handle(new Request('http://localhost/inventory/products', { headers: { cookie: 'lgr_ui=split' } }))
      expect(await withCookie.text()).toBe(SHELL.module)
    })
    // FR-20.72 (plan step P0a-8): a sibling subdomain may load none of these as a subresource.
    it('puts the isolation headers on every answer, through a listening server as well', async () => {
      const app = await server(alwaysStatic)
      const paths = [
        '/', '/login', '/inventory/products/123/edit', // the shell, served by the error handler
        '/ui/app.js', // a file, served by the static plugin
        '/ui/missing.js', '/api/nothing-here', '/api/health',
      ]
      const isolation = (path: string, res: Response) => ({
        path,
        corp: res.headers.get('cross-origin-resource-policy'),
        oac: res.headers.get('origin-agent-cluster'),
      })
      for (const path of paths) {
        const res = await app.handle(new Request(`http://localhost${path}`))
        expect(isolation(path, res)).toEqual({ path, corp: 'same-origin', oac: '?1' })
      }

      // `listen` answers matched routes from Bun's own route table, not through `handle`.
      app.listen({ hostname: '127.0.0.1', port: 0 })
      try {
        const base = `http://127.0.0.1:${app.server!.port}`
        for (const path of paths) {
          const res = await fetch(base + path)
          await res.arrayBuffer()
          expect(isolation(path, res)).toEqual({ path, corp: 'same-origin', oac: '?1' })
        }
      } finally {
        await app.stop(true)
      }
    })
  })
}

describe('FR-24.14/24.18/24.21 helpers', () => {
  it("tells a module's page from the portal's by its prefix", () => {
    for (const p of ['/inventory', '/inventory/products', '/invoicing/pos/terminal', '/files/x']) expect(isModulePath(p)).toBe(true)
    for (const p of ['/', '/apps', '/auth/login', '/inventoryx', '/pos/terminal']) expect(isModulePath(p)).toBe(false)
  })

  it('takes the build id from the one SPA shell', () => {
    expect(webBuildId('<meta name="lgr-build" content="abc-1">')).toBe('abc-1')
    expect(webBuildId('<html></html>')).toBeNull()
    expect(webBuildId(undefined)).toBeNull()
  })

  it('puts the master tag on every page of a master, and analytics only on the global portal', () => {
    const html = '<html><head></head></html>'
    const global = oneSpaShell(html, 'global')
    expect(global.module).toBe(html)
    expect(global.portal).toContain('purestat')
    const master = oneSpaShell(html, 'master')
    expect(master.module).toContain('lgr-node')
    expect(master.portal).toContain('lgr-node')
    expect(master.portal).not.toContain('purestat')
  })
})