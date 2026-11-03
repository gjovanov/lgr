import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { expectPaginatedTable, getPageInfo, waitForTableLoaded } from './helpers/pagination'
import {
  clickCreate,
  saveDialog,
  fillField,
  selectOption,
  selectAutocomplete,
  waitForDataTable,
  editFirstRow,
  expectSuccess,
  uniqueName,
} from './helpers/crud'

test.describe('Payroll CRUD', () => {
  test('should create an employee with name and employment details (contractStartDate, full_time)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    await waitForDataTable(page)

    const dialog = await clickCreate(page)

    // Personal Info tab (default)
    const firstName = uniqueName('Jane')
    await fillField(dialog, /first name/i, firstName)
    await fillField(dialog, /last name/i, 'TestDoe')

    // Switch to Employment tab
    await dialog.getByRole('tab', { name: /employment/i }).click()
    await page.waitForTimeout(300)

    // #408: every field below is on the form (EmployeesView.vue), so each is required: a guard
    // `isVisible({ timeout })` answered at once, and dropped the step when the tab had not rendered.
    // Fill contractStartDate (NOT "startDate")
    const contractStartField = dialog.getByLabel(/contract\s*start\s*date/i)
    await expect(contractStartField).toBeVisible()
    await contractStartField.fill('2025-01-15')

    // Select employment type - enum uses lowercase: full_time (not Full Time)
    const employmentTypeField = dialog.getByLabel(/employment\s*type/i)
    await expect(employmentTypeField).toBeVisible()
    await employmentTypeField.click({ force: true })
    const fullTimeOption = page.getByRole('option', { name: /full.time/i })
    await expect(fullTimeOption).toBeVisible()
    await fullTimeOption.click()

    // Select status - enum uses lowercase: active
    const statusField = dialog.getByLabel(/^status$/i)
    await expect(statusField).toBeVisible()
    await statusField.click({ force: true })
    const activeOption = page.getByRole('option', { name: /^active$/i })
    await expect(activeOption).toBeVisible()
    await activeOption.click()

    // The department is a text field: this step clicked it and waited for a list that never opens.
    const departmentField = dialog.getByLabel(/department/i)
    await expect(departmentField).toBeVisible()
    await departmentField.fill('Sales')

    // Save the employee
    await saveDialog(dialog)
    await expectSuccess(page)

    await waitForDataTable(page)
  })

  test('should verify salary tab fields: baseSalary, frequency, bankAccountNumber, bankName, iban', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    await waitForDataTable(page)

    const dialog = await clickCreate(page)

    // Fill required personal info first
    await fillField(dialog, /first name/i, uniqueName('Salary'))
    await fillField(dialog, /last name/i, 'TestEmp')

    // Switch to Salary tab
    await dialog.getByRole('tab', { name: /salary/i }).click()
    await page.waitForTimeout(300)

    // Verify nested salary structure fields exist
    // baseSalary (not just "salary")
    // #408: all six are on the tab; each was a guard that dropped its step without a word.
    const baseSalaryField = dialog.getByLabel(/base\s*salary/i)
    await expect(baseSalaryField).toBeVisible()
    await baseSalaryField.fill('5000')

    await expect(dialog.getByLabel(/currency/i)).toBeVisible()
    await expect(dialog.getByLabel(/frequency/i)).toBeVisible()

    // bankAccountNumber, bankName, iban (FR-25: sealed, on the person's record)
    const bankAccountField = dialog.getByLabel(/bank\s*account\s*number/i)
    await expect(bankAccountField).toBeVisible()
    await bankAccountField.fill('123456789')

    const bankNameField = dialog.getByLabel(/bank\s*name/i)
    await expect(bankNameField).toBeVisible()
    await bankNameField.fill('Test National Bank')

    const ibanField = dialog.getByLabel(/iban/i)
    await expect(ibanField).toBeVisible()
    await ibanField.fill('DE89370400440532013000')

    // Cancel since we just wanted to verify fields
    await dialog.getByRole('button', { name: /cancel/i }).click()
  })

  test('should verify employee address fields are nested (street, city, state, postalCode, country)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    await waitForDataTable(page)

    // Edit first employee to check address fields
    const dialog = await editFirstRow(page)
    if (!dialog) {
      // Create one if none exist
      const createDialog = await clickCreate(page)
      await fillField(createDialog, /first name/i, uniqueName('Addr'))
      await fillField(createDialog, /last name/i, 'TestAddr')

      // Look for address tab or section
      // The address is on the Personal Info tab.
      await createDialog.getByRole('tab', { name: /personal/i }).click()

      // Verify nested address fields
      const streetField = createDialog.getByLabel(/street/i)
      const cityField = createDialog.getByLabel(/^city$/i)
      const stateField = createDialog.getByLabel(/state/i)
      const postalCodeField = createDialog.getByLabel(/postal code/i)
      const countryField = createDialog.getByLabel(/country/i)

      // #408: all five are on the form. "At least one is visible" read all five at once, unwaited.
      for (const field of [streetField, cityField, stateField, postalCodeField, countryField]) await expect(field).toBeVisible()
      await streetField.fill('123 Employee St')
      await cityField.fill('Worktown')
      await stateField.fill('TX')
      await postalCodeField.fill('75001')
      await countryField.fill('US')

      await createDialog.getByRole('button', { name: /cancel/i }).click()
      return
    }

    // Look for address section/tab in edit dialog
    // The address is on the Personal Info tab.
    await dialog.getByRole('tab', { name: /personal/i }).click()

    // Verify nested address fields exist
    const streetField = dialog.getByLabel(/street/i)
    const cityField = dialog.getByLabel(/^city$/i)
    const stateField = dialog.getByLabel(/state/i)
    const postalCodeField = dialog.getByLabel(/postal code/i)
    const countryField = dialog.getByLabel(/country/i)

    // #408: all five are on the form, and each must be.
    for (const field of [streetField, cityField, stateField, postalCodeField, countryField]) await expect(field).toBeVisible()

    await dialog.getByRole('button', { name: /cancel/i }).click()
  })

  test('should create an employee in the dialog, and change it through either form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')
    await waitForDataTable(page)

    const firstName = uniqueName('Strict')
    const dialog = await clickCreate(page)
    await dialog.getByLabel(/first name/i).fill(firstName)
    await dialog.getByLabel(/last name/i).fill('Example')
    await dialog.getByRole('tab', { name: /employment/i }).click()
    await dialog.getByLabel(/employee (number|no)/i).fill(uniqueName('E'))
    await dialog.getByLabel(/department/i).fill('Sales')
    await dialog.getByLabel(/position/i).fill('Clerk')
    await dialog.getByLabel(/contract\s*start\s*date/i).fill('2026-01-15')

    const [created] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/payroll/employee') && r.request().method() === 'POST'),
      dialog.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    expect(created.status()).toBe(200)
    await expect(dialog).toBeHidden()
    const { employee } = await created.json()

    // The list's pencil: the same record in the dialog, and what is saved is what was typed.
    await page.goto('/payroll/employees?search=' + firstName)
    const row = page.locator('.v-data-table tbody tr', { hasText: employee.employeeNumber })
    await row.locator('.mdi-pencil').click()
    const edit = page.locator('.v-dialog')
    await expect(edit.getByLabel(/first name/i)).toHaveValue(firstName)
    await edit.getByLabel(/phone/i).fill('111')
    const [changed] = await Promise.all([
      page.waitForResponse(r => r.url().includes(`/payroll/employee/${employee._id}`) && r.request().method() === 'PUT'),
      edit.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    expect(changed.status()).toBe(200)

    // The routed form, which opened on nothing until it could load a record.
    await page.goto(`/payroll/employees/${employee._id}/edit`)
    await expect(page.getByLabel(/first name/i)).toHaveValue(firstName)
    await expect(page.getByLabel(/phone/i)).toHaveValue('111')
    await page.getByLabel(/phone/i).fill('222')
    const [routed] = await Promise.all([
      page.waitForResponse(r => r.url().includes(`/payroll/employee/${employee._id}`) && r.request().method() === 'PUT'),
      page.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    expect(routed.status()).toBe(200)
  })

  test('should display server-side pagination on employees table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/payroll/employees')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const info = await getPageInfo(page)
    expect(info).toBeTruthy()
  })
})
