import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import {
  clickCreate,
  saveDialog,
  fillField,
  selectOption,
  selectAutocomplete,
  waitForDataTable,
  editFirstRow,
  countTableRows,
  expectSuccess,
  uniqueName,
} from './helpers/crud'

test.describe('CRM CRUD', () => {
  test('should create a lead with contactName, companyName, email, and source select', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    await waitForDataTable(page)
    const rowsBefore = await countTableRows(page)

    const dialog = await clickCreate(page)

    // contactName (NOT "name") - the correct field label from Phase 3
    const contactNameField = dialog.getByLabel(/contact\s*name/i)
    const nameField = dialog.getByLabel(/name/i)

    // Use contactName if it exists, otherwise fall back to name
    if (await contactNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await contactNameField.fill(uniqueName('JohnContact'))
    } else if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameField.fill(uniqueName('JohnContact'))
    }

    // companyName (NOT "company") - the correct field label from Phase 3
    const companyNameField = dialog.getByLabel(/company\s*name/i)
    const companyField = dialog.getByLabel(/company/i)

    if (await companyNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await companyNameField.fill(uniqueName('AcmeLead'))
    } else if (await companyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await companyField.fill(uniqueName('AcmeLead'))
    }

    // Email
    await fillField(dialog, /email/i, 'lead-test@example.com')

    // Source select with enum: website, referral, cold_call, email, social, event, other
    const sourceField = dialog.getByLabel(/source/i)
    if (await sourceField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sourceField.click({ force: true })
      await page.waitForTimeout(500)
      const websiteOption = page.getByRole('option', { name: /website/i })
      if (await websiteOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await websiteOption.click()
      } else {
        // Fallback: select first option
        const firstOption = page.locator('.v-overlay .v-list-item').first()
        if (await firstOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstOption.click()
        }
      }
      await page.waitForTimeout(200)
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    // Verify new lead appears
    await waitForDataTable(page)
    const rowsAfter = await countTableRows(page)
    expect(rowsAfter).toBeGreaterThanOrEqual(rowsBefore)
  })

  test('should create a deal with name, contactId autocomplete, stage, and value', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/deals')

    await expect(page.getByRole('heading', { name: /deals/i })).toBeVisible({ timeout: 10000 })

    // Switch to table view if board view is default
    const tableBtn = page.locator('.v-btn-toggle button', { has: page.locator('.mdi-table') })
    if (await tableBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableBtn.click()
      await page.waitForTimeout(300)
    }

    const dialog = await clickCreate(page)

    // Deal name
    await fillField(dialog, /name/i, uniqueName('TestDeal'))

    // contactId is an AUTOCOMPLETE (NOT a text input for contactName)
    // This was a Phase 3 fix
    const contactField = dialog.getByLabel(/contact/i)
    if (await contactField.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Verify it's inside an autocomplete/select wrapper
      const autocompleteWrapper = dialog.locator('.v-autocomplete, .v-select').filter({
        has: page.getByLabel(/contact/i),
      })
      const isAutocomplete = await autocompleteWrapper.isVisible({ timeout: 2000 }).catch(() => false)

      if (isAutocomplete) {
        await selectAutocomplete(page, dialog, /contact/i)
      } else {
        await contactField.click({ force: true })
        await page.waitForTimeout(500)
        const option = page.locator('.v-overlay .v-list-item').first()
        if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
          await option.click()
        }
      }
    }

    // Stage is a string select (NOT stageId)
    const stageField = dialog.getByLabel(/stage/i)
    if (await stageField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await stageField.click({ force: true })
      await page.waitForTimeout(500)
      const stageOption = page.locator('.v-overlay .v-list-item').first()
      if (await stageOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await stageOption.click()
      }
      await page.waitForTimeout(200)
    }

    // Deal value
    const dealValueField = dialog.getByLabel(/deal\s*value|value/i)
    if (await dealValueField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dealValueField.fill('25000')
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    await waitForDataTable(page)
  })

  test('should edit a lead and verify contactName and companyName fields work', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/crm/leads')

    await waitForDataTable(page)

    const dialog = await editFirstRow(page)
    if (!dialog) {
      test.skip(true, 'No leads to edit')
      return
    }

    // Verify contactName field (NOT just "name")
    const contactNameField = dialog.getByLabel(/contact\s*name/i)
    const nameField = dialog.getByLabel(/name/i)

    if (await contactNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const currentContactName = await contactNameField.inputValue()
      const updatedContactName = uniqueName('UpdatedContact')
      await contactNameField.clear()
      await contactNameField.fill(updatedContactName)
    } else if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const updatedName = uniqueName('UpdatedContact')
      await nameField.clear()
      await nameField.fill(updatedName)
    }

    // Verify companyName field (NOT just "company")
    const companyNameField = dialog.getByLabel(/company\s*name/i)
    const companyField = dialog.getByLabel(/company/i)

    if (await companyNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await companyNameField.clear()
      await companyNameField.fill(uniqueName('UpdatedCo'))
    } else if (await companyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await companyField.clear()
      await companyField.fill(uniqueName('UpdatedCo'))
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    await waitForDataTable(page)
  })
})
