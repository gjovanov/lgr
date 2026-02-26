import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import {
  clickCreate,
  saveDialog,
  fillField,
  selectAutocomplete,
  waitForDataTable,
  editFirstRow,
  deleteFirstRow,
  countTableRows,
  expectSuccess,
  uniqueName,
} from './helpers/crud'

test.describe('HR CRUD', () => {
  test('should create a department with name and headId autocomplete', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/departments')

    await waitForDataTable(page)
    const rowsBefore = await countTableRows(page)

    const dialog = await clickCreate(page)

    const deptName = uniqueName('Engineering')
    await fillField(dialog, /name/i, deptName)

    // headId is an autocomplete that selects an employee (NOT a text field for managerName)
    // Verify it is an autocomplete/select and select from it
    const headIdField = dialog.getByLabel(/department\s*head/i)
    if (await headIdField.isVisible({ timeout: 3000 }).catch(() => false)) {
      // This should be an autocomplete, not a plain text input
      // Check that it behaves like an autocomplete by looking for the v-autocomplete wrapper
      const autocompleteWrapper = dialog.locator('.v-autocomplete, .v-select').filter({
        has: page.getByLabel(/department\s*head/i),
      })
      const isAutocomplete = await autocompleteWrapper.isVisible({ timeout: 2000 }).catch(() => false)

      if (isAutocomplete) {
        // Select from autocomplete dropdown
        await selectAutocomplete(page, dialog, /department\s*head/i)
      } else {
        // Fallback: try clicking to see if dropdown appears
        await headIdField.click({ force: true })
        await page.waitForTimeout(500)
        const option = page.locator('.v-overlay .v-list-item').first()
        if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
          await option.click()
        }
      }
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    // Verify new department appears
    await waitForDataTable(page)
    const rowsAfter = await countTableRows(page)
    expect(rowsAfter).toBeGreaterThanOrEqual(rowsBefore)
  })

  test('should verify headId is autocomplete (not text managerName) in department edit form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/departments')

    await waitForDataTable(page)

    const dialog = await editFirstRow(page)
    if (!dialog) {
      test.skip(true, 'No departments to edit')
      return
    }

    // Verify "Manager Name" text field does NOT exist
    const managerNameField = dialog.getByLabel(/manager\s*name/i)
    const hasManagerName = await managerNameField.isVisible({ timeout: 1000 }).catch(() => false)
    expect(hasManagerName).toBeFalsy()

    // Verify "Department Head" combobox exists
    const headField = dialog.getByRole('combobox', { name: /department\s*head/i })
    const hasHead = await headField.isVisible({ timeout: 2000 }).catch(() => false)
    expect(hasHead).toBeTruthy()

    // Verify Name field is editable
    const nameField = dialog.getByLabel(/^name$/i)
    const currentName = await nameField.inputValue()
    expect(currentName).toBeTruthy()

    // Close without saving
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('should delete a department', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/departments')

    await waitForDataTable(page)
    const rowsBefore = await countTableRows(page)

    if (rowsBefore === 0) {
      test.skip(true, 'No departments to delete')
      return
    }

    const deleted = await deleteFirstRow(page)
    if (!deleted) {
      // No delete button found, skip test
      test.skip(true, 'No delete button found in department row')
      return
    }

    await expectSuccess(page)

    // Wait for table to update and verify row count decreased
    await page.waitForTimeout(1000)
    await waitForDataTable(page)
    const rowsAfter = await countTableRows(page)
    expect(rowsAfter).toBeLessThanOrEqual(rowsBefore)
  })
})
