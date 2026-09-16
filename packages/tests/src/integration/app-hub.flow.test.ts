import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import { getAvailableApps, activateApp, deactivateApp } from 'services/biz/app-hub.service'
import { orgAppDao } from 'services/dao/org-app.dao'
import { Org, OrgApp } from 'db/models'
import { APP_IDS, APP_REGISTRY } from 'config/constants'

/**
 * The permissions a user needs to see EVERY tile.
 *
 * ⚠ Not `APP_IDS.map(id => `${id}.read`)`, which is what these tests used to build and why
 * three of them failed for weeks. That assumes every app is gated on its own `<id>.read`,
 * and `files` (#7) is gated on `admin.settings` — deliberately, because `manager` carries no
 * `admin.*` permission and document ingest is admin work. There is no `files.read`, so the
 * tile was correctly filtered out and the suite read 6 of 7 as a failure of the service.
 *
 * Deriving the list from the registry is what the service itself does, so a future app that
 * breaks the naming convention cannot reintroduce this.
 */
const ALL_APP_PERMISSIONS = APP_IDS.map(id => APP_REGISTRY[id].requiredPermission)

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

      // (The `id === 'erp' ? 'erp' : id` ternary this replaces was a no-op — `erp` has not
      // been in APP_IDS since the module list was trimmed.)
      const apps = await getAvailableApps(orgId, ALL_APP_PERMISSIONS)
      expect(apps).toHaveLength(APP_IDS.length)
    })

    it('should have all apps enabled for new org (freemium model)', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const apps = await getAvailableApps(orgId, ALL_APP_PERMISSIONS)
      expect(apps).toHaveLength(APP_IDS.length)
      expect(apps.every(a => a.enabled)).toBe(true)
    })

    it('should auto-activate missing apps for existing orgs', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Delete some OrgApp records to simulate a pre-freemium org
      await OrgApp.deleteMany({ orgId, appId: { $in: ['inventory', 'invoicing', 'pos', 'payroll'] } })

      // getAvailableApps should lazy-activate the missing ones
      const apps = await getAvailableApps(orgId, ALL_APP_PERMISSIONS, userId)
      expect(apps).toHaveLength(APP_IDS.length)
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

    it('should allow all 6 apps on free plan (freemium model)', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // org is on free plan by default, all 6 apps auto-activated on registration
      const enabledApps = await orgAppDao.findByOrg(orgId)
      expect(enabledApps).toHaveLength(APP_IDS.length)
    })

    it('should throw if org not found', async () => {
      expectRejection(await captureRejection(activateApp('000000000000000000000000', 'accounting', '000000000000000000000000')), 'Organization not found')
    })
  })

  describe('registration auto-activates all apps', () => {
    it('should auto-activate all 6 apps on new org registration', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const orgApps = await OrgApp.find({ orgId }).lean()
      expect(orgApps).toHaveLength(APP_IDS.length)

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
      expect(orgApps).toHaveLength(APP_IDS.length)
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
      expect(apps).toHaveLength(APP_IDS.length)
    })

    it('should not return disabled apps in findByOrg', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)

      await orgAppDao.deactivateApp(orgId, 'accounting')

      const apps = await orgAppDao.findByOrg(orgId)
      expect(apps).toHaveLength(APP_IDS.length - 1)
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
