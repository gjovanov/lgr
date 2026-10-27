import { describe, it, expect } from 'bun:test'
import { ALARM_AT, nodeAlarms } from 'services/biz/node/node-alarms'
import { sanitizeHealth } from 'services/biz/node/node.service'

/**
 * FR-20.101 (plan step P3-8): the alarms lgrai.app reads off a master, and the health fields it keeps
 * to read them from. Pure: no database.
 */

const NOW = new Date('2026-10-27T12:00:00Z')
const ago = (secs: number) => new Date(NOW.getTime() - secs * 1000)
const healthy = (over: Record<string, unknown> = {}) => ({
  at: ago(30),
  disk: { freeBytes: 500, totalBytes: 1000 },
  oplogWindowSecs: 30 * 86400,
  clockSkewSecs: 3,
  api: { lastBackupAt: ago(3600), fenced: 0, outboxQueued: 0 },
  ...over,
})
const kinds = (a: Array<{ kind: string }>) => a.map(x => x.kind).sort()
const up = { interactive: true, bulk: true }

describe('the alarms a master raises (FR-20.101)', () => {
  it('a healthy server raises none', () => {
    expect(nodeAlarms({ node: { health: healthy(), enrolledAt: ago(90 * 86400) }, connected: up, mirrors: [{ orgId: 'o1', watermark: 10, lastPageAt: ago(60) }], now: NOW })).toEqual([])
  })

  it('each threshold, just past it', () => {
    const h = healthy({
      disk: { freeBytes: 99, totalBytes: 1000 },
      oplogWindowSecs: ALARM_AT.oplogSecs - 1,
      clockSkewSecs: -(ALARM_AT.skewSecs + 1),
      api: { lastBackupAt: ago(ALARM_AT.backupSecs + 60), fenced: 2, outboxQueued: 5 },
    })
    const a = nodeAlarms({ node: { health: h }, connected: up, mirrors: [], now: NOW })
    expect(kinds(a)).toEqual(['backup_stale', 'clock_skew', 'disk_low', 'fenced', 'oplog_short'])
    expect(a.find(x => x.kind === 'disk_low')!.value).toBe(9.9)
    expect(a.find(x => x.kind === 'clock_skew')!.value).toBe(-(ALARM_AT.skewSecs + 1))
    expect(a.find(x => x.kind === 'fenced')!.value).toBe(2)
    // Just short of each: nothing.
    const fine = healthy({ disk: { freeBytes: 100, totalBytes: 1000 }, oplogWindowSecs: ALARM_AT.oplogSecs, clockSkewSecs: ALARM_AT.skewSecs, api: { lastBackupAt: ago(ALARM_AT.backupSecs - 60), fenced: 0 } })
    expect(nodeAlarms({ node: { health: fine }, connected: up, mirrors: [], now: NOW })).toEqual([])
  })

  it('an oplog that does not wrap yet sends no window, and raises nothing', () => {
    const { oplogWindowSecs: _, ...h } = healthy()
    expect(nodeAlarms({ node: { health: h }, connected: up, mirrors: [], now: NOW })).toEqual([])
  })

  it('a mirror lags only while the uplink is up, with journal unsent for over an hour', () => {
    const node = { health: healthy(), orgState: [{ orgId: 'o1', head: 120 }, { orgId: 'o2', head: 50 }] }
    const mirrors = [
      { orgId: 'o1', watermark: 100, lastPageAt: ago(ALARM_AT.lagSecs + 300) },
      // Caught up, however long ago its last page: nothing waits.
      { orgId: 'o2', watermark: 50, lastPageAt: ago(5 * 3600) },
    ]
    const a = nodeAlarms({ node, connected: up, mirrors, now: NOW })
    expect(a).toEqual([{ kind: 'mirror_lag', value: ALARM_AT.lagSecs + 300, orgId: 'o1' }])
    // The uplink down: that is the connection's to say, not the mirror's.
    expect(nodeAlarms({ node, connected: { interactive: true, bulk: false }, mirrors, now: NOW })).toEqual([])
    // Within the hour: none.
    expect(nodeAlarms({ node, connected: up, mirrors: [{ orgId: 'o1', watermark: 100, lastPageAt: ago(600) }], now: NOW })).toEqual([])
  })

  it('no backup at all: an alarm once the server has served its orgs a day and more, not on its first day', () => {
    const h = healthy({ api: { fenced: 0 } })
    const mirrors = [{ orgId: 'o1', watermark: 1, lastPageAt: ago(10) }]
    expect(nodeAlarms({ node: { health: h, enrolledAt: ago(3600) }, connected: up, mirrors, now: NOW })).toEqual([])
    expect(nodeAlarms({ node: { health: h, enrolledAt: ago(ALARM_AT.backupSecs + 3600) }, connected: up, mirrors, now: NOW })).toEqual([{ kind: 'backup_stale', value: null }])
    // A server that writes no org yet has nothing to back up.
    expect(nodeAlarms({ node: { health: h, enrolledAt: ago(30 * 86400) }, connected: up, mirrors: [], now: NOW })).toEqual([])
  })

  it('a health frame older than ten minutes says nothing about now', () => {
    const stale = healthy({ at: ago(ALARM_AT.healthFreshMs / 1000 + 60), disk: { freeBytes: 1, totalBytes: 1000 } })
    expect(nodeAlarms({ node: { health: stale }, connected: up, mirrors: [], now: NOW })).toEqual([])
  })
})

describe('what lgrai.app keeps of a health frame for them (P3-8)', () => {
  it('the disk\'s size, the oplog\'s reach, the last backup, fenced orgs, the outbox, and the clock as a skew', () => {
    const at = new Date('2026-10-27T12:00:00Z')
    const h: any = sanitizeHealth({
      disk: { freeBytes: 10, totalBytes: 100 },
      oplogWindowSecs: 86400,
      clock: '2026-10-27T12:03:30Z',
      api: { lastBackupAt: '2026-10-27T02:00:00Z', fenced: 1, outboxQueued: 4 },
    }, at)
    expect(h.disk).toEqual({ freeBytes: 10, totalBytes: 100 })
    expect(h.oplogWindowSecs).toBe(86400)
    expect(h.clockSkewSecs).toBe(210)
    expect(h.api.lastBackupAt).toEqual(new Date('2026-10-27T02:00:00Z'))
    expect([h.api.fenced, h.api.outboxQueued]).toEqual([1, 4])
  })

  it('nothing a master chose beyond the shapes: a backup in the future is now, a clock that is no time is nothing', () => {
    const at = new Date('2026-10-27T12:00:00Z')
    const h: any = sanitizeHealth({ clock: 'yesterday-ish', oplogWindowSecs: -5, disk: { totalBytes: 'big' }, api: { lastBackupAt: '2030-01-01T00:00:00Z', fenced: 'x' } }, at)
    expect(h.clockSkewSecs).toBeUndefined()
    expect(h.oplogWindowSecs).toBe(0)
    expect(h.disk.totalBytes).toBeUndefined()
    expect(h.api.lastBackupAt).toEqual(at)
    expect(h.api.fenced).toBeUndefined()
  })
})
