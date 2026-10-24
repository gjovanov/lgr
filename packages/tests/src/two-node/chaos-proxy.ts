import type { Socket, TCPSocketListener } from 'bun'

/**
 * A TCP proxy that misbehaves on request (FR-20 plan Part F.2, step T-1): what stands between a
 * master and lgrai.app in the two-node harness, so a test can cut the uplink, slow it, or make it a
 * blackhole that accepts and never answers, the way a shop's router and ISP actually fail.
 *
 *   drop()         every open connection closed now, both ways (a router reboot)
 *   blackhole()    new connections accepted and never forwarded; open ones go silent (a dead route)
 *   down()/up()    new connections refused; open ones closed (the uplink unplugged, and back)
 *   delay(ms)      every chunk held `ms` before it goes on, each way
 *   throttle(Bps)  each way a link of that many bytes per second (`null` lifts it)
 *   flapAt([...])  down and up again at those offsets in ms, from now
 *
 * In-process and dependency-free: it runs anywhere the tests do, with no `tc` or root.
 */
export interface ChaosProxy {
  readonly port: number
  drop(): void
  blackhole(on?: boolean): void
  down(): void
  up(): void
  delay(ms: number): void
  throttle(bytesPerSecond: number | null): void
  flapAt(points: number[]): void
  stats(): { open: number; accepted: number; refused: number; bytesUp: number; bytesDown: number }
  close(): Promise<void>
}

interface Leg {
  socket?: Socket<Side>
  /** Bytes the kernel would not take yet: written on `drain`. */
  backlog: Uint8Array[]
  /** When the throttled link is next free to send, in ms since the epoch. */
  nextFree: number
}

interface Side {
  pair: Pair
  role: 'client' | 'upstream'
}

interface Pair {
  client: Leg
  upstream: Leg
  /** Silent: accepted under `blackhole`, or open when it was switched on. Nothing is forwarded. */
  silent: boolean
  closed: boolean
  timers: Set<ReturnType<typeof setTimeout>>
}

export async function chaosProxy(target: { hostname: string; port: number }): Promise<ChaosProxy> {
  let mode: 'up' | 'down' | 'blackhole' = 'up'
  let delayMs = 0
  let bytesPerSecond: number | null = null
  const pairs = new Set<Pair>()
  const flaps = new Set<ReturnType<typeof setTimeout>>()
  const counters = { accepted: 0, refused: 0, bytesUp: 0, bytesDown: 0 }

  const end = (pair: Pair) => {
    if (pair.closed) return
    pair.closed = true
    for (const t of pair.timers) clearTimeout(t)
    pair.client.socket?.end()
    pair.upstream.socket?.end()
    pairs.delete(pair)
  }

  const write = (leg: Leg, chunk: Uint8Array) => {
    if (!leg.socket) return void leg.backlog.push(chunk)
    if (leg.backlog.length) return void leg.backlog.push(chunk)
    const n = leg.socket.write(chunk)
    if (n < chunk.length) leg.backlog.push(chunk.subarray(n))
  }

  const flush = (leg: Leg) => {
    while (leg.socket && leg.backlog.length) {
      const chunk = leg.backlog[0]
      const n = leg.socket.write(chunk)
      if (n < chunk.length) {
        leg.backlog[0] = chunk.subarray(n)
        return
      }
      leg.backlog.shift()
    }
  }

  /** Send `chunk` on to `to`, after the delay and when the throttled link is free. */
  const forward = (pair: Pair, to: Leg, chunk: Uint8Array) => {
    if (pair.silent || pair.closed) return
    const copy = new Uint8Array(chunk) // Bun reuses the buffer it handed `data`.
    const now = Date.now()
    let at = now + delayMs
    if (bytesPerSecond) {
      const start = Math.max(at, to.nextFree)
      to.nextFree = start + (copy.length / bytesPerSecond) * 1000
      at = to.nextFree
    }
    if (at <= now) return write(to, copy)
    const t = setTimeout(() => {
      pair.timers.delete(t)
      if (!pair.silent && !pair.closed) write(to, copy)
    }, at - now)
    pair.timers.add(t)
  }

  const listener: TCPSocketListener<Side> = Bun.listen<Side>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        if (mode === 'down') {
          counters.refused++
          client.end()
          return
        }
        counters.accepted++
        const pair: Pair = {
          client: { socket: client, backlog: [], nextFree: 0 },
          upstream: { backlog: [], nextFree: 0 },
          silent: mode === 'blackhole',
          closed: false,
          timers: new Set(),
        }
        client.data = { pair, role: 'client' }
        pairs.add(pair)
        if (pair.silent) return
        Bun.connect<Side>({
          hostname: target.hostname,
          port: target.port,
          socket: {
            open(up) {
              up.data = { pair, role: 'upstream' }
              pair.upstream.socket = up
              flush(pair.upstream)
              if (pair.closed) up.end()
            },
            data(_up, chunk) {
              counters.bytesDown += chunk.length
              forward(pair, pair.client, chunk)
            },
            drain() { flush(pair.upstream) },
            close() { end(pair) },
            error() { end(pair) },
            connectError() { end(pair) },
          },
        }).catch(() => end(pair))
      },
      data(client, chunk) {
        counters.bytesUp += chunk.length
        forward(client.data.pair, client.data.pair.upstream, chunk)
      },
      drain(client) { flush(client.data.pair.client) },
      close(client) { if (client.data) end(client.data.pair) },
      error(client) { if (client.data) end(client.data.pair) },
    },
  })

  const proxy: ChaosProxy = {
    port: listener.port,
    drop() { for (const p of [...pairs]) end(p) },
    blackhole(on = true) {
      mode = on ? 'blackhole' : 'up'
      if (on) for (const p of pairs) p.silent = true
      // The route is back, and what went silent is dead to its client: closed, so it reconnects.
      else for (const p of [...pairs]) if (p.silent) end(p)
    },
    down() {
      mode = 'down'
      proxy.drop()
    },
    up() { mode = 'up' },
    delay(ms) { delayMs = Math.max(0, ms) },
    throttle(bps) { bytesPerSecond = bps && bps > 0 ? bps : null },
    flapAt(points) {
      points.forEach((offset, i) => {
        const t = setTimeout(() => {
          flaps.delete(t)
          if (i % 2 === 0) proxy.down()
          else proxy.up()
        }, offset)
        flaps.add(t)
      })
    },
    stats: () => ({ open: pairs.size, ...counters }),
    async close() {
      for (const t of flaps) clearTimeout(t)
      proxy.drop()
      listener.stop(true)
    },
  }
  return proxy
}
