import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import { getAvailableApps, activateApp, deactivateApp } from 'services/biz/app-hub.service'
import { orgAppDao } from 'services/dao/org-app.dao'
import { Org, OrgApp } from 'db/models'
import { APP_IDS, PLAN_APP_LIMITS } from 'config/constants'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('App Hub Flow', () => {
  async function registerAdmin() {
    return register({
      orgName: 'Test Corp',
      orgSlug: 'test-corp',
      email: 'admin@test.com',
      username: 'admin',
      password: 'secure123',
      firstName: 'Admin',
      lastName: 'User',
    })
  }

  describe('getAvailableApps', () => {
    it('should return apps filtered by user permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      // User with only accounting.read permission
      const apps = await getAvailableApps(orgId, ['accounting.read'])
      expect(apps).toHaveLength(1)
      expect(apps[0].id).toBe('accounting')
      expect(apps[0].enabled).toBe(false)
    })

    it('should return all apps for user with all read permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const allReadPerms = APP_IDS.map(id => `${id === 'erp' ? 'erp' : id}.read`)
      const apps = await getAvailableApps(orgId, allReadPerms)
      expect(apps).toHaveLength(7)
    })

    it('should mark enabled apps correctly', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await orgAppDao.activateApp(orgId, 'accounting', userId)

      const apps = await getAvailableApps(orgId, ['accounting.read', 'invoicing.read'])
      const accounting = apps.find(a => a.id === 'accounting')
      const invoicing = apps.find(a => a.id === 'invoicing')

      expect(accounting?.enabled).toBe(true)
      expect(invoicing?.enabled).toBe(false)
    })

    it('should return empty array for no matching permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const apps = await getAvailableApps(orgId, ['admin.users'])
      expect(apps).toHaveLength(0)
    })
  })

  describe('activateApp', () => {
    it('should activate an app for an org', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      const result = await activateApp(orgId, 'accounting', userId)
      expect(result.id).toBe('accounting')
      expect(result.enabled).toBe(true)
      expect(result.name).toBe('Accounting')

      // Verify in DB
      const isEnabled = await orgAppDao.isAppEnabled(orgId, 'accounting')
      expect(isEnabled).toBe(true)
    })

    it('should return existing app if already activated', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await activateApp(orgId, 'accounting', userId)
      const result = await activateApp(orgId, 'accounting', userId)
      expect(result.id).toBe('accounting')
      expect(result.enabled).toBe(true)

      // Should not duplicate
      const enabledApps = await orgAppDao.findByOrg(orgId)
      expect(enabledApps).toHaveLength(1)
    })

    it('should enforce plan limits on free plan', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Free plan allows 2 apps
      await activateApp(orgId, 'accounting', userId)
      await activateApp(orgId, 'invoicing', userId)

      // Third app should fail
      await expect(
        activateApp(orgId, 'warehouse', userId),
      ).rejects.toThrow('maximum of 2 apps')
    })

    it('should allow more apps on higher plans', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Upgrade to starter plan
      await Org.findByIdAndUpdate(orgId, {
        $set: { 'subscription.plan': 'starter' },
      })

      // Starter allows 4 apps
      await activateApp(orgId, 'accounting', userId)
      await activateApp(orgId, 'invoicing', userId)
      await activateApp(orgId, 'warehouse', userId)
      await activateApp(orgId, 'payroll', userId)

      // Fifth app should fail on starter
      await expect(
        activateApp(orgId, 'hr', userId),
      ).rejects.toThrow('maximum of 4 apps')
    })

    it('should throw if org not found', async () => {
      await expect(
        activateApp('000000000000000000000000', 'accounting', '000000000000000000000000'),
      ).rejects.toThrow('Organization not found')
    })
  })

  describe('deactivateApp', () => {
    it('should deactivate an app', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await activateApp(orgId, 'accounting', userId)
      const result = await deactivateApp(orgId, 'accounting')

      expect(result.id).toBe('accounting')
      expect(result.enabled).toBe(false)

      // Verify in DB
      const isEnabled = await orgAppDao.isAppEnabled(orgId, 'accounting')
      expect(isEnabled).toBe(false)
    })

    it('should allow re-activation after deactivation', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await activateApp(orgId, 'accounting', userId)
      await deactivateApp(orgId, 'accounting')

      const result = await activateApp(orgId, 'accounting', userId)
      expect(result.enabled).toBe(true)
    })

    it('should free up plan slot after deactivation', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Activate 2 (free plan limit)
      await activateApp(orgId, 'accounting', userId)
      await activateApp(orgId, 'invoicing', userId)

      // Deactivate one
      await deactivateApp(orgId, 'accounting')

      // Should now allow a new app
      const result = await activateApp(orgId, 'warehouse', userId)
      expect(result.enabled).toBe(true)
    })
  })

  describe('OrgApp DAO', () => {
    it('should find enabled apps by org', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await orgAppDao.activateApp(orgId, 'accounting', userId)
      await orgAppDao.activateApp(orgId, 'invoicing', userId)

      const apps = await orgAppDao.findByOrg(orgId)
      expect(apps).toHaveLength(2)
    })

    it('should not return disabled apps in findByOrg', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await orgAppDao.activateApp(orgId, 'accounting', userId)
      await orgAppDao.deactivateApp(orgId, 'accounting')

      const apps = await orgAppDao.findByOrg(orgId)
      expect(apps).toHaveLength(0)
    })

    it('should find by org and app', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      await orgAppDao.activateApp(orgId, 'accounting', userId)

      const found = await orgAppDao.findByOrgAndApp(orgId, 'accounting')
      expect(found).not.toBeNull()
      expect(found!.appId).toBe('accounting')
    })

    it('should return null for non-existent org-app combo', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const found = await orgAppDao.findByOrgAndApp(orgId, 'accounting')
      expect(found).toBeNull()
    })

    it('should check if app is enabled', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      expect(await orgAppDao.isAppEnabled(orgId, 'accounting')).toBe(false)

      await orgAppDao.activateApp(orgId, 'accounting', userId)
      expect(await orgAppDao.isAppEnabled(orgId, 'accounting')).toBe(true)

      await orgAppDao.deactivateApp(orgId, 'accounting')
      expect(await orgAppDao.isAppEnabled(orgId, 'accounting')).toBe(false)
    })
  })
})
