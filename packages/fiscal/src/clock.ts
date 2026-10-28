/**
 * Is the server's clock right? (FR-20.22, plan step P1-10.)
 *
 * The fiscal devices get their time from the server, and a device writes that time into its fiscal
 * records. A shop PC whose clock reset after a power cut would otherwise write a wrong date there,
 * and a fiscal record cannot be corrected.
 *
 * The server's clock is checked against time sources reached over HTTPS, through whatever proxy the
 * process is given (a master's egress, FR-20.53):
 * - Cloudflare's trace endpoint, which states its time to the millisecond;
 * - Google's `Date` header, to the second.
 * Each is read at the midpoint of its round trip, and the answer carries its own precision.
 *
 * ⚠ A check that reaches no source says *unknown*, never drift 0. The previous check asked
 * worldtimeapi.org over plain HTTP, reported 0 on any failure, and that host stopped answering
 * (ECONNRESET from the cluster and from mars, 2026-10-25): every check "passed".
 */

export interface ClockVerification {
  at: Date
  /** Positive when this server's clock is ahead. */
  driftMs: number
  source: string
  /** How exactly the source states time, plus half the round trip. */
  precisionMs: number
}

export type ClockCheck = ({ state: 'verified' } & ClockVerification) | { state: 'unknown'; at: Date; reason: string }

interface TimeSource {
  name: string
  url: string
  precisionMs: number
  /** The source's time in milliseconds, or `null` when its answer says none. */
  read: (res: Response) => Promise<number | null>
}

const dateHeader = async (res: Response) => {
  const d = res.headers.get('date')
  const ms = d ? Date.parse(d) : NaN
  return Number.isFinite(ms) ? ms : null
}

export const TIME_SOURCES: readonly TimeSource[] = [
  {
    name: 'cloudflare',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    precisionMs: 1,
    read: async res => {
      const m = /^ts=(\d+(?:\.\d+)?)$/m.exec(await res.text())
      return m ? Math.round(Number(m[1]) * 1000) : null
    },
  },
  { name: 'google', url: 'https://www.google.com/generate_204', precisionMs: 1000, read: dateHeader },
]

/** A clock is trusted to set a device for this long after it was verified (FR-20.22). */
export const VERIFIED_FOR_MS = 24 * 60 * 60 * 1000
/** The largest step pushed without a person: the server's own drift, and a device's correction. */
export const MAX_STEP_MS = 2 * 60 * 1000

/**
 * The last verification, with the monotonic time it was made at. ⚠ Its age is measured on the
 * monotonic clock: a wall clock that jumped back after a verification would otherwise still look
 * "verified within 24 h".
 */
let last: (ClockVerification & { mono: number }) | undefined

export interface ClockDeps {
  fetch: typeof fetch
  now: () => number
  /** Monotonic milliseconds: `performance.now()`. */
  mono: () => number
  sources: readonly TimeSource[]
}

/** Check the clock against the first source that answers. Remembers a verification. */
export async function verifyClock(over: Partial<ClockDeps> = {}): Promise<ClockCheck> {
  const d: ClockDeps = { fetch, now: Date.now, mono: () => performance.now(), sources: TIME_SOURCES, ...over }
  const failures: string[] = []
  for (const source of d.sources) {
    try {
      const t0 = d.now()
      const res = await d.fetch(source.url, { signal: AbortSignal.timeout(5000), headers: { 'cache-control': 'no-cache' } })
      const t1 = d.now()
      const remote = await source.read(res)
      if (remote === null) {
        failures.push(`${source.name}: no time in the answer`)
        continue
      }
      const verification: ClockVerification = {
        at: new Date(t1),
        driftMs: Math.round((t0 + t1) / 2 - remote),
        source: source.name,
        precisionMs: source.precisionMs + Math.round((t1 - t0) / 2),
      }
      last = { ...verification, mono: d.mono() }
      return { state: 'verified', ...verification }
    } catch (e: any) {
      failures.push(`${source.name}: ${e?.code ?? e?.name ?? 'error'}`)
    }
  }
  return { state: 'unknown', at: new Date(d.now()), reason: `no time source answered (${failures.join('; ')})` }
}

/** The last verification, if any. */
export function lastClockVerification(): ClockVerification | undefined {
  if (!last) return undefined
  const { mono: _, ...verification } = last
  return verification
}

/**
 * Whether the server's clock may set a fiscal device without a person (FR-20.22): verified within
 * 24 h, off by no more than 2 minutes then, and not jumped since.
 */
export function clockTrusted(
  over: { now?: number; mono?: number } = {},
): { ok: true; verification: ClockVerification } | { ok: false; reason: string } {
  const now = over.now ?? Date.now()
  const mono = over.mono ?? performance.now()
  if (!last) return { ok: false, reason: 'the server clock has not been verified since it started' }
  const age = mono - last.mono
  if (age > VERIFIED_FOR_MS) return { ok: false, reason: 'the server clock has not been verified for over 24 hours' }
  if (Math.abs(last.driftMs) > MAX_STEP_MS) {
    return { ok: false, reason: `the server clock is off by ${formatStep(last.driftMs)} (${last.source})` }
  }
  // The wall clock must have moved as the monotonic one did: otherwise it was set since.
  const jumped = now - last.at.getTime() - age
  if (Math.abs(jumped) > MAX_STEP_MS) {
    return { ok: false, reason: `the server clock has moved by ${formatStep(jumped)} since it was verified` }
  }
  return { ok: true, verification: lastClockVerification()! }
}

/** `+3 d 0 h`, `-2 min 5 s`, `+800 ms`: a step, for people. */
export function formatStep(ms: number): string {
  const sign = ms < 0 ? '-' : '+'
  let a = Math.abs(Math.round(ms))
  if (a < 1000) return `${sign}${a} ms`
  const parts: string[] = []
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['min', 60_000], ['s', 1000]] as const) {
    if (a >= size || parts.length) {
      parts.push(`${Math.floor(a / size)} ${unit}`)
      a %= size
    }
    if (parts.length === 2) break
  }
  return sign + parts.join(' ')
}

/** Tests only. */
export function forgetClockVerification(): void {
  last = undefined
}
