import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/**
 * Where the server may open a TCP connection to a fiscal device.
 *
 * The device's address is typed by a user (an admin, manager or warehouse manager of an org — and
 * anyone can register an org), so it is an address the server would otherwise connect to on that
 * user's say-so. Every TCP connection a fiscal device opens goes through `resolveFiscalTcpTarget`.
 *
 * - `public-only` — lgrai.app (`nodeRole() === 'global'`). A device the cloud can reach is on the
 *   internet; a private address could only ever be the cluster's own network.
 * - `lan` — an on-prem master (FR-20). The printer sits on the shop's LAN, so private ranges are
 *   allowed. Loopback, link-local and the other special ranges still are not.
 */
export type FiscalTcpPolicy = 'public-only' | 'lan'

export function fiscalTcpPolicy(role: 'global' | 'master'): FiscalTcpPolicy {
  return role === 'master' ? 'lan' : 'public-only'
}

export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'unspecified' | 'multicast' | 'reserved'

export class FiscalTargetError extends Error {
  constructor(message: string, readonly code: 'missing_host' | 'unresolvable' | 'forbidden') {
    super(message)
    this.name = 'FiscalTargetError'
  }
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number)
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d
}

function inV4(n: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)
}

export function classifyIPv4(ip: string): AddressClass {
  const n = ipv4ToInt(ip)
  if (inV4(n, '0.0.0.0', 8)) return 'unspecified'
  if (inV4(n, '127.0.0.0', 8)) return 'loopback'
  if (inV4(n, '169.254.0.0', 16)) return 'link-local'
  if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16)) return 'private'
  // Carrier-grade NAT shared space: never an internet host, and inside a cluster it can be one.
  if (inV4(n, '100.64.0.0', 10)) return 'private'
  if (inV4(n, '224.0.0.0', 4)) return 'multicast'
  if (
    inV4(n, '240.0.0.0', 4) // reserved, incl. 255.255.255.255
    || inV4(n, '192.0.0.0', 24) // IETF protocol assignments
    || inV4(n, '192.0.2.0', 24) || inV4(n, '198.51.100.0', 24) || inV4(n, '203.0.113.0', 24) // documentation
    || inV4(n, '198.18.0.0', 15) // benchmarking
  ) return 'reserved'
  return 'public'
}

/** The 8 hextets of an IPv6 address (`isIP(ip) === 6` assumed), with an embedded IPv4 tail expanded. */
function ipv6Hextets(ip: string): number[] {
  let s = ip.split('%')[0].toLowerCase()
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[1])
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : []
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : []
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16))
}

function embeddedV4(x: number[]): string {
  return `${x[6] >> 8}.${x[6] & 0xff}.${x[7] >> 8}.${x[7] & 0xff}`
}

export function classifyIPv6(ip: string): AddressClass {
  const x = ipv6Hextets(ip)
  const zeroUpTo = (k: number) => x.slice(0, k).every((v) => v === 0)
  if (x.every((v) => v === 0)) return 'unspecified'
  if (zeroUpTo(7) && x[7] === 1) return 'loopback'
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64) reach the IPv4 address they carry.
  if (zeroUpTo(5) && x[5] === 0xffff) return classifyIPv4(embeddedV4(x))
  if (x[0] === 0x64 && x[1] === 0xff9b && x.slice(2, 6).every((v) => v === 0)) return classifyIPv4(embeddedV4(x))
  if (zeroUpTo(6)) return 'reserved' // deprecated IPv4-compatible ::a.b.c.d
  if ((x[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((x[0] & 0xfe00) === 0xfc00) return 'private' // unique local fc00::/7
  if ((x[0] & 0xff00) === 0xff00) return 'multicast'
  if (x[0] === 0x2001 && x[1] === 0x0db8) return 'reserved' // documentation
  return 'public'
}

export function classifyAddress(ip: string): AddressClass {
  const v = isIP(ip)
  if (v === 4) return classifyIPv4(ip)
  if (v === 6) return classifyIPv6(ip)
  return 'reserved'
}

function allowed(cls: AddressClass, policy: FiscalTcpPolicy): boolean {
  if (cls === 'public') return true
  if (cls === 'private') return policy === 'lan'
  return false
}

export type HostResolver = (host: string) => Promise<string[]>

const systemResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address)

/**
 * The address to connect a TCP fiscal device to — the RESOLVED address, never the name, so an
 * answer that changes between this check and the connect cannot redirect the socket.
 *
 * Every address a name resolves to must be allowed: a name answering with one public and one
 * internal address is refused. A host that is not a literal IP goes through the system resolver,
 * which also normalises every other spelling of an address.
 */
export async function resolveFiscalTcpTarget(
  host: string | null | undefined,
  policy: FiscalTcpPolicy,
  resolve: HostResolver = systemResolver,
): Promise<string> {
  const h = (host ?? '').trim()
  if (!h) throw new FiscalTargetError('A TCP fiscal device needs its IP address or host name.', 'missing_host')

  let addresses: string[]
  if (isIP(h)) {
    addresses = [h]
  } else {
    try {
      addresses = await resolve(h)
    } catch {
      throw new FiscalTargetError(`The fiscal device host "${h}" could not be resolved.`, 'unresolvable')
    }
    if (!addresses.length) throw new FiscalTargetError(`The fiscal device host "${h}" could not be resolved.`, 'unresolvable')
  }

  for (const address of addresses) {
    const cls = classifyAddress(address)
    if (!allowed(cls, policy)) {
      throw new FiscalTargetError(
        policy === 'lan'
          ? `The server does not connect fiscal devices to ${address} (${cls}).`
          : `The server does not connect fiscal devices to ${address} (${cls}). A device on the shop's own network is reached through the browser, LGR Desktop or an on-prem LGR server.`,
        'forbidden',
      )
    }
  }
  return addresses[0]
}
