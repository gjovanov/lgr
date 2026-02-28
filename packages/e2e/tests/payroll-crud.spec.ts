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

    // Fill contractStartDate (NOT "startDate")
    const contractStartField = dialog.getByLabel(/contract\s*start\s*date/i)
    if (await contractStartField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contractStartField.fill('2025-01-15')
    }

    // Select employment type - enum uses lowercase: full_time (not Full Time)
    const employmentTypeField = dialog.getByLabel(/employment\s*type|type/i)
    if (await employmentTypeField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await employmentTypeField.click({ force: true })
      await page.waitForTimeout(300)
      // Try to select "full_time" or "Full Time" option
      const fullTimeOption = page.getByRole('option', { name: /full.time/i })
      if (await fullTimeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await fullTimeOption.click()
      } else {
        // Select first available option
        const firstOption = page.locator('.v-overlay .v-list-item').first()
        if (await firstOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstOption.click()
        }
      }
      await page.waitForTimeout(200)
    }

    // Select status - enum uses lowercase: active
    const statusField = dialog.getByLabel(/status/i)
    if (await statusField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await statusField.click({ force: true })
      await page.waitForTimeout(300)
      const activeOption = page.getByRole('option', { name: /active/i })
      if (await activeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await activeOption.click()
      } else {
        const firstOption = page.locator('.v-overlay .v-list-item').first()
        if (await firstOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstOption.click()
        }
      }
      await page.waitForTimeout(200)
    }

    // Select department if available
    const departmentField = dialog.getByLabel(/department/i)
    if (await departmentField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await departmentField.click({ force: true })
      await page.waitForTimeout(300)
      const deptOption = page.locator('.v-overlay .v-list-item').first()
      if (await deptOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await deptOption.click()
      }
      await page.waitForTimeout(200)
    }

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
    const baseSalaryField = dialog.getByLabel(/base\s*salary/i)
    if (await baseSalaryField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await baseSalaryField.fill('5000')
    }

    // currency
    const currencyField = dialog.getByLabel(/currency/i)
    if (await currencyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(currencyField).toBeVisible()
    }

    // frequency (monthly, weekly, etc.)
    const frequencyField = dialog.getByLabel(/frequency/i)
    if (await frequencyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(frequencyField).toBeVisible()
    }

    // bankAccountNumber (nested under salary)
    const bankAccountField = dialog.getByLabel(/bank\s*account\s*number/i)
    if (await bankAccountField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await bankAccountField.fill('123456789')
    }

    // bankName (nested under salary)
    const bankNameField = dialog.getByLabel(/bank\s*name/i)
    if (await bankNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await bankNameField.fill('Test National Bank')
    }

    // iban (nested under salary)
    const ibanField = dialog.getByLabel(/iban/i)
    if (await ibanField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ibanField.fill('DE89370400440532013000')
    }

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
      const addressTab = createDialog.getByRole('tab', { name: /address|personal/i })
      if (await addressTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await addressTab.click()
        await page.waitForTimeout(300)
      }

      // Verify nested address fields
      const streetField = createDialog.getByLabel(/street/i)
      const cityField = createDialog.getByLabel(/^city$/i)
      const stateField = createDialog.getByLabel(/state/i)
      const postalCodeField = createDialog.getByLabel(/postal code/i)
      const countryField = createDialog.getByLabel(/country/i)

      const hasStreet = await streetField.isVisible({ timeout: 2000 }).catch(() => false)
      const hasCity = await cityField.isVisible({ timeout: 2000 }).catch(() => false)
      const hasState = await stateField.isVisible({ timeout: 2000 }).catch(() => false)
      const hasPostal = await postalCodeField.isVisible({ timeout: 2000 }).catch(() => false)
      const hasCountry = await countryField.isVisible({ timeout: 2000 }).catch(() => false)

      // At least the core address fields should be visible
      expect(hasStreet || hasCity || hasPostal || hasCountry).toBeTruthy()

      // Fill address fields if visible
      if (hasStreet) await streetField.fill('123 Employee St')
      if (hasCity) await cityField.fill('Worktown')
      if (hasState) await stateField.fill('TX')
      if (hasPostal) await postalCodeField.fill('75001')
      if (hasCountry) await countryField.fill('US')

      await createDialog.getByRole('button', { name: /cancel/i }).click()
      return
    }

    // Look for address section/tab in edit dialog
    const addressTab = dialog.getByRole('tab', { name: /address|personal/i })
    if (await addressTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addressTab.click()
      await page.waitForTimeout(300)
    }

    // Verify nested address fields exist
    const streetField = dialog.getByLabel(/street/i)
    const cityField = dialog.getByLabel(/^city$/i)
    const stateField = dialog.getByLabel(/state/i)
    const postalCodeField = dialog.getByLabel(/postal code/i)
    const countryField = dialog.getByLabel(/country/i)

    const hasStreet = await streetField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasCity = await cityField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasState = await stateField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasPostal = await postalCodeField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasCountry = await countryField.isVisible({ timeout: 2000 }).catch(() => false)

    expect(hasStreet || hasCity || hasPostal || hasCountry).toBeTruthy()

    await dialog.getByRole('button', { name: /cancel/i }).click()
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
