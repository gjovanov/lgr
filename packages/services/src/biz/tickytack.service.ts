import { config } from 'config'
import { logger } from '../logger/logger.js'

export interface TickyTackTimeEntry {
  id: string
  projectId: string
  ticketId?: string
  userId: string
  date: string
  startTime: string
  endTime: string
  durationMinutes: number
  description?: string
}

/**
 * Fetch time entries from TickyTack for a date range.
 */
export async function fetchTimeEntries(opts: {
  orgId: string
  startDate: string
  endDate: string
  userId?: string
  projectId?: string
}): Promise<TickyTackTimeEntry[]> {
  if (!config.externalIntegrations?.tickytack?.enabled) return []

  const params = new URLSearchParams({
    startDate: opts.startDate,
    endDate: opts.endDate,
  })
  if (opts.userId) params.set('userId', opts.userId)
  if (opts.projectId) params.set('projectId', opts.projectId)

  try {
    const resp = await fetch(
      `${config.externalIntegrations.tickytack.url}/api/org/${opts.orgId}/timeentry?${params}`,
      {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      },
    )
    if (!resp.ok) return []
    const data = await resp.json()
    return data.entries || data.timeEntries || []
  } catch (err: any) {
    logger.warn({ error: err.message }, 'TickyTack fetch failed')
    return []
  }
}

/**
 * Sync TickyTack time entries into LGR ProjectTimesheet.
 * TickyTack is source of truth — this is a one-directional pull.
 */
export async function syncTimesheets(
  orgId: string,
  startDate: string,
  endDate: string,
  repos?: any,
): Promise<{ created: number; updated: number }> {
  if (!config.externalIntegrations?.tickytack?.enabled) return { created: 0, updated: 0 }

  const { getRepos } = await import('../context.js')
  const r = repos ?? getRepos()

  const entries = await fetchTimeEntries({ orgId, startDate, endDate })
  let created = 0
  let updated = 0

  for (const entry of entries) {
    // Check if already synced by externalId
    const existing = await r.projectTimesheets.findOne({
      orgId,
      externalId: entry.id,
    } as any)

    const hours = entry.durationMinutes / 60
    const data = {
      orgId,
      employeeId: entry.userId,
      projectId: entry.projectId,
      taskId: entry.ticketId,
      date: new Date(entry.date),
      hours: Math.round(hours * 100) / 100,
      description: entry.description || `${entry.startTime}-${entry.endTime}`,
      unitAmount: 0,
      externalId: entry.id,
      externalSource: 'tickytack',
    }

    if (existing) {
      await r.projectTimesheets.update(existing.id, data as any)
      updated++
    } else {
      await r.projectTimesheets.create(data as any)
      created++
    }
  }

  logger.info({ orgId, created, updated, total: entries.length }, 'TickyTack timesheet sync complete')
  return { created, updated }
}
