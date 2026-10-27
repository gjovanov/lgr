/**
 * FR-20.16 (plan step P1-3) — the API's half of the front, function by function. The real process
 * behind a real front is `integration/front.flow.test.ts`; this file pins the rules that a route
 * table cannot show, such as `/internal/*` refused while no such route exists yet.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { config } from 'config'
import {
  frontClientIp,
  frontRefusal,
  frontSource,
  hostAllowed,
  isOrgAddressHost,
  normalizedPath,
  refusedOnHttp,
  secretMatches,
} from '../../../portal-api/src/front/front-guard'
import { clientIp } from '../../../portal-api/src/auth/client-ip'

const SECRET = 'a'.repeat(43)
const saved = { role: config.node.role, front: { ...config.front } }

afterEach(() => {
  ;(config.node as any).role = saved.role
  Object.assign(config.front, saved.front)
})

function behindFront() {
  ;(config.node as any).role = 'master'
  Object.assign(config.front, { secret: SECRET, hosts: ['kasa-1.local'] })
}

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://kasa-1.local:4443${path}`, { method, headers })
const stamped = (source: string, path: string, method = 'GET') =>
  req(path, { 'x-lgr-front': SECRET, 'x-lgr-source': source, host: 'kasa-1.local:4443' }, method)

describe('hostAllowed', () => {
  test('a listed name in any case, with or without a port or a trailing dot', () => {
    for (const h of ['kasa-1.local', 'KASA-1.local:4443', 'kasa-1.local.', 'kasa-1.local.:80']) {
      expect([h, hostAllowed(h, ['kasa-1.local'])]).toEqual([h, true])
    }
  })
  test('any IP literal, and localhost: DNS rebinding always arrives under a name', () => {
    for (const h of ['127.0.0.1:4001', '192.168.1.20', '[::1]:4443', '[fe80::1]', 'localhost', 'LOCALHOST:4443']) {
      expect([h, hostAllowed(h, [])]).toEqual([h, true])
    }
  })
  test('any other name, an empty or a malformed Host', () => {
    for (const h of ['attacker.example', 'kasa-1.local.attacker.example', 'kasa-1', '', ':4443', '[::1', '[not-an-ip]', '::1']) {
      expect([h, hostAllowed(h, ['kasa-1.local'])]).toEqual([h, false])
    }
    expect(hostAllowed(undefined, ['kasa-1.local'])).toBe(false)
  })
})

describe("an org's address, through the tunnel (FR-20.72, P3-4c)", () => {
  test('a label under the apex is an org address; nothing else is', () => {
    for (const h of ['shop-a.lgrai.app', 'SHOP-A.lgrai.app:443', 'shop-a.lgrai.app.']) expect([h, isOrgAddressHost(h)]).toEqual([h, true])
    for (const h of ['lgrai.app', 'a.b.lgrai.app', '-x.lgrai.app', 'shop_a.lgrai.app', 'shop-a.lgrai.app.evil.example', 'evil-lgrai.app', `${'a'.repeat(64)}.lgrai.app`, '']) {
      expect([h, isOrgAddressHost(h)]).toEqual([h, false])
    }
    expect(isOrgAddressHost(undefined)).toBe(false)
  })

  test('the address is answered for the tunnel source only: a LAN request under that name is refused', async () => {
    behindFront()
    const at = (source: string) => new Request('http://shop-a.lgrai.app/api/things', { headers: { 'x-lgr-front': SECRET, 'x-lgr-source': source, host: 'shop-a.lgrai.app' } })
    expect(await frontRefusal(at('tunnel'))).toBeUndefined()
    const lan = await frontRefusal(at('lan'))
    expect([lan?.status, (await lan?.json())?.code]).toEqual([403, 'host_not_allowed'])
    // Without the front secret nothing is answered, whatever it claims.
    const forged = await frontRefusal(new Request('http://shop-a.lgrai.app/', { headers: { 'x-lgr-source': 'tunnel', host: 'shop-a.lgrai.app' } }))
    expect(forged?.status).toBe(403)
    // Another name, even through the tunnel: refused.
    const other = await frontRefusal(new Request('http://attacker.example/', { headers: { 'x-lgr-front': SECRET, 'x-lgr-source': 'tunnel', host: 'attacker.example' } }))
    expect((await other?.json())?.code).toBe('host_not_allowed')
  })
})

describe('the paths refused over HTTP (AC 47)', () => {
  test('/internal and /api/setup, in any case, escaped, doubled or trailing', () => {
    for (const p of ['/internal', '/internal/', '/internal/repl/page', '/INTERNAL/x', '//internal/x', '/%69nternal/x',
      '/api/setup', '/api/setup/complete', '/api//setup/x', '/api/Setup/', '/api/%73etup', '\\internal\\x']) {
      expect([p, refusedOnHttp(normalizedPath(p))]).toEqual([p, true])
    }
  })
  test('nothing that merely starts with the same letters', () => {
    for (const p of ['/internals', '/api/setups', '/api/settings', '/api/org/1/internal-orders', '/']) {
      expect([p, refusedOnHttp(normalizedPath(p))]).toEqual([p, false])
    }
  })
  test('a malformed escape is left as it is, and matches nothing', () => {
    expect(normalizedPath('/internal%zz')).toBe('/internal%zz')
    expect(refusedOnHttp(normalizedPath('/internal%zz'))).toBe(false)
  })
})

describe('secretMatches', () => {
  test('the exact secret only', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true)
    expect(secretMatches(SECRET.slice(1), SECRET)).toBe(false)
    expect(secretMatches(SECRET + 'a', SECRET)).toBe(false)
    expect(secretMatches('', SECRET)).toBe(false)
    expect(secretMatches(null, SECRET)).toBe(false)
  })
})

describe('frontRefusal', () => {
  test('with no front (global, dev, the tests) it serves everything a global would', async () => {
    ;(config.node as any).role = 'global'
    Object.assign(config.front, { secret: undefined, hosts: [] })
    expect(await frontRefusal(req('/api/health'))).toBeUndefined()
    expect(await frontRefusal(req('/api/auth/register', {}, 'POST'))).toBeUndefined()
    // No route exists there on global: refusing it is a master's rule, not a global one.
    expect(await frontRefusal(req('/internal/x'))).toBeUndefined()
  })

  test('a master with no front still refuses /internal, /api/setup and org creation', async () => {
    ;(config.node as any).role = 'master'
    Object.assign(config.front, { secret: undefined, hosts: [] })
    expect((await frontRefusal(req('/internal/repl/page')))?.status).toBe(404)
    expect((await frontRefusal(req('/api/setup/complete', {}, 'POST')))?.status).toBe(404)
    expect((await frontRefusal(req('/api/auth/register', {}, 'POST')))?.status).toBe(404)
    // A stamp means nothing without the front: nobody could have sent it but the client.
    expect((await frontRefusal(req('/api/auth/register', { 'x-lgr-source': 'console' }, 'POST')))?.status).toBe(404)
    expect(await frontRefusal(req('/api/health'))).toBeUndefined()
  })

  test('behind the front: secret, then Host, then the source stamp', async () => {
    behindFront()
    expect((await frontRefusal(req('/api/health')))?.status).toBe(403)
    expect((await frontRefusal(req('/api/health', { 'x-lgr-front': SECRET, 'x-lgr-source': 'tunnel', host: 'evil.example' })))?.status).toBe(403)
    expect((await frontRefusal(req('/api/health', { 'x-lgr-front': SECRET, host: 'kasa-1.local' })))?.status).toBe(403)
    expect(await frontRefusal(stamped('tunnel', '/api/health'))).toBeUndefined()
  })

  test('the routes that create an org: the console only', async () => {
    behindFront()
    for (const path of ['/api/auth/register', '/api/auth/orgs', '/api/oauth/pending/register', '/API/auth/register/']) {
      expect((await frontRefusal(stamped('tunnel', path, 'POST')))?.status).toBe(404)
      expect((await frontRefusal(stamped('lan', path, 'POST')))?.status).toBe(404)
      expect(await frontRefusal(stamped('console', path, 'POST'))).toBeUndefined()
    }
    // Reading the orgs is not creating one.
    expect(await frontRefusal(stamped('tunnel', '/api/auth/orgs'))).toBeUndefined()
  })

  test('a LAN request without a desktop credential: 401, but for the three exact routes', async () => {
    behindFront()
    const refused = await frontRefusal(stamped('lan', '/api/org/1/invoicing/invoices'))
    expect(refused?.status).toBe(401)
    expect((await refused!.json()).code).toBe('desktop_required')
    expect(await frontRefusal(stamped('lan', '/api/health'))).toBeUndefined()
    expect(await frontRefusal(stamped('lan', '/api/desktop/v1/enroll', 'POST'))).toBeUndefined()
    expect(await frontRefusal(stamped('lan', '/api/desktop/v1/token', 'POST'))).toBeUndefined()
    // Exact: the wrong method or a variant of the path is gated.
    for (const [path, method] of [['/api/health/', 'GET'], ['/api/desktop/v1/enroll', 'GET'], ['/api/desktop/v1/%65nroll', 'POST'], ['/API/health', 'GET']]) {
      expect([path, method, (await frontRefusal(stamped('lan', path, method)))?.status]).toEqual([path, method, 401])
    }
  })
})

describe('the stamps are read only behind the front', () => {
  test('frontSource and frontClientIp', () => {
    const headers = { 'x-lgr-source': 'console', 'x-lgr-client-ip': '192.168.1.20' }
    Object.assign(config.front, { secret: undefined })
    expect(frontSource(headers)).toBeUndefined()
    expect(frontClientIp(headers)).toBeUndefined()
    Object.assign(config.front, { secret: SECRET })
    expect(frontSource(headers)).toBe('console')
    expect(frontClientIp(headers)).toBe('192.168.1.20')
    expect(frontSource({ 'x-lgr-source': 'everywhere' })).toBeUndefined()
  })

  test('clientIp: behind the front only the stamp, never the forwarding headers a client can write', () => {
    const headers = { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '7.7.7.7', 'x-lgr-client-ip': '192.168.1.20' }
    Object.assign(config.front, { secret: undefined })
    expect(clientIp(headers)).toBe('6.6.6.6')
    Object.assign(config.front, { secret: SECRET })
    expect(clientIp(headers)).toBe('192.168.1.20')
    expect(clientIp({ 'x-real-ip': '6.6.6.6' })).toBeUndefined()
  })
})
