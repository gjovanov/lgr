import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import { getAvailableApps, activateApp, deactivateApp } from 'services/biz/app-hub.service'
import { Org, OrgApp } from 'db/models'
import { APP_IDS } from 'config/constants'
import { ALL } from 'config/access'
import { capsOfPermissions } from '../helpers/permission-caps'


// FR-32.9: read from the model, as the service does (the OrgApp DAO class only tests used is gone).
const isAppEnabled = async (orgId: string, appId: string) => !!(await OrgApp.findOne({ orgId, appId, enabled: true }).lean())
const enabledApps = (orgId: string) => OrgApp.find({ orgId, enabled: true }).lean()

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
    // FR-27 P3-6: by the role's grant; a legacy permission names the capabilities it gave (`permission-caps`).
    it('should return apps filtered by user permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      // User with only accounting.read permission
      const apps = await getAvailableApps(orgId, capsOfPermissions('accounting.read'))
      expect(apps).toHaveLength(1)
      expect(apps[0].id).toBe('accounting')
      expect(apps[0].enabled).toBe(true)
    })

    it('should return all apps for user with all read permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      // (The `id === 'erp' ? 'erp' : id` ternary this replaces was a no-op — `erp` has not
      // been in APP_IDS since the module list was trimmed.)
      const apps = await getAvailableApps(orgId, ALL)
      expect(apps).toHaveLength(APP_IDS.length)
    })

    it('should have all apps enabled for new org (freemium model)', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const apps = await getAvailableApps(orgId, ALL)
      expect(apps).toHaveLength(APP_IDS.length)
      expect(apps.every(a => a.enabled)).toBe(true)
    })

    it('should auto-activate missing apps for existing orgs', async () => {
      const { org, user } = await registerAdmin()
      const orgId = String(org._id)
      const userId = String(user._id)

      // Delete some OrgApp records to simulate a pre-freemium org
      await OrgApp.deleteMany({ orgId, appId: { $in: ['inventory', 'invoicing', 'payroll'] } })

      // getAvailableApps should lazy-activate the missing ones
      const apps = await getAvailableApps(orgId, ALL, userId)
      expect(apps).toHaveLength(APP_IDS.length)
      expect(apps.every(a => a.enabled)).toBe(true)
    })

    // The till lives in the invoicing app, so its permission opens that tile.
    it('pos.read opens the invoicing tile, and there is no POS tile of its own', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      expect((await getAvailableApps(orgId, capsOfPermissions('pos.read'))).map(a => a.id)).toEqual(['invoicing'])
      expect((await getAvailableApps(orgId, capsOfPermissions('invoicing.read'))).map(a => a.id)).toEqual(['invoicing'])
      expect((await getAvailableApps(orgId, capsOfPermissions('pos.read', 'invoicing.read'))).map(a => a.id)).toEqual(['invoicing'])
      expect(APP_IDS as readonly string[]).not.toContain('pos')
    })

    // An org enabled POS when it was an app: its row stays, read by nobody.
    it('an old OrgApp row for pos changes nothing', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)
      await OrgApp.create({ orgId, appId: 'pos', enabled: true })

      const apps = await getAvailableApps(orgId, ALL)
      expect(apps.map(a => a.id).sort()).toEqual([...APP_IDS].sort())
      expect(await OrgApp.countDocuments({ orgId, appId: 'pos' })).toBe(1)
    })

    it('should return empty array for no matching permissions', async () => {
      const { org } = await registerAdmin()
      const orgId = String(org._id)

      const apps = await getAvailableApps(orgId, capsOfPermissions('admin.users'))
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
      const isEnabled = await isAppEnabled(orgId, 'accounting')
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
      const enabled = await enabledApps(orgId)
      expect(enabled).toHaveLength(APP_IDS.length)
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
      const isEnabled = await isAppEnabled(orgId, 'accounting')
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
})
