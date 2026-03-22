import { config } from 'config'
import { logger } from '../logger/logger.js'

export interface RoomlerRoom {
  id: string
  name: string
  url: string
}

export async function createRoom(opts: {
  name: string
  orgId: string
  memberIds: string[]
  entityType: string
  entityId: string
}): Promise<RoomlerRoom | null> {
  if (!config.externalIntegrations?.roomler?.enabled) return null

  try {
    const resp = await fetch(`${config.externalIntegrations.roomler.url}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        tenant_id: opts.orgId,
        member_ids: opts.memberIds,
        metadata: { entity_type: opts.entityType, entity_id: opts.entityId },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Roomler room creation failed')
      return null
    }
    const data = await resp.json() as any
    return { id: data.id || data._id, name: data.name, url: data.url || `/rooms/${data.id}` }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Roomler service unreachable')
    return null
  }
}

export async function deleteRoom(roomId: string): Promise<void> {
  if (!config.externalIntegrations?.roomler?.enabled) return
  try {
    await fetch(`${config.externalIntegrations.roomler.url}/api/rooms/${roomId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}
