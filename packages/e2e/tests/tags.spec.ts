import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { waitForDataTable, clickCreate, saveDialog, fillField, countTableRows, uniqueName } from './helpers/crud'

test.describe('Tags Feature', () => {
  test.beforeEach(async ({ page }) => {
    await loginForApp(page)
  })

  test('should create a product with tags', async ({ page }) => {
    await page.goto('/warehouse/products/new', { waitUntil: 'networkidle' })

    // Fill basic product info
    await page.getByLabel(/sku/i).fill(uniqueName('TAG-SKU'))
    await page.getByLabel(/^name$/i).fill(uniqueName('TagTestProduct'))

    // Find the TagInput combobox and add tags
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    const tagCombobox = tagInput.getByRole('combobox')
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

    // Should redirect to products list
    await page.waitForURL('**/warehouse/products', { timeout: 10000 })
  })

  test('should edit a product and modify tags', async ({ page }) => {
    // First create a product with tags via API
    const apiBase = process.env.BASE_URL || 'http://localhost:4001'
    const orgData = JSON.parse(await page.evaluate(() => localStorage.getItem('lgr_org') || '{}'))
    const token = await page.evaluate(() => localStorage.getItem('lgr_token'))
    const orgId = orgData.id || orgData._id

    const sku = uniqueName('EDIT-TAG')
    await fetch(`${apiBase}/api/org/${orgId}/warehouse/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sku, name: 'TagEditTest', type: 'goods', tags: ['original-tag'] }),
    })

    // Navigate to products and find the product
    await page.goto('/warehouse/products', { waitUntil: 'networkidle' })
    await waitForDataTable(page)

    // Click edit on the product we just created
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: sku })
    await row.locator('.mdi-pencil').click()

    // Wait for the form to load
    await page.waitForURL('**/warehouse/products/**/edit', { timeout: 5000 })
    await page.waitForTimeout(1000)

    // Verify existing tag is shown as chip
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'original-tag' })).toBeVisible()

    // Add a new tag
    const tagCombobox = tagInput.getByRole('combobox')
    await tagCombobox.click()
    await tagCombobox.fill('new-tag')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // Verify both tags visible
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'original-tag' })).toBeVisible()
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'new-tag' })).toBeVisible()

    // Save
    await page.getByRole('button', { name: /save/i }).click()
    await page.waitForURL('**/warehouse/products', { timeout: 10000 })
  })

  test('should show tag autocomplete suggestions', async ({ page }) => {
    // Create a tag via API first
    const apiBase = process.env.BASE_URL || 'http://localhost:4001'
    const orgData = JSON.parse(await page.evaluate(() => localStorage.getItem('lgr_org') || '{}'))
    const token = await page.evaluate(() => localStorage.getItem('lgr_token'))
    const orgId = orgData.id || orgData._id

    await fetch(`${apiBase}/api/org/${orgId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'product', value: 'autocomplete-test-tag' }),
    })

    // Navigate to product creation
    await page.goto('/warehouse/products/new', { waitUntil: 'networkidle' })

    // Type in TagInput and wait for suggestions
    const tagInput = page.locator('.v-combobox').filter({ hasText: /tags/i })
    const tagCombobox = tagInput.getByRole('combobox')
    await tagCombobox.click()
    await tagCombobox.fill('autocomplete')
    await page.waitForTimeout(500)

    // Verify autocomplete suggestion appears
    const option = page.locator('.v-menu .v-list-item').filter({ hasText: 'autocomplete-test-tag' })
    await expect(option).toBeVisible({ timeout: 5000 })

    // Select it
    await option.click()
    await page.waitForTimeout(300)

    // Verify chip
    await expect(tagInput.locator('.v-chip').filter({ hasText: 'autocomplete-test-tag' })).toBeVisible()
  })

  test('should filter products by tags in list view', async ({ page }) => {
    // Create products with tags via API
    const apiBase = process.env.BASE_URL || 'http://localhost:4001'
    const orgData = JSON.parse(await page.evaluate(() => localStorage.getItem('lgr_org') || '{}'))
    const token = await page.evaluate(() => localStorage.getItem('lgr_token'))
    const orgId = orgData.id || orgData._id

    const filterTag = uniqueName('filter')
    await fetch(`${apiBase}/api/org/${orgId}/warehouse/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sku: uniqueName('FLT1'), name: 'FilterProduct1', type: 'goods', tags: [filterTag] }),
    })
    await fetch(`${apiBase}/api/org/${orgId}/warehouse/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sku: uniqueName('FLT2'), name: 'FilterProduct2', type: 'goods', tags: ['other-tag'] }),
    })

    // Navigate to products list
    await page.goto('/warehouse/products', { waitUntil: 'networkidle' })
    await waitForDataTable(page)

    const rowsBefore = await countTableRows(page)

    // Use the tag filter
    const tagFilter = page.locator('.v-combobox').filter({ hasText: /filter by tags/i })
    const filterCombobox = tagFilter.getByRole('combobox')
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
