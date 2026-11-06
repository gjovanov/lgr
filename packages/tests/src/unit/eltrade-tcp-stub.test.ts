/**
 * The e2e Eltrade stub's hold (`packages/e2e/scripts/eltrade-tcp-stub.ts`), through the transport the
 * server opens a `tcp` device with (`fiscal/isl-tcp.ts`).
 *
 * The VM lanes `cable-pull` and `crash-mid-print` (lgr-deploy `vmtest/`) hold a print at the device so
 * they can cut a till's cable or kill the API in the middle of it. That window only exists while the
 * transport keeps waiting. A held command must say SYN, as a printing device does. Without it the
 * exchange ends at the 2.5 s first-byte limit, and the lane tests a timeout instead of its own fault.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { IslTcpTransport } from 'fiscal/isl-tcp'
import { buildIslFrame, parseIslStream } from 'fiscal/isl-frame'
import { formatDeviceDateTime, parseDeviceDateTime } from 'fiscal/zoned-time'

const STUB = join(import.meta.dir, '..', '..', '..', 'e2e', 'scripts', 'eltrade-tcp-stub.ts')
/** 4Ah, the status read: prints nothing, so a hold on it tests the wire and nothing else. */
const STATUS = 0x4A

const free = (port: number) => new Promise<boolean>(resolve => {
  const s = createServer()
  s.once('error', () => resolve(false))
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
})

/** The stub takes two ports in a row: the device's, and its HTTP port right after it. */
async function freePair(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const base = 20_000 + Math.floor(Math.random() * 40_000)
    if (await free(base) && await free(base + 1)) return base
  }
  throw new Error('no two free ports in a row')
}

let proc: ReturnType<typeof Bun.spawn> | undefined
let tx: IslTcpTransport | undefined
let http = ''
let seq = 0x20

/** A status frame under a SEQ the device has not answered last: a new command, never a replay. */
function command(): Buffer {
  seq = seq >= 0x7F ? 0x20 : seq + 1
  return Buffer.from(buildIslFrame(seq, STATUS))
}

const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: 'POST', body: JSON.stringify(body) })
const state = async (): Promise<any> => (await fetch(`${http}/state`)).json()

