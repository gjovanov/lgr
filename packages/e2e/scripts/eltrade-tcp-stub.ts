/**
 * A simulated Eltrade fiscal device on TCP, for E2E runs (FR-21 §8.3).
 *
 * The integration tests print on `EltradeSimulator` (`tests/src/helpers/eltrade-simulator.ts`), which
 * validates every ISL frame and keeps the device's receipt state. This wraps its `exchange` in a TCP
 * server, the transport a `tcp` Eltrade device is opened over (`fiscal/isl-tcp.ts`), so Playwright
 * drives the real till, the real driver and the real protocol, with no hardware and no secret.
 *
 * The server reaches it on 127.0.0.1 only when it runs with `FISCAL_TCP_ALLOW_LOOPBACK=1` outside
 * production (`fiscal/tcp-target.ts`); the guard refuses loopback otherwise. Register the device with
 * the simulator's serial, `ED123456`: a УНП naming another device is refused, as a real one refuses it.
 *
 *   bun packages/e2e/scripts/eltrade-tcp-stub.ts &
 *   FISCAL_TCP_ALLOW_LOOPBACK=1 bun packages/portal-api/src/unified.ts
 *
 * HTTP on the next port, for the spec: `GET /state` (receipts with their free text, reports, closures,
 * operators, payment type names), `POST /paper` (`{ "on": false }`: the roll runs out), `POST /reset` (a fresh device; `{ "rates": [А..З] }` programs its VAT groups, `{ "unfiscalized": true }` makes it the unit in the field).
 */
import { createServer, type Socket } from 'node:net'
import { EltradeSimulator } from '../../tests/src/helpers/eltrade-simulator'

const PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const HTTP_PORT = PORT + 1

/**
 * A device a session prints on today: its clock is now, so no sync is ever held for drift. `rates`
 * are its programmed VAT groups А..З, as a device's are: the driver refuses a line whose rate no
 * group carries (the seed's articles are at 18 %, a Bulgarian device's Б at 20 %).
 */
const fresh = (rates?: number[], unfiscalized = false) => {
  const s = new EltradeSimulator()
  s.clock = new Date()
  s.unfiscalizedUnit = unfiscalized
  if (Array.isArray(rates) && rates.length === 8 && rates.every(r => Number.isFinite(r))) s.rates = rates
  return s
}
let sim = fresh()

const STX = 0x01
const PST = 0x05
const ETX = 0x03

/**
 * Whole request frames off the stream: `01 LEN SEQ CMD DATA 05 BCC(4) 03`. A frame ends at the ETX
 * that follows the postamble and its four BCC bytes, so an 0x03 inside the data never cuts one short.
 */
function takeFrames(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []
  let start = buf.indexOf(STX)
  while (start >= 0) {
    let end = -1
    for (let i = start + 9; i < buf.length; i++) {
      if (buf[i] === ETX && buf[i - 5] === PST) { end = i; break }
    }
    if (end < 0) return { frames, rest: buf.subarray(start) }
    frames.push(buf.subarray(start, end + 1))
    start = buf.indexOf(STX, end + 1)
  }
  return { frames, rest: Buffer.alloc(0) }
}

const server = createServer((socket: Socket) => {
  let pending = Buffer.alloc(0)
  // One command at a time, in order, as the device serializes them.
  let chain: Promise<void> = Promise.resolve()
  socket.setNoDelay(true)
  socket.on('error', () => { /* the driver closed the connection */ })
  socket.on('data', (chunk: Buffer) => {
    const { frames, rest } = takeFrames(Buffer.concat([pending, chunk]))
    pending = rest
    for (const frame of frames) {
      chain = chain.then(async () => {
        try {
          const answer = await sim.exchange(frame)
          if (!socket.destroyed) socket.write(answer)
        } catch {
          // `silent` or a lost answer: the device says nothing, and the driver times out.
        }
      })
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`eltrade-tcp-stub: device ${sim.serial} on 127.0.0.1:${PORT}, state on http://127.0.0.1:${HTTP_PORT}/state`)
})

Bun.serve({
  hostname: '127.0.0.1',
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/state') {
      return Response.json({
        serial: sim.serial,
        receipts: sim.receipts,
        reports: sim.reports,
        closure: sim.closure,
        lastDocNumber: sim.lastDocNumber,
        frames: sim.frames,
        // The last text receipt's lines, and how many the device closed (27h): a session report.
        nonFiscalLines: sim.nonFiscalLines,
        fiscalCommands: sim.executed.filter(e => [0x90, 0x31, 0x35, 0x36, 0x38].includes(e.cmd)).length,
        textReceipts: sim.executed.filter(e => e.cmd === 0x27).length,
        // Names only: an operator's password is not the spec's to read back.
        operators: Object.fromEntries(Object.entries(sim.operators).map(([n, op]) => [n, op.name])),
        paymentNames: sim.paymentNames,
        receiptOpen: !!sim.receipt || sim.nonFiscalOpen,
      })
    }
    if (url.pathname === '/paper' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}))
      sim.paper = body?.on !== false
      return Response.json({ paper: sim.paper })
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}))
      sim = fresh(body?.rates, body?.unfiscalized === true)
      return Response.json({ ok: true, rates: sim.rates })
    }
    return new Response('not found', { status: 404 })
  },
})
