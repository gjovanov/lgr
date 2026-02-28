import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Verify that a server-side data table has a pagination footer with page info
 */
export async function expectPaginatedTable(page: Page, timeout = 10000) {
  const table = page.locator('.v-data-table-server, .v-data-table')
  await expect(table).toBeVisible({ timeout })

  // Vuetify data-table-server renders pagination in the footer
  const footer = page.locator('.v-data-table-footer')
  await expect(footer).toBeVisible({ timeout: 5000 })

  return table
}

/**
 * Get the current page info text from the table footer (e.g. "1-10 of 25")
 */
export async function getPageInfo(page: Page): Promise<string> {
  const info = page.locator('.v-data-table-footer__info')
  if (await info.isVisible({ timeout: 3000 }).catch(() => false)) {
    return (await info.textContent()) || ''
  }
  return ''
}

/**
 * Get the current number of rows in the table body
 */
export async function getVisibleRowCount(page: Page): Promise<number> {
  const rows = page.locator('.v-data-table tbody tr').filter({
    hasNot: page.getByText(/no data/i),
  })
  return rows.count()
}

/**
 * Click the "next page" button in the pagination footer
 */
export async function goToNextPage(page: Page) {
  const nextBtn = page.locator('.v-data-table-footer .v-btn').filter({
    has: page.locator('.mdi-chevron-right'),
  })
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const isDisabled = await nextBtn.isDisabled()
    if (!isDisabled) {
      await nextBtn.click()
      await page.waitForTimeout(500)
      return true
    }
  }
  return false
}

/**
 * Click the "previous page" button in the pagination footer
 */
export async function goToPreviousPage(page: Page) {
  const prevBtn = page.locator('.v-data-table-footer .v-btn').filter({
    has: page.locator('.mdi-chevron-left'),
  })
  if (await prevBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const isDisabled = await prevBtn.isDisabled()
    if (!isDisabled) {
      await prevBtn.click()
      await page.waitForTimeout(500)
      return true
    }
  }
  return false
}

/**
 * Change the items-per-page selector in the table footer
 */
export async function changeItemsPerPage(page: Page, perPage: number) {
  const perPageSelect = page.locator('.v-data-table-footer .v-select, .v-data-table-footer .v-field')
  if (await perPageSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
    await perPageSelect.click()
    await page.waitForTimeout(300)
    const option = page.getByRole('option', { name: String(perPage) })
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option.click()
      await page.waitForTimeout(500)
      return true
    }
  }
  return false
}

/**
 * Wait for the table loading state to finish
 */
export async function waitForTableLoaded(page: Page) {
  // Wait for the loading indicator to disappear
  const loading = page.locator('.v-data-table .v-progress-linear')
  if (await loading.isVisible({ timeout: 1000 }).catch(() => false)) {
    await loading.waitFor({ state: 'hidden', timeout: 10000 })
  }
  await page.waitForTimeout(300)
}

/**
 * Click a column header to trigger server-side sorting
 */
export async function sortByColumn(page: Page, columnText: RegExp) {
  const header = page.locator('.v-data-table thead th').filter({
    hasText: columnText,
  })
  if (await header.isVisible({ timeout: 3000 }).catch(() => false)) {
    await header.click()
    await waitForTableLoaded(page)
    return true
  }
  return false
}