async function until(what: string, ok: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

beforeAll(async () => {
  const port = await freePair()
  http = `http://127.0.0.1:${port + 1}`
  const child = Bun.spawn([process.execPath, STUB], {
    env: { ...process.env, ELTRADE_STUB_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc = child
  // The device port listens after the HTTP one, and says so on stdout.
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ''
  const deadline = Date.now() + 20_000
  while (!out.includes('eltrade-tcp-stub: device')) {
    const { value, done } = await reader.read()
    if (done || Date.now() > deadline) throw new Error(`the stub did not start: ${out}`)
    out += decoder.decode(value)
  }
  reader.releaseLock()
  tx = new IslTcpTransport('127.0.0.1', port)
  await tx.open()
})

afterAll(() => {
  tx?.close()
  proc?.kill()
})

describe('eltrade-tcp-stub: a hold', () => {
  it('outlasts the transport\'s first-byte limit on SYN, then runs and answers', async () => {
    const armed = await (await post('/fault', { holdAt: STATUS, holdMs: 3_000 })).json()
    expect(armed.hold).toEqual({ at: STATUS, ms: 3_000 })

    const frame = command()
    const started = Date.now()
    const answer = tx!.exchange(frame) // a 30 s budget: the 2.5 s first-byte and 8 s idle limits apply
    await until('the hold', async () => (await state()).holding !== null)
    const during = await state()
    expect(during.holding).toMatchObject({ cmd: STATUS, ms: 3_000 })
    expect(during.hold).toBeNull() // taken by the command it held

    const raw = await answer
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900)
    const parsed = parseIslStream(raw)
    expect(parsed.frames.map(f => f.seq)).toEqual([frame[2]])
    expect(parsed.syn).toBeGreaterThan(20)

    const after = await state()
    expect(after.holding).toBeNull()
    expect(after.held).toBe(1)
  }, 20_000)

  it('is one-shot: the next command answers at once', async () => {
    const started = Date.now()
    const parsed = parseIslStream(await tx!.exchange(command()))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(parsed.syn).toBe(0)
    expect(parsed.frames).toHaveLength(1)
  }, 20_000)

  it('is not taken by a retransmit, which the device answers from its last answer', async () => {
    const frame = command()
    await tx!.exchange(frame)
    await post('/fault', { holdAt: STATUS, holdMs: 30_000 })
    const started = Date.now()
    const parsed = parseIslStream(await tx!.exchange(frame)) // the same SEQ again
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(parsed.frames.map(f => f.seq)).toEqual([frame[2]])
    expect((await state()).hold).toEqual({ at: STATUS, ms: 30_000 })
    await post('/fault', {})
  }, 20_000)

  it('ends when a new /fault arrives, and its command answers then', async () => {
    await post('/fault', { holdAt: STATUS, holdMs: 60_000 })
    const frame = command()
    const started = Date.now()
    const answer = tx!.exchange(frame)
    await until('the hold', async () => (await state()).holding !== null)
    const cleared = await (await post('/fault', {})).json()
    expect(cleared.hold).toBeNull()
    const parsed = parseIslStream(await answer)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(parsed.frames.map(f => f.seq)).toEqual([frame[2]])
    expect((await state()).holding).toBeNull()
  }, 20_000)

  it('ends on /reset, which also forgets how many holds ran', async () => {
    await post('/fault', { holdAt: STATUS, holdMs: 60_000 })
    const answer = tx!.exchange(command())
    await until('the hold', async () => (await state()).holding !== null)
    expect((await post('/reset', {})).ok).toBe(true)
    expect(parseIslStream(await answer).frames).toHaveLength(1)
    const after = await state()
    expect(after).toMatchObject({ hold: null, holding: null, held: 0 })
  }, 20_000)

  it('is refused whole when it cannot be honoured, and the armed one stays', async () => {
    await post('/fault', { holdAt: 0x90, holdMs: 1_000 })
    for (const bad of [
      { holdAt: STATUS },
      { holdAt: STATUS, holdMs: 0 },
      { holdAt: STATUS, holdMs: 1.5 },
      { holdAt: STATUS, holdMs: 300_001 },
      { holdAt: 0x100, holdMs: 1_000 },
      { holdAt: '0x4A', holdMs: 1_000 },
    ]) {
      const res = await post('/fault', bad)
      expect(res.status).toBe(400)
    }
    expect((await state()).hold).toEqual({ at: 0x90, ms: 1_000 })
    await post('/fault', {})
    expect((await state()).hold).toBeNull()
  }, 20_000)
})

describe('eltrade-tcp-stub: the device clock', () => {
  /** What 3Eh says the time is, as the driver reads it. */
  async function readClock(): Promise<Date> {
    seq = seq >= 0x7F ? 0x20 : seq + 1
    const parsed = parseIslStream(await tx!.exchange(Buffer.from(buildIslFrame(seq, 0x3E))))
    const d = parseDeviceDateTime(new TextDecoder().decode(parsed.frames[0].data))
    if (!d) throw new Error('3Eh answered no time')
    return d
  }
  function setClock(to: Date) {
    seq = seq >= 0x7F ? 0x20 : seq + 1
    return tx!.exchange(Buffer.from(buildIslFrame(seq, 0x3D, new TextEncoder().encode(formatDeviceDateTime(to)))))
  }

  it('runs, as a device\'s does: a fresh one reads this machine\'s time', async () => {
    await post('/reset', {})
    const first = await readClock()
    expect(Math.abs(first.getTime() - Date.now())).toBeLessThan(2_000)
    await Bun.sleep(2_100)
    const second = await readClock()
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(1_000)
    expect((await state()).clockSets).toBe(0)
  }, 20_000)

  it('is moved by 3Dh, runs on from where it was set, and says how many times it was set', async () => {
    const ahead = new Date(Date.now() + 3_600_000)
    await setClock(ahead)
    const s = await state()
    expect(s.clockSets).toBe(1)
    expect(Math.abs(Date.parse(s.clock) - ahead.getTime())).toBeLessThan(3_000)
    await Bun.sleep(1_100)
    expect(Math.abs((await readClock()).getTime() - Date.now() - 3_600_000)).toBeLessThan(3_000)
  }, 20_000)

  it('reads this machine\'s time again after /reset, with no sets counted', async () => {
    await post('/reset', {})
    const s = await state()
    expect(s.clockSets).toBe(0)
    expect(Math.abs(Date.parse(s.clock) - Date.now())).toBeLessThan(2_000)
    expect(Math.abs((await readClock()).getTime() - Date.now())).toBeLessThan(2_000)
  }, 20_000)
})
