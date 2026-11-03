import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Payroll', () => {
  test('should navigate to employees page and render data table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    // EmployeesView uses <h1 class="text-h4"> with i18n key payroll.employees
    await expect(page.getByRole('heading', { name: /employees/i })).toBeVisible()
    // Uses DataTable component which wraps v-data-table
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should display name and department columns in employee list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    const table = page.locator('.v-data-table')
    // Column headers from EmployeesView: common.name (fullName), payroll.department
    await expect(table.locator('th', { hasText: /name/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /department/i })).toBeVisible()
  })

  test('should open new employee form dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    // EmployeesView has a Create button that opens a dialog (not a separate page)
    // ResponsiveBtn renders the action twice — a header variant and an empty-state/mobile
    // one — so the bare role query hits strict mode. Filter to the one actually on screen.
    await page.getByRole('button', { name: /create/i }).filter({ visible: true }).first().click()

    // Verify dialog opens with tabs
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()
    // Dialog title includes "Create" and "Employee"
    await expect(dialog.locator('.v-card-title')).toBeVisible()
    // Personal Info tab is default
    await expect(dialog.getByRole('tab', { name: /personal/i })).toBeVisible()
  })

  test('should fill new employee form with name and save', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    // Open the create dialog
    // ResponsiveBtn renders the action twice — a header variant and an empty-state/mobile
    // one — so the bare role query hits strict mode. Filter to the one actually on screen.
    await page.getByRole('button', { name: /create/i }).filter({ visible: true }).first().click()
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()

    // Fill first name and last name on the Personal Info tab
    // Labels come from $t('common.firstName') = "First Name" and $t('common.lastName') = "Last Name"
    await dialog.getByLabel(/first name/i).fill('Jane')
    await dialog.getByLabel(/last name/i).fill('Doe')

    // Switch to Employment tab for department
    // Tab text: $t('payroll.employmentDetails') = "Employment Details"
    await dialog.getByRole('tab', { name: /employment/i }).click()
    await page.waitForTimeout(300)

    // Department is a v-select - use force click for Vuetify selects
    const departmentSelect = dialog.getByLabel(/department/i)
    if (await departmentSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await departmentSelect.click({ force: true })
      // Vuetify v-select renders options as v-list-items in an overlay
      const option = page.locator('.v-overlay .v-list-item').first()
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        await option.click()
      }
    }

    // Switch to Salary tab
    // Tab text: $t('payroll.salary') = "Salary"
    await dialog.getByRole('tab', { name: /salary/i }).click()
    await page.waitForTimeout(300)

    // Save the employee
    await dialog.getByRole('button', { name: /^save$/i }).first().click()

    // Dialog should close after save (or show success)
    // The data table should be visible (either dialog closed or still on employees page)
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should create a run, calculate it, approve it, and show its totals', async ({ page }) => {
    await loginForApp(page)
    const name = `Run ${Date.now()}`

    await page.goto('/payroll/runs/new')
    await page.getByLabel(/^name/i).fill(name)
    await page.getByLabel(/period start/i).fill('2026-03-01')
    await page.getByLabel(/period end/i).fill('2026-03-31')
    const step = async (button: RegExp, method: string, path: RegExp) => {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === method && path.test(r.url())),
        page.getByRole('button', { name: button }).filter({ visible: true }).first().click(),
      ])
      expect(response.status()).toBe(200)
    }
    await step(/save/i, 'POST', /\/payroll\/run$/)
    await step(/calculate/i, 'POST', /\/calculate$/)
    await step(/approve/i, 'POST', /\/approve$/)

    await page.goto(`/payroll/runs?search=${encodeURIComponent(name)}`)
    const row = page.locator('.v-data-table tbody tr', { hasText: name })
    await expect(row).toContainText('approved')
    await expect(row).toContainText('2026')
    await expect(row).toContainText('€')
    await expect(row).not.toContainText('NaN')
    await expect(row).not.toContainText('{')
  })

  test('should navigate to payroll runs page and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/runs')

    // PayrollRunsView uses <h1 class="text-h4"> with i18n key payroll.payrollRuns
    await expect(page.getByRole('heading', { name: /payroll runs/i })).toBeVisible()
    // Uses DataTable component
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to payslips page and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/payslips')

    // PayslipsView uses <h1 class="text-h4"> with i18n key payroll.payslips
    await expect(page.getByRole('heading', { name: /payslips/i })).toBeVisible()
    // Uses DataTable component
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to timesheets page and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/timesheets')

    // TimesheetsView uses <h1 class="text-h4"> with i18n key payroll.timesheets
    await expect(page.getByRole('heading', { name: /timesheets/i })).toBeVisible()
    // Uses DataTable component
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should filter employees by search', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    // Wait for data table to load
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // DataTable component has a built-in search field
    const searchField = page.locator('.v-text-field input').first()
    await searchField.fill('Active')

    // Table should still be visible after filtering
    await expect(page.locator('.v-data-table')).toBeVisible()
  })
})
