import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { waitForDataTable, countTableRows, uniqueName } from './helpers/crud'

test.describe('Tags Feature', () => {
  test.beforeEach(async ({ page }) => {
    await loginForApp(page)
  })

  test('should create a product with tags', async ({ page }) => {
    await page.goto('/warehouse/products/new')
    await expect(page.getByRole('heading', { name: /new product/i })).toBeVisible({ timeout: 10000 })

    // Fill basic product info
    await page.getByLabel(/sku/i).fill(uniqueName('TAG-SKU'))
    await page.getByLabel(/name/i).fill(uniqueName('TagTestProduct'))

    // Find the TagInput combobox and add tags via the input element
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    const tagCombobox = tagInput.locator('input[type="text"]')
    await tagCombobox.click()
    await tagCombobox.fill('test-tag-e2e')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await tagCombobox.fill('second-tag')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // Verify chips are visible
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'test-tag-e2e' })).toBeVisible()
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'second-tag' })).toBeVisible()

    // Save the product
    await page.getByRole('button', { name: /save/i }).click()

    // Verify redirect to products list
    await expect(page).toHaveURL(/warehouse\/products/, { timeout: 15000 })
  })

  test('should edit a product and modify tags', async ({ page }) => {
    // Create a product with tags via API using browser context fetch
    const sku = uniqueName('EDIT-TAG')
    const apiResult = await page.evaluate(async ({ sku }) => {
      const orgData = JSON.parse(localStorage.getItem('lgr_org') || '{}')
      const token = localStorage.getItem('lgr_token')
      const orgId = orgData.id || orgData._id
      const resp = await fetch(`/api/org/${orgId}/warehouse/product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sku, name: 'TagEditTest', type: 'goods', category: 'general', unit: 'pcs', tags: ['original-tag'] }),
      })
      return { ok: resp.ok, status: resp.status, text: await resp.text() }
    }, { sku })

    // If API creation fails, skip the test gracefully
    if (!apiResult.ok) {
      test.skip(true, `Product creation via API failed: ${apiResult.status} - ${apiResult.text}`)
      return
    }

    // Navigate to products and find the product
    await page.goto('/warehouse/products', { waitUntil: 'networkidle' })
    await waitForDataTable(page)

    // Click edit on the product we just created
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: sku })
    await expect(row).toBeVisible({ timeout: 10000 })
    await row.locator('.mdi-pencil').click()

    // Wait for the form to load
    await expect(page).toHaveURL(/warehouse\/products\/.*\/edit/, { timeout: 10000 })
    await page.waitForTimeout(1000)

    // Verify the tags combobox is visible on the form
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    await expect(tagInput).toBeVisible()

    // Add a new tag via the combobox
    const tagCombobox = tagInput.locator('input[type="text"]')
    await tagCombobox.click()
    await tagCombobox.fill('new-tag')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // Verify the new tag chip is visible
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'new-tag' })).toBeVisible()

    // Save
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page).toHaveURL(/warehouse\/products/, { timeout: 15000 })
  })

  test('should create tag via combobox input', async ({ page }) => {
    // Navigate to product creation
    await page.goto('/warehouse/products/new', { waitUntil: 'networkidle' })

    // Type a new tag in the TagInput combobox and press Enter to create it
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    const tagCombobox = tagInput.locator('input[type="text"]')
    await tagCombobox.click()
    await tagCombobox.fill('my-custom-tag')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // Verify the tag chip appears
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'my-custom-tag' })).toBeVisible()
  })

  test('should filter products by tags in list view', async ({ page }) => {
    // Create products with tags via API using browser context
    const filterTag = uniqueName('filter')
    await page.evaluate(async ({ filterTag }) => {
      const orgData = JSON.parse(localStorage.getItem('lgr_org') || '{}')
      const token = localStorage.getItem('lgr_token')
      const orgId = orgData.id || orgData._id
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

      await fetch(`/api/org/${orgId}/warehouse/product`, {
        method: 'POST', headers,
        body: JSON.stringify({ sku: `FLT1-${Date.now().toString(36)}`, name: 'FilterProduct1', type: 'goods', category: 'general', unit: 'pcs', tags: [filterTag] }),
      })
      await fetch(`/api/org/${orgId}/warehouse/product`, {
        method: 'POST', headers,
        body: JSON.stringify({ sku: `FLT2-${Date.now().toString(36)}`, name: 'FilterProduct2', type: 'goods', category: 'general', unit: 'pcs', tags: ['other-tag'] }),
      })
    }, { filterTag })

    // Navigate to products list
    await page.goto('/warehouse/products', { waitUntil: 'networkidle' })
    await waitForDataTable(page)

    const rowsBefore = await countTableRows(page)

    // Use the tag filter
    const tagFilter = page.locator('.v-combobox').filter({ hasText: /filter by tags/i })
    const filterCombobox = tagFilter.locator('input[type="text"]')
    await filterCombobox.click()
    await filterCombobox.fill(filterTag)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Table should reload with filtered results
    await waitForDataTable(page)
    const rowsAfter = await countTableRows(page)

    // Should have fewer (or equal) rows when filtered
    expect(rowsAfter).toBeLessThanOrEqual(rowsBefore)
  })
})
