import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spaErrorHandler, uiStaticPlugin } from '../../../portal-api/src/spa-fallback.js'
import { corsPlugin } from '../../../portal-api/src/cors.js'
import { isolationHeaders } from '../../../portal-api/src/isolation-headers.js'

/**
 * The unified server answers every browser route of the SPAs with that SPA's shell, status 200.
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
const PORTAL = '<html><title>LGR Portal</title></html>'
const INVENTORY = '<html><title>LGR Inventory</title></html>'

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'spa-fallback-'))
  mkdirSync(join(dir, 'portal', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'inventory', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'portal', 'index.html'), PORTAL)
  writeFileSync(join(dir, 'portal', 'assets', 'app.js'), 'console.log("portal")')
  writeFileSync(join(dir, 'inventory', 'index.html'), INVENTORY)
  writeFileSync(join(dir, 'inventory', 'assets', 'inv.js'), 'console.log("inventory")')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function server(alwaysStatic: boolean) {
  const app = new Elysia()
    .use(isolationHeaders())
    .use(corsPlugin())
    .onError(spaErrorHandler({ portal: PORTAL, inventory: INVENTORY }))
    .get('/api/health', () => ({ ok: true }))
  // Awaited here; `unified.ts` hands the promise to `use()`, which the server resolves at listen.
  app.use(await uiStaticPlugin({ assets: join(dir, 'portal'), prefix: '' }, { alwaysStatic }))
  app.use(await uiStaticPlugin({ assets: join(dir, 'inventory'), prefix: '/inventory' }, { alwaysStatic }))
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
        expect(res.body).toBe(PORTAL)
      }
    })

    it("answers a module's deep link with that module's own shell", async () => {
      const app = await server(alwaysStatic)
      const res = await get(app, '/inventory/products/123/edit')
      expect(res.status).toBe(200)
      expect(res.body).toBe(INVENTORY)
    })

    it('serves real files, and 404s a missing file or an unknown API route instead of a shell', async () => {
      const app = await server(alwaysStatic)
      expect((await get(app, '/assets/app.js')).status).toBe(200)
      expect((await get(app, '/inventory/assets/inv.js')).status).toBe(200)
      for (const path of ['/assets/missing.js', '/inventory/assets/missing.js', '/api/nothing-here']) {
        const res = await get(app, path)
        expect({ path, status: res.status }).toEqual({ path, status: 404 })
        expect(res.body).not.toContain('<html>')
      }
      expect((await get(app, '/api/health')).status).toBe(200)
    })

    // FR-20.72 (plan step P0a-8): a sibling subdomain may load none of these as a subresource.
    it('puts the isolation headers on every answer, through a listening server as well', async () => {
      const app = await server(alwaysStatic)
      const paths = [
        '/', '/login', '/inventory/products/123/edit', // the shell, served by the error handler
        '/index.html', '/assets/app.js', '/inventory/assets/inv.js', // files, served by the static plugin
        '/assets/missing.js', '/api/nothing-here', '/api/health',
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
