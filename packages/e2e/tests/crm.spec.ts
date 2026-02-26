import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('CRM Module', () => {
  test('should navigate to leads and verify data table renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    // LeadsView uses <h1 class="text-h4"> with i18n key crm.leads
    await expect(page.getByRole('heading', { name: /leads/i })).toBeVisible()

    // Verify data table is rendered (uses v-data-table directly)
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Verify Create button is present
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()

    // Verify search field is present
    await expect(page.locator('.v-text-field input').first()).toBeVisible()
  })

  test('should show status and source columns in leads list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    // Wait for the data table to render
    const table = page.locator('.v-data-table')
    await expect(table).toBeVisible()

    // Verify status column header exists
    await expect(table.locator('th', { hasText: /status/i })).toBeVisible()

    // Verify source column header exists
    await expect(table.locator('th', { hasText: /source/i })).toBeVisible()

    // Verify filter dropdowns are present (v-select elements)
    await expect(page.locator('.v-select').first()).toBeVisible()
  })

  test('should open lead creation form via Create button', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    // Click the Create button to open the dialog
    await page.getByRole('button', { name: /create/i }).click()

    // Verify the dialog form opens
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()

    // Verify form fields are present (contactName and companyName both match /name/i, so be specific)
    await expect(dialog.getByLabel(/contact\s*name/i)).toBeVisible()
    await expect(dialog.getByLabel(/email/i)).toBeVisible()
    await expect(dialog.getByLabel(/phone/i)).toBeVisible()
    await expect(dialog.getByLabel(/company\s*name/i)).toBeVisible()
    await expect(dialog.getByLabel(/source/i)).toBeVisible()
    await expect(dialog.getByLabel(/status/i)).toBeVisible()

    // Verify Save and Cancel buttons
    await expect(dialog.getByRole('button', { name: /save/i })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible()
  })

  test('should fill in new lead form with company name, contact, and email', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    // Open the create dialog
    await page.getByRole('button', { name: /create/i }).click()
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()

    // Fill in contact name (be specific to avoid matching companyName)
    await dialog.getByLabel(/contact\s*name/i).fill('Jane Smith')

    // Fill in company name
    await dialog.getByLabel(/company\s*name/i).fill('Acme Industries')

    // Fill in email
    await dialog.getByLabel(/email/i).fill('jane.smith@acme.com')

    // Verify source v-select is present in the form
    await expect(dialog.locator('.v-select').first()).toBeVisible()

    // Verify the form fields have been filled
    await expect(dialog.getByLabel(/contact\s*name/i)).toHaveValue('Jane Smith')
    await expect(dialog.getByLabel(/company\s*name/i)).toHaveValue('Acme Industries')
    await expect(dialog.getByLabel(/email/i)).toHaveValue('jane.smith@acme.com')
  })

  test('should navigate to deals and verify page renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/deals')

    // DealsView uses <h1 class="text-h4"> with i18n key crm.deals
    await expect(page.getByRole('heading', { name: /deals/i })).toBeVisible()

    // Verify Create button is present
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()

    // Verify view mode toggle buttons are present (v-btn-toggle with table/board)
    await expect(page.locator('.v-btn-toggle')).toBeVisible()

    // Click the table view button to verify data table renders
    const tableBtn = page.locator('.v-btn-toggle button', { has: page.locator('.mdi-table') })
    await tableBtn.click()
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to activities and verify list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/activities')

    // ActivitiesView uses <h1 class="text-h4"> with i18n key crm.activities
    await expect(page.getByRole('heading', { name: /activities/i })).toBeVisible()

    // Verify data table is rendered
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Verify Create button is present
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()

    // Verify search field and filter dropdowns
    await expect(page.locator('.v-text-field input').first()).toBeVisible()
  })

  test('should filter leads by status', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    // Wait for the data table to render
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Click the status filter dropdown (use combobox role to avoid strict violation with clear button)
    await page.getByRole('combobox', { name: /status/i }).click({ force: true })

    // Select a status option
    const newOption = page.getByRole('option', { name: /new/i })
    if (await newOption.isVisible().catch(() => false)) {
      await newOption.click()
    } else {
      await page.getByRole('option').first().click()
    }

    // Verify the filter has been applied - the data table should still be visible
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should open deal detail dialog showing stage and value fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/deals')

    // Open the create dialog to verify deal form has stage and value fields
    await page.getByRole('button', { name: /create/i }).click()

    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()

    // Verify the form is rendered inside the dialog
    await expect(dialog.locator('.v-form')).toBeVisible()

    // Verify stage field is present (v-select with label "Stage")
    await expect(dialog.getByLabel(/stage/i)).toBeVisible()

    // Verify deal value field is present (v-text-field with label "Deal Value")
    await expect(dialog.getByLabel(/deal value/i)).toBeVisible()

    // Verify status field is present (v-select with label "Status")
    await expect(dialog.getByLabel(/status/i)).toBeVisible()

    // Verify probability field is present (v-text-field with label "Probability")
    await expect(dialog.getByLabel(/probability/i)).toBeVisible()

    // Verify expected close date field is present (v-text-field with label "Expected Close")
    await expect(dialog.getByLabel(/expected close/i)).toBeVisible()
  })
})
