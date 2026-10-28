import { describe, it, expect } from 'bun:test'
import {
  classifyAddress,
  fiscalTcpPolicy,
  resolveFiscalTcpTarget,
  FiscalTargetError,
  type HostResolver,
} from 'fiscal/tcp-target'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * The address check every TCP fiscal-device connection goes through (H6). A user types the
 * device's host; these are the addresses the server must still refuse to open a socket to.
 */
describe('classifyAddress', () => {
  const cases: Array<[string, string]> = [
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.10.3', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['169.254.169.254', 'link-local'],
    ['10.20.30.40', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.20', 'private'],
    ['100.64.0.1', 'private'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['203.0.113.7', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.5', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd12:3456::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2a00:1450:4001:81d::200e', 'public'],
    ['not-an-ip', 'reserved'],
  ]
  for (const [ip, cls] of cases) {
    it(`${ip} → ${cls}`, () => expect(classifyAddress(ip)).toBe(cls))
  }
})

describe('resolveFiscalTcpTarget', () => {
  const resolving = (map: Record<string, string[]>): HostResolver => async (host) => {
    if (!(host in map)) throw new Error('ENOTFOUND')
    return map[host]
  }

  it('refuses a TCP device with no host', async () => {
    for (const host of [undefined, null, '', '   ']) {
      const err = await captureRejection(resolveFiscalTcpTarget(host as any, 'public-only'))
      expect(err).toBeInstanceOf(FiscalTargetError)
      expect((err as FiscalTargetError).code).toBe('missing_host')
    }
  })

  it('accepts a public address and returns it', async () => {
    expect(await resolveFiscalTcpTarget('8.8.8.8', 'public-only')).toBe('8.8.8.8')
  })

  it('on lgrai.app refuses private addresses; an on-prem master accepts them', async () => {
    const err = await captureRejection(resolveFiscalTcpTarget('192.168.1.20', 'public-only'))
    expect((err as FiscalTargetError).code).toBe('forbidden')
    expect(await resolveFiscalTcpTarget('192.168.1.20', 'lan')).toBe('192.168.1.20')
  })

  it('refuses loopback, link-local and unspecified everywhere, in every spelling', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1']) {
      for (const policy of ['public-only', 'lan'] as const) {
        const err = await captureRejection(resolveFiscalTcpTarget(host, policy))
        expect((err as FiscalTargetError)?.code).toBe('forbidden')
      }
    }
  })

  it('checks EVERY address a name resolves to, and connects to the resolved address, not the name', async () => {
    const resolve = resolving({ 'printer.example': ['8.8.4.4'], 'mixed.example': ['8.8.4.4', '10.0.0.9'] })
    expect(await resolveFiscalTcpTarget('printer.example', 'public-only', resolve)).toBe('8.8.4.4')
    const err = await captureRejection(resolveFiscalTcpTarget('mixed.example', 'public-only', resolve))
    expect((err as FiscalTargetError).code).toBe('forbidden')
  })

  it('refuses a name that does not resolve', async () => {
    const err = await captureRejection(resolveFiscalTcpTarget('nowhere.example', 'public-only', resolving({})))
    expect((err as FiscalTargetError).code).toBe('unresolvable')
  })

  it('sees through the system resolver: localhost and 127.1 are the server itself', async () => {
    for (const host of ['localhost', '127.1']) {
      const err = await captureRejection(resolveFiscalTcpTarget(host, 'lan'))
      expect(err).toBeInstanceOf(FiscalTargetError)
      expect(['forbidden', 'unresolvable']).toContain((err as FiscalTargetError).code)
    }
  })

  it('maps node roles to policies: the cloud is public-only, a master may reach its LAN', () => {
    expect(fiscalTcpPolicy('global', {})).toBe('public-only')
    expect(fiscalTcpPolicy('master', {})).toBe('lan')
  })

  // FR-21 §8.3: the e2e suite's simulated Eltrade listens on 127.0.0.1.
  it('allows loopback only with FISCAL_TCP_ALLOW_LOOPBACK=1 outside production', async () => {
    const on = { FISCAL_TCP_ALLOW_LOOPBACK: '1', NODE_ENV: 'development' }
    expect(fiscalTcpPolicy('global', on)).toBe('loopback-test')
    expect(fiscalTcpPolicy('master', on)).toBe('loopback-test')
    expect(await resolveFiscalTcpTarget('127.0.0.1', fiscalTcpPolicy('global', on))).toBe('127.0.0.1')

    // In production the variable is ignored: the cloud stays public-only, a master stays on its LAN.
    for (const role of ['global', 'master'] as const) {
      const policy = fiscalTcpPolicy(role, { FISCAL_TCP_ALLOW_LOOPBACK: '1', NODE_ENV: 'production' })
      expect(policy).toBe(role === 'master' ? 'lan' : 'public-only')
      const err = await captureRejection(resolveFiscalTcpTarget('127.0.0.1', policy))
      expect((err as FiscalTargetError).code).toBe('forbidden')
    }
    // Only the exact value turns it on.
    expect(fiscalTcpPolicy('global', { FISCAL_TCP_ALLOW_LOOPBACK: 'true' })).toBe('public-only')
  })

  it('the test policy still refuses link-local and the other special ranges', async () => {
    for (const host of ['169.254.169.254', '0.0.0.0', '224.0.0.1']) {
      const err = await captureRejection(resolveFiscalTcpTarget(host, 'loopback-test'))
      expect((err as FiscalTargetError).code).toBe('forbidden')
    }
  })
})
