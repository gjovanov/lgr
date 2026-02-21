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
      expect(apps[0].enabled).toBe(true)
    })

    it('should return all apps for user with all read permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const allReadPerms = APP_IDS.map(id => `${id === 'erp' ? 'erp' : id}.read`)
      const apps = await getAvailableApps(orgId, allReadPerms)
      expect(apps).toHaveLength(7)
    })

    it('should have all apps enabled for new org (freemium model)', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const allReadPerms = APP_IDS.map(id => `${id}.read`)
      const apps = await getAvailableApps(orgId, allReadPerms)
      expect(apps).toHaveLength(7)
      expect(apps.every(a => a.enabled)).toBe(true)
    })

    it('should auto-activate missing apps for existing orgs', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Delete some OrgApp records to simulate a pre-freemium org
      await OrgApp.deleteMany({ orgId, appId: { $in: ['warehouse', 'payroll', 'hr', 'crm', 'erp'] } })

      // getAvailableApps should lazy-activate the missing ones
      const allReadPerms = APP_IDS.map(id => `${id}.read`)
      const apps = await getAvailableApps(orgId, allReadPerms, userId)
      expect(apps).toHaveLength(7)
      expect(apps.every(a => a.enabled)).toBe(true)
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

      // Deactivate first so we can test activation
      await deactivateApp(orgId, 'accounting')

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

      // accounting is already activated via registration
      const result = await activateApp(orgId, 'accounting', userId)
      expect(result.id).toBe('accounting')
      expect(result.enabled).toBe(true)
    })

    it('should allow all 7 apps on free plan (freemium model)', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // org is on free plan by default, all 7 apps auto-activated on registration
      const enabledApps = await orgAppDao.findByOrg(orgId)
      expect(enabledApps).toHaveLength(7)
    })

    it('should throw if org not found', async () => {
      await expect(
        activateApp('000000000000000000000000', 'accounting', '000000000000000000000000'),
      ).rejects.toThrow('Organization not found')
    })
  })

  describe('registration auto-activates all apps', () => {
    it('should auto-activate all 7 apps on new org registration', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const orgApps = await OrgApp.find({ orgId }).lean()
      expect(orgApps).toHaveLength(7)

      const appIds = orgApps.map(a => a.appId).sort()
      expect(appIds).toEqual([...APP_IDS].sort())
      expect(orgApps.every(a => a.enabled)).toBe(true)
    })

    it('should NOT auto-activate apps on invite-based registration', async () => {
      // Invite-based registration joins an existing org, should not create OrgApp records
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      // The org already has 7 apps from the admin registration
      const orgApps = await OrgApp.find({ orgId }).lean()
      expect(orgApps).toHaveLength(7)
    })
  })

  describe('deactivateApp', () => {
    it('should deactivate an app', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

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

      await deactivateApp(orgId, 'accounting')

      const result = await activateApp(orgId, 'accounting', userId)
      expect(result.enabled).toBe(true)
    })
  })

  describe('OrgApp DAO', () => {
    it('should find enabled apps by org', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

      // All 7 apps auto-activated on registration
      const apps = await orgAppDao.findByOrg(orgId)
      expect(apps).toHaveLength(7)
    })

    it('should not return disabled apps in findByOrg', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

      await orgAppDao.deactivateApp(orgId, 'accounting')

      const apps = await orgAppDao.findByOrg(orgId)
      expect(apps).toHaveLength(6)
    })

    it('should find by org and app', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

      const found = await orgAppDao.findByOrgAndApp(orgId, 'accounting')
      expect(found).not.toBeNull()
      expect(found!.appId).toBe('accounting')
    })

    it('should check if app is enabled', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

      // Auto-activated on registration
      expect(await orgAppDao.isAppEnabled(orgId, 'accounting')).toBe(true)

      await orgAppDao.deactivateApp(orgId, 'accounting')
      expect(await orgAppDao.isAppEnabled(orgId, 'accounting')).toBe(false)
    })
  })
})
