import type { Page, Locator } from '@playwright/test'
import { appears } from './vuetify'
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
  if (await appears(info, 3000)) {
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
  if (await appears(nextBtn, 3000)) {
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
  if (await appears(prevBtn, 3000)) {
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
  if (await appears(perPageSelect, 3000)) {
    await perPageSelect.click()
    await page.waitForTimeout(300)
    const option = page.getByRole('option', { name: String(perPage) })
    if (await appears(option, 3000)) {
      await option.click()
      await page.waitForTimeout(500)
      return true
    }
  }
  return false
}

/**
 * Wait for the table loading state to finish
 *
 * ⚠ Not `isVisible({ timeout })`: it does not wait (#408). It answered for the first
 * instant only, so a table whose load had not finished passed straight through, and a
 * row count after it read Vuetify's "Loading items…" row as data (#454). These are
 * retrying assertions: Vuetify renders `v-data-table-progress` (the header bar) and
 * `v-data-table-rows-loading` (the body row of an empty table) only while it loads.
 */
export async function waitForTableLoaded(page: Page, timeout = 10000) {
  await expect(page.locator('.v-data-table-progress, .v-data-table-rows-loading')).toHaveCount(0, { timeout })
  await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout })
  await page.waitForTimeout(300)
}

/**
 * Click a column header to trigger server-side sorting
 */
export async function sortByColumn(page: Page, columnText: RegExp) {
  const header = page.locator('.v-data-table thead th').filter({
    hasText: columnText,
  })
  if (await appears(header, 3000)) {
    await header.click()
    await waitForTableLoaded(page)
    return true
  }
  return false
}
