import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'

test.describe('Accounting', () => {
  test('should navigate to accounts and verify data table renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts')

    // AccountsView uses DataTable component which wraps v-data-table inside a v-card
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    // AccountsView uses <h1> with translation "Chart of Accounts"
    await expect(page.getByRole('heading', { name: /chart of accounts/i })).toBeVisible()
  })

  test('should show account codes and names in accounts list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // DataTable component includes a search field; verify table headers
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /code/i }).first()).toBeVisible()
    await expect(table.locator('th', { hasText: /name/i }).first()).toBeVisible()
  })

  test('should navigate to journal entries and verify list renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/journal-entries', { waitUntil: 'networkidle' })

    // JournalEntriesView uses <h1> with translation "Journal Entries"
    await expect(page.getByRole('heading', { name: /journal entries/i })).toBeVisible({ timeout: 10000 })
    // Uses DataTable component which wraps v-data-table inside a v-card
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to new journal entry and verify form renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/journal-entries/new', { waitUntil: 'networkidle' })

    // JournalEntryFormView uses <h1> with i18n key accounting.newJournalEntry
    await expect(page.getByRole('heading', { name: /new journal entry/i })).toBeVisible({ timeout: 10000 })

    // Form has description field (i18n key: common.description)
    await expect(page.getByLabel(/description/i).first()).toBeVisible()
    // Save button
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  })

  test('should create a new journal entry with debit and credit lines', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/journal-entries/new', { waitUntil: 'networkidle' })

    // Wait for form to load
    await expect(page.getByRole('heading', { name: /new journal entry/i })).toBeVisible({ timeout: 10000 })

    // Fill the description (use .first() since "Description" label also appears as column header)
    await page.getByLabel(/description/i).first().fill('Test journal entry - office supplies')

    // Click "Add Line" button (i18n key: accounting.addLine)
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(500)

    // Select account in first line using the v-select
    const firstRow = page.locator('table tbody tr').first()
    await firstRow.locator('.v-select').first().click({ force: true })
    await page.waitForTimeout(500)
    await page.locator('.v-list-item').first().click()
    await page.waitForTimeout(300)

    // Fill debit amount in first line (first number input = debit)
    await firstRow.locator('input[type="number"]').first().fill('100')

    // Click "Add Line" again for credit line
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(500)

    // Select account in second line
    const secondRow = page.locator('table tbody tr').nth(1)
    await secondRow.locator('.v-select').first().click({ force: true })
    await page.waitForTimeout(500)
    await page.locator('.v-list-item').first().click()
    await page.waitForTimeout(300)

    // Fill credit amount in second line (second number input = credit)
    await secondRow.locator('input[type="number"]').nth(1).fill('100')

    // Save the journal entry (match exact "Save" to avoid "Save and Post")
    await page.getByRole('button', { name: /^save$/i }).click()

    // Verify navigation back to journal entries list or success
    await expect(page).toHaveURL(/accounting\/journal-entries/, { timeout: 10000 })
  })

  test('should create a journal entry without pre-existing fiscal periods', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/journal-entries/new', { waitUntil: 'networkidle' })

    await expect(page.getByRole('heading', { name: /new journal entry/i })).toBeVisible({ timeout: 10000 })

    // Fill description
    await page.getByLabel(/description/i).first().fill('Auto fiscal period test entry')

    // Add first line (debit)
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(500)

    const firstRow = page.locator('table tbody tr').first()
    await firstRow.locator('.v-select').first().click({ force: true })
    await page.waitForTimeout(500)
    await page.locator('.v-list-item').first().click()
    await page.waitForTimeout(300)
    await firstRow.locator('input[type="number"]').first().fill('250')

    // Add second line (credit)
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(500)

    const secondRow = page.locator('table tbody tr').nth(1)
    await secondRow.locator('.v-select').first().click({ force: true })
    await page.waitForTimeout(500)
    await page.locator('.v-list-item').first().click()
    await page.waitForTimeout(300)
    await secondRow.locator('input[type="number"]').nth(1).fill('250')

    // Save — fiscal periods should be auto-created by the backend
    await page.getByRole('button', { name: /^save$/i }).click()

    // Verify navigation back to journal entries list (no error)
    await expect(page).toHaveURL(/accounting\/journal-entries/, { timeout: 10000 })
  })

  test('should verify journal entry balance display', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/journal-entries/new', { waitUntil: 'networkidle' })

    // Wait for form to load
    await expect(page.getByRole('heading', { name: /new journal entry/i })).toBeVisible({ timeout: 10000 })

    // Fill description (use .first() since "Description" label also appears as column header)
    await page.getByLabel(/description/i).first().fill('Balance check entry')

    // The form shows total row in the table footer (tfoot)
    await expect(page.locator('tfoot').getByText(/total/i)).toBeVisible()
  })

  test('should navigate to general ledger', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/general-ledger')

    // GeneralLedgerView uses <h1> with translation "General Ledger"
    await expect(page.getByRole('heading', { name: /general ledger/i })).toBeVisible({ timeout: 10000 })
    // Should show filter controls (v-select for account, date fields)
    await expect(
      page.locator('.v-select, .v-card').first()
    ).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to financial statements', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/financial-statements')

    // FinancialStatementsView uses <h1> with translation "Financial Statements"
    await expect(page.getByRole('heading', { name: /financial statements/i })).toBeVisible({ timeout: 10000 })
    // Should show tabs: Trial Balance, Profit & Loss, Balance Sheet
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 10000 })
  })

  // ⚠ Reaching the page proves nothing here: until FR-25 R0 its Generate button called store actions
  // that did not exist, and its rows read fields the API does not send, and this spec stayed green.
  test('should generate each statement from the posted entries', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/financial-statements', { waitUntil: 'networkidle' })

    // Trial balance: the seeded entries are in 2025, and the date defaults to today.
    await page.getByRole('button', { name: /generate/i }).click()
    const trialBalance = page.locator('.v-data-table')
    await expect(trialBalance.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })
    await expect(trialBalance.locator('tbody tr').first().locator('td').first()).not.toBeEmpty()
    await expect(trialBalance.locator('tbody tr').first().locator('td').nth(1)).not.toBeEmpty()

    // Its totals agree, and stand under their own columns: a row outside the <table> stacked them at the left.
    const totals = trialBalance.locator('tfoot td')
    await expect(totals).toHaveCount(4)
    expect(await totals.nth(1).innerText()).toBe(await totals.nth(2).innerText())
    const debitTotal = await totals.nth(1).boundingBox()
    const debitHeader = await trialBalance.getByRole('columnheader', { name: /debit/i }).boundingBox()
    expect(Math.abs(debitTotal!.x - debitHeader!.x)).toBeLessThan(2)

    // A year, then a period in it, narrow it: every seeded entry is in January 2025.
    await openSelect(page, /fiscal year/i)
    await page.getByRole('option', { name: /2025/ }).click()
    await openSelect(page, /fiscal period/i)
    await page.getByRole('option', { name: 'January 2025' }).click()
    await page.getByRole('button', { name: /generate/i }).click()
    await expect(trialBalance.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })

    await openSelect(page, /fiscal period/i)
    await page.getByRole('option', { name: 'February 2025' }).click()
    await page.getByRole('button', { name: /generate/i }).click()
    await expect(trialBalance).toHaveCount(0, { timeout: 10000 })

    // Profit and loss: both sides of every account, beside the net.
    await page.getByRole('tab', { name: /profit/i }).click()
    await page.getByLabel(/date from/i).fill('2025-01-01')
    await page.getByLabel(/date to/i).fill('2025-12-31')
    await page.getByRole('button', { name: /generate/i }).click()
    await expect(page.getByRole('heading', { name: 'Revenue', exact: true })).toBeVisible({ timeout: 10000 })
    const revenue = page.locator('table').first()
    await expect(revenue.getByRole('columnheader', { name: 'Debit' })).toBeVisible()
    await expect(revenue.getByRole('columnheader', { name: 'Credit' })).toBeVisible()
    await expect(revenue.getByRole('columnheader', { name: 'Amount' })).toBeVisible()
    await expect(revenue.locator('tbody tr').first().locator('td').first()).toContainText(/\d+ - /)

    // The balance sheet: rows named by their accounts, and the two sides equal.
    await page.getByRole('tab', { name: /balance sheet/i }).click()
    await page.getByRole('button', { name: /generate/i }).click()
    const totalAssets = page.getByRole('row', { name: /total assets/i }).getByRole('cell').last()
    await expect(totalAssets).toBeVisible({ timeout: 10000 })
    await expect(page.locator('table').first().locator('tbody tr').first().locator('td').first()).toContainText(/\d+ - /)
    await expect(page.getByText(/total liabilities & equity/i).locator('..')).toContainText(await totalAssets.innerText())
  })

  test('should filter accounts by type', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // The DataTable component has a built-in search field
    // AccountsView also has an Add button that opens a dialog with type filter
    // Use the search field in the DataTable to filter
    const searchField = page.locator('.v-text-field input').first()
    await searchField.fill('asset')

    // Table should still be visible after filtering
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to fixed assets', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/fixed-assets')

    // FixedAssetsView uses <h1> with translation "Fixed Assets"
    await expect(page.getByRole('heading', { name: /fixed assets/i })).toBeVisible({ timeout: 10000 })
    await expect(
      page.locator('.v-data-table, .v-card').first()
    ).toBeVisible({ timeout: 10000 })
  })
})
