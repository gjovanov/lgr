import { describe, it, expect } from 'bun:test'
import { readTremolClock, tremolClock } from 'fiscal/tremol'
import { formatDatecsDate, formatDatecsDateTime, parseDatecsDateTime } from 'fiscal/datecs'

/**
 * A Tremol's and a Datecs's clock are Bulgarian time, whatever zone the process runs in. They were read and written
 * with the process's own getters, and the pod runs in UTC: a correct device read that way looked 2 h ahead, and a
 * person who confirmed the step on the device page set it 2 h behind. A storno cited its receipt's time and a
 * fiscal-memory report its days by the same getters.
 *
 * These instants are fixed in UTC, so the expectations hold in any `TZ`. Run the suite with `TZ=UTC` (as the pod)
 * and with `TZ=Europe/Sofia` (as a developer machine there, which is why it went unnoticed): both must pass.
 */

describe('Tremol: DD-MM-YY;HH:MM:SS in Bulgarian time', () => {
  it('writes the wall clock of Sofia, in winter (UTC+2) and in summer (UTC+3)', () => {
    expect(tremolClock(new Date('2026-11-04T12:00:00Z'))).toBe('04-11-26;14:00:00')
    expect(tremolClock(new Date('2026-07-15T09:30:05Z'))).toBe('15-07-26;12:30:05')
  })

  it('reads a reading as the instant it names', () => {
    expect(readTremolClock('04-11-26;14:00:00').toISOString()).toBe('2026-11-04T12:00:00.000Z')
    expect(readTremolClock('15-07-26;12:30:05').toISOString()).toBe('2026-07-15T09:30:05.000Z')
  })

  it('a reading written by LGR reads back as the same instant, on both sides of the night summer time ends', () => {
    // 03:00–04:00 in Sofia happens twice that night: a wall clock cannot say which, so those are left out.
    for (const at of ['2026-10-24T23:30:00Z', '2026-10-25T02:30:00Z', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z']) {
      const now = new Date(at)
      expect(readTremolClock(tremolClock(now)).toISOString()).toBe(now.toISOString())
    }
  })

  it('a garbled answer is an error, never a date in 2000', () => {
    for (const bad of ['', 'F', '04-11-26', '32-11-26;14:00:00']) {
      expect(() => readTremolClock(bad)).toThrow(/Tremol clock/)
    }
  })
})

describe('Datecs: DD-MM-YY HH:MM:SS in Bulgarian time', () => {
  it('writes and reads Sofia\'s wall clock', () => {
    expect(formatDatecsDateTime(new Date('2026-11-04T12:00:00Z'))).toBe('04-11-26 14:00:00')
    expect(parseDatecsDateTime('04-11-26 14:00:00').toISOString()).toBe('2026-11-04T12:00:00.000Z')
  })

  it('the day a storno cites is Sofia\'s: after midnight there it is still the day before in UTC', () => {
    expect(formatDatecsDate(new Date('2026-11-04T23:30:00Z'))).toBe('05-11-26')
  })

  it('a garbled answer is an error', () => {
    expect(() => parseDatecsDateTime('?')).toThrow(/Datecs clock/)
  })
})
