/**
 * FR-20.20, #952: a master's update in one line, the same on the Servers page, the sys-admin Nodes page and the
 * server's own status page: what installs, what waits and why (with the alarm after seven nights kept out by open
 * tills), and an update whose last attempt failed, with its error and its next try.
 */
import type { useI18n } from 'vue-i18n'
import { formatDateTime } from 'ui-shared/format'

export interface UpdateHealth {
  state?: string | null
  available?: string | null
  reason?: string | null
  blockedWindows?: number | null
  alarm?: boolean | null
  /** #952: the helper's last attempt failed (`failing`): what it said, and when it is tried again. */
  error?: string | null
  nextTryAt?: string | null
}

type Translate = ReturnType<typeof useI18n>['t']

/** The line, or '' when there is nothing to say here (up to date, or a state this page does not know). */
export function updateLine(u: UpdateHealth | null | undefined, t: Translate): string {
  if (u?.state === 'installing') return t('servers.updateInstalling', { version: u.available })
  if (u?.state === 'deferred') {
    const waits = t('servers.updateWaits', { version: u.available, reason: u.reason ?? '' })
    return u.alarm ? `${waits} · ${t('servers.updateAlarm', { n: u.blockedWindows ?? 0 })}` : waits
  }
  if (u?.state === 'failing') {
    const failing = t('servers.updateFailing', { version: u.available, error: u.error ?? '' })
    // Outside the window, or kept by tills: the next try, or why there is none to give.
    const next = u.nextTryAt ? t('servers.updateNextTry', { when: formatDateTime(u.nextTryAt) }) : u.reason
    return next ? `${failing} · ${next}` : failing
  }
  return ''
}

/** Said in red: kept out by open tills for seven nights, or failing. */
export const updateAlarmed = (u: UpdateHealth | null | undefined) => u?.state === 'failing' || (u?.state === 'deferred' && !!u.alarm)
