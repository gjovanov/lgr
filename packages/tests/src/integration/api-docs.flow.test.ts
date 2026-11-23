import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { apiDocs, apiDocsServed, type ApiDocsEnv } from '../../../portal-api/src/api-docs.js'
import { oneSpaShell, spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'

/**
 * S-11: the API docs (`/swagger`, and the OpenAPI document at `/swagger/json`) are the whole route
 * table with every body schema. Until 2026-11-23 lgrai.app served them to anyone.
 *
 * Mounted as `unified.ts` mounts them: after the error handler, before the API, with a route for
 * the document to describe. Production (`NODE_ENV=production`) serves nothing unless
 * `SWAGGER_ENABLED` asks; development and the tests serve them as before; a master never does
 * (FR-20 AC 66). With the old mount (`swagger()` on every global), the production cases fail.
 */

const WEB = '<html><head><title>LGR</title><meta name="lgr-build" content="b1"></head><body><div id="app"></div></body></html>'
const SHELL = oneSpaShell(WEB, 'global')
const TITLE = 'LGR Unified API'

async function server(role: 'global' | 'master', env: ApiDocsEnv, shell: typeof SHELL | null = SHELL) {
  const app = new Elysia()
    .onError(spaErrorHandler(shell))
    .use(apiDocs(role, env))
    .get('/api/health', () => ({ ok: true }), { detail: { tags: ['Health'] } })
  // A fresh Elysia app can answer its very first request before compilation settles.
  await app.handle(new Request('http://localhost/api/health'))
  return app
}

async function get(app: Elysia, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`))
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
}

/** What a served `/swagger` and `/swagger/json` look like. */
async function expectServed(app: Elysia) {
  const page = await get(app, '/swagger')
  expect(page.status).toBe(200)
  expect(page.body).toContain(TITLE)
  const spec = await get(app, '/swagger/json')
  expect(spec.status).toBe(200)
  const doc = JSON.parse(spec.body)
  expect(doc.openapi).toBeString()
  expect(doc.info.title).toBe(TITLE)
  expect(Object.keys(doc.paths)).toContain('/api/health')
}

/** Neither the page nor the document: the SPA's shell (what any unknown page gets), or a 404 without one. */
async function expectNotServed(app: Elysia, shell: boolean) {
  for (const path of ['/swagger', '/swagger/json']) {
    const res = await get(app, path)
    expect(res.body).not.toContain(TITLE)
    expect(res.body).not.toContain('openapi')
    expect(res.body).not.toContain('/api/health')
    if (shell) {
      expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 200, body: SHELL.portal })
    } else {
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
    }
  }
}

describe('S-11: the API docs in production', () => {
  it('are not served by default, with the web app or without it', async () => {
    await expectNotServed(await server('global', { NODE_ENV: 'production' }), true)
    await expectNotServed(await server('global', { NODE_ENV: 'production' }, null), false)
  })

  it('are served when an operator asks: SWAGGER_ENABLED=true or 1', async () => {
    for (const flag of ['true', '1', ' TRUE ']) {
      await expectServed(await server('global', { NODE_ENV: 'production', SWAGGER_ENABLED: flag }))
    }
  })

  it('stay off for any other SWAGGER_ENABLED value: a typo is not an opt-in', async () => {
    for (const flag of ['', 'false', '0', 'yes', 'on', 'enabled']) {
      await expectNotServed(await server('global', { NODE_ENV: 'production', SWAGGER_ENABLED: flag }), true)
    }
  })
})

describe('S-11: the API docs outside production', () => {
  it('are served in development, under the tests and with NODE_ENV unset, as before', async () => {
    for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, {}] as ApiDocsEnv[]) {
      await expectServed(await server('global', env))
    }
  })

  it('can be turned off there too: SWAGGER_ENABLED=false or 0', async () => {
    for (const flag of ['false', '0']) {
      await expectNotServed(await server('global', { NODE_ENV: 'development', SWAGGER_ENABLED: flag }), true)
    }
  })
})

describe('FR-20 AC 66: a master never serves them', () => {
  it('whatever NODE_ENV and SWAGGER_ENABLED say', async () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', SWAGGER_ENABLED: 'true' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'development', SWAGGER_ENABLED: '1' },
    ] as ApiDocsEnv[]) {
      expect({ env, served: apiDocsServed('master', env) }).toEqual({ env, served: false })
      await expectNotServed(await server('master', env), true)
    }
  })
})

describe('apiDocsServed', () => {
  it('reads the process environment by default, which is the tests\' own here', () => {
    // `bun test` runs with NODE_ENV=test unless the run sets it: served, as in development.
    if (process.env.NODE_ENV !== 'production' && !process.env.SWAGGER_ENABLED) {
      expect(apiDocsServed('global')).toBe(true)
    }
    expect(apiDocsServed('master')).toBe(false)
  })
})
