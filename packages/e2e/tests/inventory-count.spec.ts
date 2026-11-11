import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiDelete } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * The inventory count form: a count is made from a warehouse's stock, saved, and saved again
 * after an edit. It stops short of completing the count, which books stock that other specs sell.
 *
 * ⚠ The route stores the form's body as the document, and refuses a body that chooses a field
 * the server sets (`services/biz/server-owned.ts`, S-36). So what the form SENDS is asserted
 * here, key by key: a field added to this payload that the server owns (a status, a number)
 * would turn every save of the form into a 422, and nothing else in the suite would say so.
 */
test.describe('Inventory count form', () => {
  test('creates a count from the stock of a warehouse and saves an edit', async ({ page }) => {
    // A warehouse that holds stock, by name. Never "the first option": the list is by name and
    // other specs add warehouses of their own, most of them empty.
    const session = await apiLogin()
    const { warehouses } = await apiGet(session, '/warehouse/warehouse?size=1000')
    let warehouse: any
    for (const w of (warehouses || []).filter((x: any) => x.isActive !== false)) {
      const { stockLevels } = await apiGet(session, `/warehouse/stock-level?warehouseId=${w._id}&size=1`)
      if (stockLevels?.length) { warehouse = w; break }
    }
    expect(warehouse, 'the seed has a warehouse that holds stock').toBeTruthy()

    let countId = ''
    try {
      await loginForApp(page)
      await page.goto('/inventory/inventory-counts/new')

      // The select's list is virtualised: an option far down is not in the page until the list is scrolled to it.
      await openSelect(page.locator('form'), /warehouse/i)
      const option = page.getByRole('option', { name: warehouse.name, exact: true })
      const list = page.locator('.v-overlay--active .v-list').last()
      await list.waitFor({ state: 'visible' })
      for (let i = 0; i < 40 && !(await option.count()); i++) {
        await list.evaluate(el => { el.scrollTop += el.clientHeight })
        await page.waitForTimeout(100)
      }
      await option.click()

      const [levels] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/warehouse/stock-level') && r.request().method() === 'GET'),
        page.getByRole('button', { name: /load products/i }).click(),
      ])
      expect(levels.status()).toBe(200)
      const lines = page.locator('form tbody tr')
      await expect(lines.first()).toBeVisible({ timeout: 15000 })
      const lineCount = await lines.count()

      const notes = page.locator('form textarea').first()
      await notes.fill('e2e count: first save')
      const save = page.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first()
      const [created] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/warehouse/inventory-count') && r.request().method() === 'POST'),
        save.click(),
      ])
      expect(created.status()).toBe(200)

      // What the form sends: its own fields, and none the server sets.
      const sent = created.request().postDataJSON()
      expect(Object.keys(sent).sort()).toEqual(['date', 'itemCount', 'lines', 'notes', 'type', 'varianceCount', 'warehouseId'])
      expect(Object.keys(sent.lines[0]).sort()).toEqual(['countedQuantity', 'productId', 'systemQuantity', 'variance'])

      // What the server made of it.
      const made = (await created.json()).inventoryCount
      countId = made._id
      expect(made.status).toBe('in_progress')
      expect(made.countNumber).toMatch(/^IC-\d{4}-\d{5}$/)
      expect(made.lines).toHaveLength(lineCount)

      await page.waitForURL(/\/inventory\/inventory-counts\/[0-9a-f]{24}\/edit/, { timeout: 15000 })
      await expect(lines.first()).toBeVisible()

      await notes.fill('e2e count: edited')
      const [saved] = await Promise.all([
        page.waitForResponse(r => /\/warehouse\/inventory-count\/[0-9a-f]{24}$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT'),
        save.click(),
      ])
      expect(saved.status()).toBe(200)
      const after = (await saved.json()).inventoryCount
      expect(after.notes).toBe('e2e count: edited')
      expect(after.status).toBe('in_progress')
      expect(after.countNumber).toBe(made.countNumber)
      expect(after.lines).toHaveLength(lineCount)
    } finally {
      // An in-progress count is deleted outright. It never touched stock.
      if (countId) await apiDelete(session, `/warehouse/inventory-count/${countId}`)
    }
  })
})
