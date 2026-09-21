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
 * Start creating a record from a list view, and return the scope the form lives in.
 *
 * ⚠ Not every list opens a dialog any more. Warehouses (and products) create through a ROUTE
 * — `responsive-btn :to="{ name: '…new' }"` renders an `<a>`, which has role `link`, so
 * `getByRole('button', { name: /create/i })` does not match it at all. This helper used to
 * fall through to an `/^add$/i` button that also does not exist and then waited 10s for a
 * `.v-dialog` that was never going to appear.
 *
 * Returns the dialog where there is one, otherwise the routed form — so callers can scope
 * their field lookups the same way in both cases.
 */
export async function clickCreate(page: Page): Promise<Locator> {
  const createLink = page.locator('a.v-btn[href$="/new"]').filter({ visible: true }).first()
  const createBtn = page.getByRole('button', { name: /create/i }).filter({ visible: true }).first()
  const addBtn = page.getByRole('button', { name: /^add$/i }).filter({ visible: true }).first()

  if (await createLink.count()) await createLink.click()
  else if (await createBtn.count()) await createBtn.click()
  else await addBtn.click()

  const dialog = page.locator('.v-dialog')
  const routedForm = page.locator('.entity-form-shell, form').first()
  await expect(dialog.or(routedForm).first()).toBeVisible({ timeout: 10000 })

  return (await dialog.isVisible().catch(() => false)) ? dialog : routedForm
}

/**
 * Click Save on a dialog or a routed form.
 *
 * ⚠ On EntityFormShell the Save button sits in the shell's actions bar, OUTSIDE the `<form>`
 * element, so a scoped lookup finds nothing. Falls back to the page-level Save for that case.
 */
export async function saveDialog(scope: Locator) {
  const scoped = scope.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first()
  if (await scoped.count()) {
    await scoped.click()
    return
  }
  await scope.page().getByRole('button', { name: /^save$/i }).filter({ visible: true }).first().click()
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
/**
 * Open the first row for editing, and return the scope its form lives in.
 *
 * ⚠ Same split as `clickCreate`: some lists still edit in a `.v-dialog`, others (warehouses,
 * products) navigate to a routed form. This used to wait 5s for a `.v-dialog` that never
 * appears on the routed ones and then return null, which callers read as "nothing to edit"
 * and quietly skipped — so the test reported success while exercising nothing.
 *
 * Returns null only when there genuinely is no row to edit.
 */
export async function editFirstRow(page: Page): Promise<Locator | null> {
  const row = page.locator('.v-data-table tbody tr').first()
  if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) return null

  // A routed edit renders an <a href=".../edit">; a dialog edit renders a pencil button.
  const editLink = row.locator('a[href*="/edit"]').first()
  const editBtn = row.locator('.mdi-pencil, .mdi-pencil-outline').first()

  if (await editLink.count()) await editLink.click()
  else if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) await editBtn.click()
  else return null

  const dialog = page.locator('.v-dialog')
  const routedForm = page.locator('.entity-form-shell, form').first()
  await expect(dialog.or(routedForm).first()).toBeVisible({ timeout: 10000 })

  return (await dialog.isVisible().catch(() => false)) ? dialog : routedForm
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
