import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { mongoose } from 'db/connection'
import { runMigrations } from 'migrations/runner'
import { REPO_ROOT, MANIFEST, type ServerManifest } from '../../../../scripts/lib/server-package.ts'

/**
 * A BUILT server package boots and works (FR-20.26, plan step P0b-9): what `build:server` wrote,
 * run as a master would run it, against a real database.
 *
 * Runs only with `LGR_SERVER_PACKAGE=<dir>`, so CI builds the package first (`build:server`) and
 * then runs this file. `bun run test` skips it.
 *
 * Each case is a trap the first bundle walked into:
 *   - NODE_ENV inlined at build time: the production guards compiled out, so the bundle STARTED with
 *     no JWT_SECRET. It must refuse.
 *   - the PDF stylesheets read from beside the source: every PDF failed with ENOENT.
 *   - the migration checksum taken over `up.toString()`: a bundled runner read migrations applied
 *     from source as changed, and refused to start.
 */

const configured = process.env.LGR_SERVER_PACKAGE
const PKG = configured ? (isAbsolute(configured) ? configured : join(REPO_ROOT, configured)) : ''
const enabled = !!PKG && existsSync(join(PKG, MANIFEST))

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64')
const PORT = 43000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`

function env(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) if (v !== undefined) e[k] = v
  return e
}

/** A production environment for the package, as a supervisor would give it. */
const productionEnv = () => env({
  NODE_ENV: 'production',
  MONGODB_URI: testDbUri(),
  PORT: String(PORT),
  HOST: '127.0.0.1',
  JWT_SECRET: random(),
  DESKTOP_TOKEN_SECRET: random(),
  NODE_TOKEN_SECRET: random(),
  OAUTH_FRONTEND_URL: BASE,
  LGR_UI_ROOT: join(PKG, 'ui'),
  MIGRATIONS_AUTO: 'false',
})

async function run(args: string[], environment: Record<string, string>, timeoutMs = 120_000) {
  const proc = Bun.spawn(['bun', ...args], { cwd: PKG, env: environment, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, out: stdout + stderr }
}

let server: ReturnType<typeof Bun.spawn> | undefined
let manifest: ServerManifest

describe.skipIf(!enabled)('a built server package', () => {
  beforeAll(async () => {
    await setupTestDB()
    manifest = JSON.parse(readFileSync(join(PKG, MANIFEST), 'utf8'))
    // The demo data the e2e suite signs into, written by the source seed.
    const seed = await run([join(REPO_ROOT, 'packages', 'tests', 'src', 'helpers', 'seed.ts')], env({ MONGODB_URI: testDbUri() }), 240_000)
    expect(seed.code).toBe(0)
  }, 300_000)

  afterAll(async () => {
    server?.kill()
    await server?.exited
    await teardownTestDB()
  }, 60_000)

  it('refuses to start in production without JWT_SECRET: NODE_ENV is read at run time', async () => {
    const result = await run([manifest.entries.server], { ...productionEnv(), JWT_SECRET: '' }, 60_000)
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('JWT_SECRET is not set')
  }, 90_000)

  it('boots, serves the web app from its ui/, signs in and prints an invoice', async () => {
    server = Bun.spawn(['bun', manifest.entries.server], { cwd: PKG, env: productionEnv(), stdout: 'pipe', stderr: 'pipe' })
    // Read as it comes, so a chatty server never fills the pipe, and a boot that hangs says where.
    let said = ''
    const keep = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) said = (said + decoder.decode(chunk)).slice(-4000)
    }
    void keep(server.stdout as ReadableStream<Uint8Array>)
    void keep(server.stderr as ReadableStream<Uint8Array>)
    const deadline = Date.now() + 90_000
    for (;;) {
      const up = await fetch(`${BASE}/api/health`).then(r => r.status === 200, () => false)
      if (up) break
      if (Date.now() > deadline) throw new Error(`the package did not answer /api/health within 90 s. It said:\n${said}`)
      await Bun.sleep(500)
    }

    const shell = await fetch(`${BASE}/inventory/products`)
    expect({ step: 'shell', status: shell.status }).toEqual({ step: 'shell', status: 200 })
    const html = await shell.text()
    // FR-24.24: the one SPA, its assets under /ui/, on a module's page too.
    const asset = html.match(/\/ui\/[^"']+\.js/)?.[0]
    expect(asset).toBeDefined()
    expect({ step: asset, status: (await fetch(`${BASE}${asset}`)).status }).toEqual({ step: asset, status: 200 })

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })
    expect({ step: 'login', status: login.status }).toEqual({ step: 'login', status: 200 })
    const { token, org } = (await login.json()) as any
    const auth = { authorization: `Bearer ${token}` }
    const listed = await fetch(`${BASE}/api/org/${org.id}/invoices?page=1&size=1`, { headers: auth })
    expect({ step: 'invoice list', status: listed.status }).toEqual({ step: 'invoice list', status: 200 })
    const list = (await listed.json()) as any
    const invoice = list.invoices[0]
    const pdf = await fetch(`${BASE}/api/org/${org.id}/invoicing/export/${invoice._id}?format=pdf`, { headers: auth })
    expect({ step: 'pdf', status: pdf.status }).toEqual({ step: 'pdf', status: 200 })
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
  }, 240_000)

  // A package has the one SPA: what a till stores has to come from the server, and lead to a page.
  it("answers a till's stored /pos/ with a 302 into Invoicing, which it serves", async () => {
    const moved = await fetch(`${BASE}/pos/`, { redirect: 'manual' })
    expect({ status: moved.status, location: moved.headers.get('location') }).toEqual({ status: 302, location: '/invoicing/cash-sales/new' })
    const shell = await fetch(`${BASE}/invoicing/cash-sales/new`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('/ui/')
    expect(manifest.ui).toEqual(['web'])
  })

  it('its migrate reads what a source runner applied as applied, and applies nothing', async () => {
    await runMigrations({ db: mongoose.connection.db! })
    const status = await run([manifest.entries.migrate, '--status'], productionEnv())
    expect(status.code).toBe(0)
    expect(status.out).not.toContain('changed')
    expect(status.out).not.toContain('pending')
    const apply = await run([manifest.entries.migrate], productionEnv())
    expect(apply.code).toBe(0)
    expect(apply.out).toContain('Up to date')
  }, 120_000)

  it('each packaged script runs, in its dry-run default', async () => {
    // assign-din-tags needs the catalog and the org's fastener categories in place.
    const catalog = await run(['app/scripts/seed-din-catalog.js', '--org', 'acme-corp', '--execute'], productionEnv())
    expect({ script: 'seed-din-catalog', code: catalog.code, out: catalog.out.slice(-400) }).toMatchObject({ code: 0 })
    for (const script of manifest.scripts) {
      const result = await run([`app/scripts/${script}.js`, '--org', 'acme-corp'], productionEnv())
      expect({ script, code: result.code, out: result.out.slice(-400) }).toMatchObject({ script, code: 0 })
    }
  }, 300_000)
})
