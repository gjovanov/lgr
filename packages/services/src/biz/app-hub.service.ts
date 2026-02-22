import { Org } from 'db/models'
import { APP_REGISTRY, APP_IDS, type AppId } from 'config/constants'
import { orgAppDao } from '../dao/org-app.dao.js'
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

export async function getAvailableApps(orgId: string, userPermissions: string[], userId?: string): Promise<AppInfo[]> {
  let enabledApps = await orgAppDao.findByOrg(orgId)
  const existingAppIds = enabledApps.map(a => a.appId)
  const missingAppIds = APP_IDS.filter(id => !existingAppIds.includes(id))

  // Lazy auto-activate missing apps for existing orgs (freemium model)
  if (missingAppIds.length > 0) {
    await Promise.all(
      missingAppIds.map(appId =>
        orgAppDao.activateApp(orgId, appId, userId || 'system'),
      ),
    )
    enabledApps = await orgAppDao.findByOrg(orgId)
  }

  const enabledAppIds = new Set(enabledApps.map(a => a.appId))

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

export async function activateApp(orgId: string, appId: AppId, userId: string): Promise<AppInfo> {
  const org = await Org.findById(orgId)
  if (!org) throw new Error('Organization not found')

  const currentlyEnabled = await orgAppDao.findByOrg(orgId)
  const alreadyEnabled = currentlyEnabled.find(a => a.appId === appId)
  if (alreadyEnabled) {
    return { id: appId, ...APP_REGISTRY[appId], enabled: true }
  }

  await orgAppDao.activateApp(orgId, appId, userId)
  logger.info({ orgId, appId, userId }, 'App activated')

  return { id: appId, ...APP_REGISTRY[appId], enabled: true }
}

export async function deactivateApp(orgId: string, appId: AppId): Promise<AppInfo> {
  await orgAppDao.deactivateApp(orgId, appId)
  logger.info({ orgId, appId }, 'App deactivated')

  return { id: appId, ...APP_REGISTRY[appId], enabled: false }
}
