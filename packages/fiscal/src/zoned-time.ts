/**
 * Wall-clock conversion for fiscal devices.
 *
 * A Bulgarian fiscal device keeps Bulgarian local time, but the API runs in a container
 * whose clock is UTC — so `date.getHours()` (what the older drivers use) would set the
 * device three hours behind in summer. Everything a device is told or reports goes through
 * these two functions instead, in an explicit zone.
 *
 * Import-pure; same `Intl` approach and the same midnight-as-"24" guard as
 * `services/biz/digest/digest-time.ts`.
 */

export const FISCAL_TIME_ZONE = 'Europe/Sofia'

export interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall clock in `timeZone` at instant `date`. */
export function zonedParts(date: Date, timeZone: string = FISCAL_TIME_ZONE): WallClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24, // some ICU builds render midnight as "24"
    minute: get('minute'),
    second: get('second'),
  }
}

/**
 * The instant at which `timeZone` shows wall clock `w`.
 *
 * Two correction passes settle DST transitions; for the one ambiguous autumn hour it picks
 * the first occurrence, which is all a receipt timestamp needs.
 */
export function zonedToUtc(w: WallClock, timeZone: string = FISCAL_TIME_ZONE): Date {
  const target = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  let t = target
  for (let pass = 0; pass < 2; pass++) {
    const p = zonedParts(new Date(t), timeZone)
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    t += target - shown
  }
  return new Date(t)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** "DD-MM-YY HH:MM:SS" — the clock format of the ISL set/read date-time commands. */
export function formatDeviceDateTime(date: Date, timeZone: string = FISCAL_TIME_ZONE): string {
  const w = zonedParts(date, timeZone)
  return `${pad(w.day)}-${pad(w.month)}-${pad(w.year % 100)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`
}

/** "DDMMYY" — the period arguments of the fiscal-memory reports. */
export function formatDeviceDate(date: Date, timeZone: string = FISCAL_TIME_ZONE): string {
  const w = zonedParts(date, timeZone)
  return `${pad(w.day)}${pad(w.month)}${pad(w.year % 100)}`
}

/** "YYYY-MM-DDTHH:mm:ss" — how an Eltrade storno names the receipt it reverses. */
export function formatDeviceIsoDateTime(date: Date, timeZone: string = FISCAL_TIME_ZONE): string {
  const w = zonedParts(date, timeZone)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`
}

/**
 * Parse a device clock reading ("DD-MM-YY HH:MM:SS", also with dots) as local time in
 * `timeZone`. Returns null for anything else — a garbled answer must not become a date.
 */
export function parseDeviceDateTime(text: string, timeZone: string = FISCAL_TIME_ZONE): Date | null {
  const m = /^\s*(\d{1,2})[-.](\d{1,2})[-.](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!m) return null
  const yy = Number(m[3])
  const w: WallClock = {
    day: Number(m[1]),
    month: Number(m[2]),
    year: yy < 100 ? 2000 + yy : yy,
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] || 0),
  }
  if (w.month < 1 || w.month > 12 || w.day < 1 || w.day > 31 || w.hour > 23 || w.minute > 59 || w.second > 59) return null
  return zonedToUtc(w, timeZone)
}
