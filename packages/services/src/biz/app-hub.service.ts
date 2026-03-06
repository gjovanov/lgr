import type { RepositoryRegistry } from 'dal'
import { APP_REGISTRY, APP_IDS, type AppId } from 'config/constants'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export interface AppInfo {
  id: AppId
  name: string
  icon: string
  color: string
  port: number
  uiPort: number
  description: string
  enabled: boolean
}

export async function getAvailableApps(orgId: string, userPermissions: string[], userId?: string, repos?: RepositoryRegistry): Promise<AppInfo[]> {
  const r = repos ?? getRepos()

  let enabledApps = await r.orgApps.findMany({ orgId })
  const existingAppIds = enabledApps.map(a => (a as any).appId)
  const missingAppIds = APP_IDS.filter(id => !existingAppIds.includes(id))

  // Lazy auto-activate missing apps for existing orgs (freemium model)
  if (missingAppIds.length > 0) {
    await Promise.all(
      missingAppIds.map(appId =>
        r.orgApps.create({
          orgId,
          appId,
          enabled: true,
          activatedAt: new Date(),
          activatedBy: userId || 'system',
        } as any),
      ),
    )
    enabledApps = await r.orgApps.findMany({ orgId })
  }

  const enabledAppIds = new Set(enabledApps.map(a => (a as any).appId))

  return APP_IDS
    .filter(appId => {
      const reg = APP_REGISTRY[appId]
      return userPermissions.includes(reg.requiredPermission)
    })
    .map(appId => ({
      id: appId,
      ...APP_REGISTRY[appId],
      enabled: enabledAppIds.has(appId),
    }))
}

export async function activateApp(orgId: string, appId: AppId, userId: string, repos?: RepositoryRegistry): Promise<AppInfo> {
  const r = repos ?? getRepos()
  const org = await r.orgs.findById(orgId)
  if (!org) throw new Error('Organization not found')

  const existing = await r.orgApps.findOne({ orgId, appId } as any)
  if (existing && (existing as any).enabled) {
    return { id: appId, ...APP_REGISTRY[appId], enabled: true }
  }

  if (existing) {
    await r.orgApps.update(existing.id, { enabled: true, activatedAt: new Date(), activatedBy: userId } as any)
  } else {
    await r.orgApps.create({
      orgId,
      appId,
      enabled: true,
      activatedAt: new Date(),
      activatedBy: userId,
    } as any)
  }
  logger.info({ orgId, appId, userId }, 'App activated')

  return { id: appId, ...APP_REGISTRY[appId], enabled: true }
}

export async function deactivateApp(orgId: string, appId: AppId, repos?: RepositoryRegistry): Promise<AppInfo> {
  const r = repos ?? getRepos()
  const existing = await r.orgApps.findOne({ orgId, appId } as any)
  if (existing) {
    await r.orgApps.update(existing.id, { enabled: false } as any)
  }
  logger.info({ orgId, appId }, 'App deactivated')

  return { id: appId, ...APP_REGISTRY[appId], enabled: false }
}
