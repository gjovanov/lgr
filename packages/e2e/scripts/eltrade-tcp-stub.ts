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
 * operators, payment type names), `POST /paper` (`{ "on": false }`: the roll runs out), `POST /fault` (`{ "paperOutAt": 56 }`: the roll runs out as that command arrives; `{}` clears it), `POST /reset` (a fresh device; `{ "rates": [А..З] }` programs its VAT groups, `{ "unfiscalized": true }` makes it the unit in the field).
 *
 * `POST /fault` also takes a hold, `{ "holdAt": 56, "holdMs": 20000 }`: the next 38h keeps the device
 * busy for 20 s before it runs, sending SYN every 60 ms as a printing device does, so the driver waits
 * rather than timing out. `/state` names the command in `holding` for as long as the hold lasts. That
 * window is what the VM lanes' `cable-pull` and `crash-mid-print` use to pull a cable or kill the API
 * at an exact point in a print. A hold is one-shot, so the retry prints at the device's own pace. A new
 * `/fault` (`{}` included) or `/reset` ends a hold in progress, and its command then runs and answers.
 *
 * `ELTRADE_STUB_HOST` binds the device's port elsewhere, for the VM lanes' `bridge-lan` (lgr-deploy
 * `vmtest/`): a till guest's COM1 is a QEMU chardev that connects to it from the VM host. The HTTP
 * port stays on 127.0.0.1 whatever it says: it can reset the device, so nothing off the machine
 * reaches it.
 */
import { createServer, type Socket } from 'node:net'
import { EltradeSimulator } from '../../tests/src/helpers/eltrade-simulator'

const PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const HOST = process.env.ELTRADE_STUB_HOST || '127.0.0.1'
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
const SYN = Buffer.from([0x16])

/** How often a busy device says SYN (protocol §В). */
const SYN_EVERY_MS = 60
/** No command is given longer than a report's 300 s (`TIMEOUT_MS.report` in `fiscal/eltrade.ts`). */
const HOLD_MAX_MS = 300_000

/** The hold `/fault` armed, if any. */
let hold: { at: number; ms: number } | null = null
/** The hold in progress, if any, and how to end it early. */
let holding: { cmd: number; since: string; ms: number; end: () => void } | null = null
/** How many holds the device has been through since it was fresh. */
let held = 0

/**
 * Keep the device busy on this connection for `ms`: SYN every 60 ms, as a device says while it prints.
 * Either transport waits through that (`fiscal/isl-tcp.ts`, the shell's `framing.rs`), where silence
 * would end the exchange at the 2.5 s first-byte limit. Takes the armed hold, so it runs once.
 */
function busy(socket: Socket, cmd: number, ms: number): Promise<void> {
  hold = null
  held++
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const syn = setInterval(() => { if (!socket.destroyed) socket.write(SYN) }, SYN_EVERY_MS)
    const end = () => {
      clearInterval(syn)
      clearTimeout(timer)
      if (holding?.end === end) holding = null
      resolve()
    }
    timer = setTimeout(end, ms)
    holding = { cmd, since: new Date().toISOString(), ms, end }
  })
}

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
          // A retransmit (the SEQ it answered last) is a replay: the device resends that answer at once.
          const replay = frame[2] === sim.lastSeq && sim.lastAnswer !== null
          if (hold && frame[3] === hold.at && !replay) await busy(socket, frame[3], hold.ms)
          const answer = await sim.exchange(frame)
          if (!socket.destroyed) socket.write(answer)
        } catch {
          // `silent` or a lost answer: the device says nothing, and the driver times out.
        }
      })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`eltrade-tcp-stub: device ${sim.serial} on ${HOST}:${PORT}, state on http://127.0.0.1:${HTTP_PORT}/state`)
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
        // The hold armed, the one in progress and how many have run: a lane acts while `holding` is set.
        hold,
        holding: holding && { cmd: holding.cmd, since: holding.since, ms: holding.ms },
        held,
      })
    }
    if (url.pathname === '/paper' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}))
      sim.paper = body?.on !== false
      return Response.json({ paper: sim.paper })
    }
    if (url.pathname === '/fault' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}))
      const at = body?.paperOutAt
      const next = body?.holdAt === undefined ? null : { at: body.holdAt, ms: body.holdMs }
      const valid = (h: { at: unknown; ms: unknown }) =>
        Number.isInteger(h.at) && (h.at as number) >= 0 && (h.at as number) <= 0xff &&
        Number.isInteger(h.ms) && (h.ms as number) > 0 && (h.ms as number) <= HOLD_MAX_MS
      // Refused whole: a lane that asked for a hold it did not get would pass without testing anything.
      if (next && !valid(next)) {
        return Response.json({ error: `holdAt is a command code (0-255), holdMs 1-${HOLD_MAX_MS}` }, { status: 400 })
      }
      sim.beforeCommand = at === undefined ? null : (cmd: number) => { if (cmd === at) sim.paper = false }
      holding?.end()
      hold = next
      return Response.json({ paperOutAt: at ?? null, hold })
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}))
      sim = fresh(body?.rates, body?.unfiscalized === true)
      if (Number.isInteger(body?.lastDocNumber)) sim.lastDocNumber = body.lastDocNumber
      holding?.end()
      hold = null
      held = 0
      return Response.json({ ok: true, rates: sim.rates })
    }
    return new Response('not found', { status: 404 })
  },
})
