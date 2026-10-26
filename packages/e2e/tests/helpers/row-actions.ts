import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * The list row of the document numbered `number`. ⚠ Not `hasText`: a draft's number contains the
 * issued number of another document — `DRF-INV-2026-00002` holds `INV-2026-00002` — so a text
 * match finds both rows. The number cell is a link named exactly the number.
 */
export function rowOf(page: Page, number: string): Locator {
  return page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })
}

/**
 * The list rows whose status chip reads `status` — a plain word, „Draft". ⚠ Not `hasText` on the
 * row: a row's text runs its cells together („…€120.00Draft"), so even a word-boundary pattern
 * misses. And a RegExp `hasText` sees the chip's raw text, padding included, hence the `\s*`.
 */
export function rowsWithStatus(page: Page, status: string): Locator {
  const label = new RegExp(String.raw`^\s*` + status + String.raw`\s*$`, 'i')
  return page.locator('.v-data-table tbody tr').filter({ has: page.locator('.v-chip').filter({ hasText: label }) })
}

/**
 * FR-22.23: a document list row keeps its actions in ONE ⋮ menu (`ui-shared/RowActionsMenu`), so a
 * row no longer carries an icon per action (`.mdi-send`, `.mdi-cancel`, `.mdi-package-down`…).
 *
 * Opens the row's menu and returns the item for `key` — its `data-testid` is `row-action-<key>`:
 * `open`, `issue` (`receive` on a bill), `print`, `payment`, `email`, `credit-note`, `debit-note`,
 * `copy`, `convert`, `void`, `delete`. ⚠ The menu renders in an overlay at the end of `<body>`,
 * never inside the row, which is why the lookup is page-level.
 */
export async function rowAction(row: Locator, key: string): Promise<Locator> {
  const page = row.page()
  await row.getByTestId('row-actions').click()
  const list = page.getByTestId('row-actions-list').filter({ visible: true }).last()
  await expect(list).toBeVisible()
  return list.getByTestId(`row-action-${key}`)
}

/** Whether the row's menu offers `key`. Leaves the menu closed. */
export async function rowOffers(row: Locator, key: string): Promise<boolean> {
  const item = await rowAction(row, key)
  const offered = await item.isVisible().catch(() => false)
  await row.page().keyboard.press('Escape')
  await expect(row.page().getByTestId('row-actions-list').filter({ visible: true })).toHaveCount(0)
  return offered
}
