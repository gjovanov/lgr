import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { expectPaginatedTable, getPageInfo, waitForTableLoaded } from './helpers/pagination'
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

test.describe('Accounting CRUD', () => {
  test('should create a bank account with bankName, swift, iban, and accountId autocomplete', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/bank-accounts')

    await waitForDataTable(page)
    const rowsBefore = await countTableRows(page)

    const dialog = await clickCreate(page)

    // Fill bank name (label: "Bank" from $t('accounting.bank'))
    await fillField(dialog, /^bank$/i, uniqueName('TestBank'))

    // Fill name
    const nameField = dialog.getByLabel(/^name$/i)
    if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameField.fill(uniqueName('BankAcct'))
    }

    // Fill SWIFT code (label: "SWIFT" from $t('accounting.swift'))
    const swiftField = dialog.getByLabel(/swift/i)
    if (await swiftField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await swiftField.fill('TESTUS33')
    }

    // Fill IBAN (label: "IBAN" from $t('accounting.iban'))
    const ibanField = dialog.getByLabel(/iban/i)
    if (await ibanField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ibanField.fill('DE89370400440532013000')
    }

    // ⚠ Account Number and Currency are REQUIRED (`:rules="[rules.required]"` in
    // BankAccountFormView) and this test never filled them, so validation silently blocked
    // every save. Nothing was created, and the assertions were weak enough not to notice.
    const accountNumberField = dialog.getByLabel(/account\s*number/i)
    if (await accountNumberField.isVisible({ timeout: 2000 }).catch(() => false)) {
      // ⚠ Unique per run: accountNumber is unique per org, so a fixed value saves once and
      // then silently fails on every later run against the same database.
      await accountNumberField.fill(uniqueName('ACC').replace(/[^0-9a-z]/gi, '').slice(-12))
    }

    // Select linked account via autocomplete (label: "Linked Account" from $t('accounting.linkedAccount'))
    const linkedAcctField = dialog.getByLabel(/linked\s*account/i)
    if (await linkedAcctField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await selectAutocomplete(page, dialog, /linked\s*account/i)
    }

    const currencyField = dialog.getByLabel(/^currency$/i)
    if (await currencyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await currencyField.fill('EUR')
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    // ⚠ Bank accounts create through a ROUTED form now and saving leaves you on it, so the
    // table assertion has to return to the list first.
    await page.goto('/accounting/bank-accounts')
    await waitForDataTable(page)
    // Strictly greater: >= is satisfied by 0 >= 0, which is exactly how this test passed
    // for weeks while creating nothing.
    const rowsAfter = await countTableRows(page)
    expect(rowsAfter).toBeGreaterThan(rowsBefore)
  })

  test('should edit a bank account and update bankName', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/bank-accounts')

    await waitForDataTable(page)

    const dialog = await editFirstRow(page)
    if (!dialog) {
      test.skip(true, 'No bank accounts to edit')
      return
    }

    const updatedName = uniqueName('UpdatedBank')
    // Clear and fill bank field (label: "Bank" from $t('accounting.bank'))
    const bankNameField = dialog.getByLabel(/^bank$/i)
    await bankNameField.clear()
    await bankNameField.fill(updatedName)

    await saveDialog(dialog)
    await expectSuccess(page)

    // Verify the updated name appears in the table
    await waitForDataTable(page)
    await expect(page.locator('.v-data-table').getByText(updatedName)).toBeVisible({ timeout: 5000 })
  })

  test('should preserve subType and description when editing an account', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts')

    await waitForDataTable(page)

    // Edit the first account row
    const dialog = await editFirstRow(page)
    if (!dialog) {
      test.skip(true, 'No accounts to edit')
      return
    }

    // Verify subType field is present and has a value
    const subTypeField = dialog.getByLabel(/sub\s*type/i)
    if (await subTypeField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const subTypeValue = await subTypeField.inputValue()

      // Verify description field is present
      const descField = dialog.getByLabel(/description/i)
      const descValue = await descField.isVisible({ timeout: 2000 }).catch(() => false)
        ? await descField.inputValue()
        : ''

      // Save without changes
      await saveDialog(dialog)
      await expectSuccess(page)

      // Re-open the same row and verify values are preserved
      const reopened = await editFirstRow(page)
      if (reopened) {
        const subTypeAfter = reopened.getByLabel(/sub\s*type/i)
        if (await subTypeAfter.isVisible({ timeout: 2000 }).catch(() => false)) {
          await expect(subTypeAfter).toHaveValue(subTypeValue)
        }

        if (descValue) {
          const descAfter = reopened.getByLabel(/description/i)
          if (await descAfter.isVisible({ timeout: 2000 }).catch(() => false)) {
            await expect(descAfter).toHaveValue(descValue)
          }
        }

        // A routed form has Back, not Cancel — and this only leaves the screen after the
        // assertions above, so navigating away is shape-independent.
        await page.goto('/accounting/accounts')
      }
    } else {
      // subType may be a select; just verify the form loaded.
      await page.goto('/accounting/accounts')
    }
  })

  test('should delete a bank account', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/bank-accounts')

    await waitForDataTable(page)
    const rowsBefore = await countTableRows(page)

    if (rowsBefore === 0) {
      test.skip(true, 'No bank accounts to delete')
      return
    }

    const deleted = await deleteFirstRow(page)
    expect(deleted).toBeTruthy()

    await expectSuccess(page)

    // Verify row count decreased
    await page.waitForTimeout(500)
    const rowsAfter = await countTableRows(page)
    expect(rowsAfter).toBeLessThan(rowsBefore)
  })

  test('should display server-side pagination on bank accounts table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/bank-accounts')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const info = await getPageInfo(page)
    expect(info).toBeTruthy()
  })
})
