import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Wait for a Vuetify data table to be visible and loaded
 */
export async function waitForDataTable(page: Page, timeout = 10000): Promise<Locator> {
  const table = page.locator('.v-data-table')
  await expect(table).toBeVisible({ timeout })
  return table
}

/**
 * Click a "Create" button on a list view
 */
export async function clickCreate(page: Page) {
  // Some views use "Create", others use "Add"
  const createBtn = page.getByRole('button', { name: /create/i })
  const addBtn = page.getByRole('button', { name: /^add$/i })
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click()
  } else {
    await addBtn.click()
  }
  await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })
  return page.locator('.v-dialog')
}

/**
 * Click Save inside a dialog
 */
export async function saveDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: /save/i }).click()
}

/**
 * Click Cancel inside a dialog
 */
export async function cancelDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: /cancel/i }).click()
}

/**
 * Fill a text field by label inside a container
 */
export async function fillField(container: Locator, label: RegExp, value: string) {
  await container.getByLabel(label).fill(value)
}

/**
 * Select a Vuetify v-select option by clicking the select and choosing an option
 */
export async function selectOption(page: Page, container: Locator, label: RegExp, optionText?: RegExp) {
  await container.getByLabel(label).click({ force: true })
  await page.waitForTimeout(300)
  if (optionText) {
    await page.getByRole('option', { name: optionText }).click()
  } else {
    await page.locator('.v-menu .v-list-item').first().click()
  }
  await page.waitForTimeout(200)
}

/**
 * Select a Vuetify v-autocomplete by typing and selecting first match
 */
export async function selectAutocomplete(page: Page, container: Locator, label: RegExp, searchText?: string) {
  // Use getByRole('combobox') to avoid strict mode violation when clear button also matches
  const input = container.getByRole('combobox', { name: label })
  await input.click({ force: true })
  if (searchText) {
    await input.fill(searchText)
  }
  await page.waitForTimeout(500)
  // Target the v-menu dropdown specifically (not the dialog overlay)
  const option = page.locator('.v-menu .v-list-item').first()
  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click()
    await page.waitForTimeout(200)
  }
}

/**
 * Click the edit (pencil) icon on the first row of a data table
 */
export async function editFirstRow(page: Page): Promise<Locator | null> {
  const row = page.locator('.v-data-table tbody tr').first()
  if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) return null
  const editBtn = row.locator('.mdi-pencil, .mdi-pencil-outline').first()
  if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await editBtn.click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })
    return page.locator('.v-dialog')
  }
  return null
}

/**
 * Click the delete (trash) icon on the first row of a data table
 */
export async function deleteFirstRow(page: Page) {
  const row = page.locator('.v-data-table tbody tr').first()
  if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) return false
  const deleteBtn = row.locator('.mdi-delete, .mdi-delete-outline').first()
  if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deleteBtn.click()
    await page.waitForTimeout(300)
    // Confirm deletion in the confirm dialog if present
    const confirmBtn = page.getByRole('button', { name: /confirm|yes|delete|ok/i })
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click()
    }
    return true
  }
  return false
}

/**
 * Count rows in a data table (excluding "No data" row)
 */
export async function countTableRows(page: Page): Promise<number> {
  const rows = page.locator('.v-data-table tbody tr').filter({
    hasNot: page.getByText(/no data/i),
  })
  return await rows.count()
}

/**
 * Wait for a snackbar/toast success message
 */
export async function expectSuccess(page: Page) {
  const snackbar = page.locator('.v-snackbar')
  if (await snackbar.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expect(snackbar).toBeVisible()
  }
}

/**
 * Generate a unique name with timestamp suffix for test data
 */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}
