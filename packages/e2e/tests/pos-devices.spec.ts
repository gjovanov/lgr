import { test, expect } from '@playwright/test'
import { appears } from './helpers/vuetify'
import { loginForApp } from './helpers/login'
import { apiDelete, apiLogin, apiPost } from './helpers/api'

const API = process.env.BASE_URL || 'http://localhost:4001'

test.describe('Devices', () => {
  test('should navigate to the Devices page and verify heading renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
  })

  test('should verify "New Device" button is present', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('link', { name: /New Device/i })).toBeVisible()
  })

  test('should click "New Device" and navigate to new device form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')

    await page.getByRole('link', { name: /New Device/i }).click()
    await page.waitForURL('**/devices/new')

    await expect(page.getByRole('heading', { name: /New POS Device/i })).toBeVisible()
  })

  test('should verify new device form has tabs (General, Operators tab hidden for new)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices/new')
    await page.waitForLoadState('networkidle')

    // General tab should be visible
    await expect(page.getByRole('tab', { name: /General/i })).toBeVisible()

    // Operators and Reports tabs are hidden for new devices (v-if="!isNew")
    await expect(page.getByRole('tab', { name: /Operators/i })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /Reports/i })).toHaveCount(0)
  })

  test('should fill General tab fields and verify save button exists', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices/new')
    await page.waitForLoadState('networkidle')

    // Fill Name field
    await page.getByLabel(/^Name$/i).fill('Test POS Device')

    // Fill Device Number field (must be 8 chars)
    await page.getByLabel(/Device Number/i).fill('12345678')

    // Verify Create/Save button is present
    await expect(page.getByRole('button', { name: /Create|Save/i })).toBeVisible()
  })

  test('an existing device shows its number read-only, and its save does not send it', async ({ page }) => {
    // The number is fixed once the device exists (receipts, sessions and the SUPTO export keep it as text): the PUT
    // refuses another one (422 `device_number_immutable`), so the form neither offers nor sends it.
    const admin = await apiLogin()
    const { warehouses } = await (await fetch(`${API}/api/org/${admin.orgId}/warehouse/warehouse?size=1`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })).json()
    const deviceNumber = `N${Date.now().toString(36).toUpperCase()}`.slice(0, 8).padEnd(8, '0')
    const created = await apiPost(admin, '/fiscal/device', {
      deviceNumber, name: `E2E fixed number ${deviceNumber}`, manufacturer: 'datecs', connectionType: 'browser',
      warehouseId: warehouses[0]._id || warehouses[0].id,
    })
    expect(created.status).toBe(200)
    const { fiscalDevice } = await created.json()
    const id = String(fiscalDevice._id || fiscalDevice.id)

    try {
      await loginForApp(page)
      await page.goto(`/invoicing/configuration/devices/${id}`)
      await page.waitForLoadState('networkidle')

      const number = page.getByTestId('device-number').locator('input')
      await expect(number).toHaveValue(deviceNumber, { timeout: 15000 })
      await expect(number).not.toBeEditable()

      await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill(`E2E fixed number ${deviceNumber} renamed`)
      const put = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/fiscal/device/${id}`))
      await page.getByRole('button', { name: /^save$/i }).first().click()
      const answer = await put
      expect(answer.status()).toBe(200)
      const body = answer.request().postDataJSON()
      expect(body.name).toBe(`E2E fixed number ${deviceNumber} renamed`)
      expect(body).not.toHaveProperty('deviceNumber')
    } finally {
      await apiDelete(admin, `/fiscal/device/${id}`)
    }
  })

  test('should verify operator table renders on Operators tab for existing device', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Check if there are existing devices
    const rows = table.locator('tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText(/No data/i).isVisible().catch(() => false)

      if (!hasNoData) {
        // Click the first device name link to go to detail
        const deviceLink = rows.first().locator('a').first()
        const hasLink = await appears(deviceLink, 3000)

        if (hasLink) {
          await deviceLink.click()
          await page.waitForLoadState('networkidle')

          // Click Operators tab
          await page.getByRole('tab', { name: /Operators/i }).click()

          // Verify operator table renders with expected columns
          const operatorTable = page.locator('.v-table')
          await expect(operatorTable).toBeVisible({ timeout: 5000 })
          await expect(operatorTable.locator('th', { hasText: /Name/i })).toBeVisible()
          await expect(operatorTable.locator('th', { hasText: /Password/i })).toBeVisible()
        }
      }
    }
  })

  test('should verify Reports tab has report buttons for existing device', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Check if there are existing devices
    const rows = table.locator('tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText(/No data/i).isVisible().catch(() => false)

      if (!hasNoData) {
        // Click the first device name link to go to detail
        const deviceLink = rows.first().locator('a').first()
        const hasLink = await appears(deviceLink, 3000)

        if (hasLink) {
          await deviceLink.click()
          await page.waitForLoadState('networkidle')

          // Click Reports tab
          await page.getByRole('tab', { name: /Reports/i }).click()

          // Verify report cards are visible. ⚠ `exact`: by default getByText matches any substring,
          // case-insensitively, so „Daily X-Report" also found the card's description („Print daily
          // X-report …") and failed strict mode. The seed has no device, so this branch never ran
          // until a spec (cash-register-fiscal) left one behind.
          await expect(page.getByText('Daily X-Report', { exact: true })).toBeVisible({ timeout: 5000 })
          await expect(page.getByText('Daily Z-Report', { exact: true })).toBeVisible()
          await expect(page.getByText('Operator Report', { exact: true })).toBeVisible()
          await expect(page.getByText('FM Report by Date', { exact: true })).toBeVisible()
          await expect(page.getByText('FM Report by Number', { exact: true })).toBeVisible()
          await expect(page.getByText('Electronic Journal (KLEN)', { exact: true })).toBeVisible()
        }
      }
    }
  })
})
