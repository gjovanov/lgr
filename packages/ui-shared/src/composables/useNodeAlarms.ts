/**
 * FR-20.101 (plan step P3-8): a master's alarms as both pages say them, the Servers page of an org
 * and the sys-admin Nodes page. A duration in the viewer's language through `Intl`, never hand-made
 * units.
 */
import { useI18n } from 'vue-i18n'

export interface NodeAlarm {
  kind: 'mirror_lag' | 'backup_stale' | 'disk_low' | 'oplog_short' | 'fenced' | 'clock_skew' | 'supto_waiting'
  value: number | null
  orgId?: string
  /** The SUPTO version an update waits for (`supto_waiting`). */
  detail?: string
}

export function useNodeAlarms() {
  const { t, locale } = useI18n()
  /** Seconds as the largest whole unit: 75 min, 26 h, 3 days. */
  function duration(secs: number): string {
    const s = Math.abs(secs)
    const [n, unit] = s >= 2 * 86400 ? [Math.round(s / 86400), 'day'] : s >= 2 * 3600 ? [Math.round(s / 3600), 'hour'] : s >= 120 ? [Math.round(s / 60), 'minute'] : [Math.round(s), 'second']
    return new Intl.NumberFormat(locale.value, { style: 'unit', unit, unitDisplay: 'long' }).format(n)
  }
  function alarmText(a: NodeAlarm): string {
    if (a.kind === 'backup_stale' && a.value === null) return t('servers.alarm.backup_none')
    if (a.kind === 'disk_low') return t('servers.alarm.disk_low', { pct: a.value })
    if (a.kind === 'fenced') return t('servers.alarm.fenced', { n: a.value })
    if (a.kind === 'supto_waiting') return t('servers.alarm.supto_waiting', { version: a.detail ?? '?' })
    return t(`servers.alarm.${a.kind}`, { age: duration(a.value ?? 0) })
  }
  return { alarmText, duration }
}
