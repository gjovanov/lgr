/**
 * `create-api-user.ts` against a stand-in PlusMinus server (just enough of /login, /server and /mobile).
 *
 * The tool signs in as the store's shared admin account, and PlusMinus allows ONE session per account name: a session it
 * leaves open locks the store's own admin GUI and every nightly job out. `process.exit()` inside its `try` used to skip the
 * `finally` that disconnects, so a dry run (the default!) and every failure left the admin connected. These tests pin that
 * the admin session is closed on every path, and that the guards (slot held, unknown build) take no session at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', '..', '..', '..', '.claude', 'skills', 'pull-plusminus-api', 'create-api-user.ts')

type StubOptions = {
  roles?: string[]
  /** The raw body of roles(), for a server that keeps no role table: regal-sf answers with nothing at all. */
  rolesBody?: string
  /** The role labels on the accounts themselves. */
  accountRoles?: string[]
  adminConnected?: boolean
  build?: string
  companySelect?: string
  adminLogin?: string
}

function stub(opts: StubOptions = {}) {
  const calls: string[] = []
  const users = new Set(['admin', 'till'])
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = await req.text()
      if (path === '/login') return new Response('<input id=token name=token style=display:none value=0a1b2c3d-4e5f>')
      if (path === '/server') {
        const [method] = JSON.parse(body) as string[]
        calls.push(`server:${method}`)
        if (method === 'clients') return new Response(opts.adminConnected ? 'admin,till' : 'till')
        if (method === 'buildTime') return new Response(opts.build ?? '20260805:101606')
      }
      if (path === '/mobile') {
        const [method, a] = JSON.parse(body) as string[]
        calls.push(`mobile:${method}`)
        switch (method) {
          case 'userLogin':
            if (a === 'admin') return new Response(opts.adminLogin ?? 'session-admin-0001')
            return new Response(users.has(a) ? 'session-new-account-1' : '-1')
          case 'companySelect': return new Response(opts.companySelect ?? 'true')
          case 'currentUser': return new Response('"admin"')
          case 'users': return new Response(JSON.stringify([...users]))
          case 'usersData': return new Response(JSON.stringify([...users].map((user, i) => ({ user, role: (opts.accountRoles ?? ['seller'])[i % (opts.accountRoles ?? ['seller']).length] }))))
          case 'userData': return new Response('{}')
          case 'userPermissions': return new Response('[]')
          case 'roles': return new Response(opts.rolesBody ?? JSON.stringify(opts.roles ?? ['seller']))
          case 'userDataAdd': users.add(a); return new Response('true')
          case 'disconnect': return new Response('true')
        }
      }
      return new Response('unexpected', { status: 404 })
    },
  })
  return { calls, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

let dir: string
let adminFile: string
let storesEnv: string
let credsOut: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'create-api-user-'))
  adminFile = join(dir, 'admin.txt')
  storesEnv = join(dir, 'stores.env')
  credsOut = join(dir, 'out', 'api.txt')
  writeFileSync(adminFile, 'un: admin\npw: not-a-real-password\n')
  writeFileSync(storesEnv, `SF_PM_COMPANY=Test Company\nSF_DOCS_ROOT=${join(dir, 'docs')}\nPM_CREDS=${adminFile}\n`)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function run(baseUrl: string, extra: string[] = [], role = 'seller') {
  // hermetic: no store identifiers from the caller's own environment
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SF_|PZ_|PM_|EMAIL_KEY|PLUSMINUS_)/.test(k)) env[k] = v
  env.PLUSMINUS_STORES_ENV = storesEnv
  const proc = Bun.spawn(
    ['bun', SCRIPT, '--org', 'regal-sf', '--base-url', baseUrl, '--role', role, '--creds-out', credsOut, '--admin-creds', adminFile, ...extra],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

const count = (calls: string[], what: string) => calls.filter(c => c === what).length

describe('create-api-user.ts', () => {
  it('a dry run writes nothing and still disconnects the admin session it opened', async () => {
    const s = stub()
    const r = await run(s.url)
    s.stop()
    expect(r.code).toBe(0)
    expect(r.out).toContain('dry run: nothing written')
    expect(count(s.calls, 'mobile:userLogin')).toBe(1)
    expect(count(s.calls, 'mobile:disconnect')).toBe(1)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
    expect(existsSync(credsOut)).toBe(false)
  }, 60_000)

  it('a role the server does not have exits 2, names the roles, and disconnects', async () => {
    const s = stub({ roles: ['seller', 'manager'] })
    const r = await run(s.url, [], 'nope')
    s.stop()
    expect(r.code).toBe(2)
    expect(r.err).toContain('is not one of this server')
    expect(r.err).toContain('seller, manager')
    expect(count(s.calls, 'mobile:disconnect')).toBe(1)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
  }, 60_000)

  it('a server with no role table takes a label its accounts carry, not an empty answer to parse', async () => {
    const s = stub({ rolesBody: '', accountRoles: ['manager', 'seller'] })
    const r = await run(s.url, ['--execute'])
    s.stop()
    expect(r.err).not.toContain('SyntaxError')
    expect(r.code).toBe(0)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(1)
    expect(count(s.calls, 'mobile:disconnect')).toBe(2)
  }, 60_000)

  it('on a server with no role table an unknown role still exits 2, names the labels in use once each, and disconnects', async () => {
    const s = stub({ rolesBody: '', accountRoles: ['manager', 'manager'] })
    const r = await run(s.url, [], 'nope')
    s.stop()
    expect(r.code).toBe(2)
    expect(r.err).toContain('is not one of this server')
    expect(r.err).toMatch(/roles: managers*$/m)
    expect(count(s.calls, 'mobile:disconnect')).toBe(1)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
  }, 60_000)

  it('a company that will not select exits 1 and disconnects', async () => {
    const s = stub({ companySelect: 'false' })
    const r = await run(s.url)
    s.stop()
    expect(r.code).toBe(1)
    expect(r.err).toContain('companySelect failed')
    expect(count(s.calls, 'mobile:disconnect')).toBe(1)
  }, 60_000)

  it('--execute adds exactly one account, proves it, and disconnects both sessions', async () => {
    const s = stub()
    const r = await run(s.url, ['--execute'])
    s.stop()
    expect(r.code).toBe(0)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(1)
    expect(count(s.calls, 'mobile:disconnect')).toBe(2) // the admin session and the new account's proof session
    expect(r.out).toContain('existing accounts unchanged: 2 of 2')
    const saved = readFileSync(credsOut, 'utf8')
    expect(saved).toMatch(/^un: lgr-api$/m)
    expect(saved).toMatch(/^pw: \S{24}$/m)
    expect(r.out).not.toContain(saved.match(/^pw: (\S+)$/m)![1]) // the password is never printed
  }, 60_000)

  it('the admin account being connected exits 3 before it takes any session', async () => {
    const s = stub({ adminConnected: true })
    const r = await run(s.url, ['--execute'])
    s.stop()
    expect(r.code).toBe(3)
    expect(count(s.calls, 'mobile:userLogin')).toBe(0)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
  }, 60_000)

  it('a userLogin that answers -2 (connected in the race) exits 3 and has nothing to disconnect', async () => {
    const s = stub({ adminLogin: '-2' })
    const r = await run(s.url, ['--execute'])
    s.stop()
    expect(r.code).toBe(3)
    expect(count(s.calls, 'mobile:disconnect')).toBe(0)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
  }, 60_000)

  it('a server build whose userDataAdd was not read is refused before any login', async () => {
    const s = stub({ build: '20260101:000000' })
    const r = await run(s.url, ['--execute'])
    s.stop()
    expect(r.code).toBe(4)
    expect(count(s.calls, 'mobile:userLogin')).toBe(0)
    expect(count(s.calls, 'mobile:userDataAdd')).toBe(0)
  }, 60_000)
})
