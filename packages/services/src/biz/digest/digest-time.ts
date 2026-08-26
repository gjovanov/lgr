/**
 * FR-11.5 (#21) — the digest's calendar arithmetic, in its own import-pure module.
 *
 * Separate from the service because the service touches Mongo and this is the part worth
 * table-testing (DST, midnight, zones) — the same split as `report-registry.types.ts`.
 *
 * `Org.settings.timezone` has existed since the beginning and was read by NOTHING until this
 * feature. Everything here is therefore written defensively: an org with a missing or invalid
 * zone must not take the scheduler down for every other org.
 */

/** The org's wall clock: its local calendar date and hour, right now. */
export function orgLocalParts(now: Date, timezone: string | undefined): { date: string; hour: number } {
  const parts = formatParts(now, timezone) ?? formatParts(now, 'UTC')!
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  // `hour12: false` renders midnight as "24" in some ICU versions — normalise it.
  const hour = Number(get('hour')) % 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour }
}

function formatParts(now: Date, timeZone: string | undefined): Intl.DateTimeFormatPart[] | null {
  if (!timeZone) return null
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(now)
  } catch {
    return null
  }
}

/**
 * The day a digest sent on `localDate` reports on: the day before, by calendar.
 *
 * Uses UTC arithmetic on a date-only value on purpose — the string carries no zone, and
 * doing this in local time would shift the result for anyone east or west of the server.
 */
export function previousLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

/**
 * Has this org's send hour arrived on its own clock?
 *
 * `>=` rather than `===` is what makes the digest catch up: a server that was down at 07:00
 * still sends when it comes back at 11:00, and the run document — not the clock — is what
 * stops a second send.
 */
export function digestHourReached(localHour: number, configuredHour: number | undefined): boolean {
  const wanted = Number.isFinite(configuredHour as number) ? Number(configuredHour) : 7
  return localHour >= Math.min(23, Math.max(0, wanted))
}
