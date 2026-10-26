import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * Assert the form offers a warehouse selector.
 *
 * ⚠ Not a table column any more. Since 2026-07-26 the `warehouse` line-item column defaults
 * OFF and `DocumentLineTable.vue` renders a DOC-LEVEL autocomplete above the table instead
 * (`v-if="!isColActive('warehouse')"`). A user can switch the column back on through the
 * column picker, so both shapes are legitimate — what the specs care about is that the form
 * offers a warehouse at all.
 */
export async function expectWarehouseSelector(page: Page): Promise<void> {
  const docLevel = page.getByRole('combobox', { name: /warehouse/i })
  const columnHeader = page.locator('.v-table th').filter({ hasText: /warehouse/i })
  await expect(docLevel.or(columnHeader).first()).toBeVisible()
}

/**
 * The unit-price control on a document line row.
 *
 * ⚠ Not `input[type="number"]).nth(1)`, which is what every invoicing spec used. Unit price
 * became a `PriceCombobox` (the price-select feature, 2026-07-26) — a `role="combobox"` text
 * input, not a number field. A line row now carries exactly ONE `input[type=number]`, the
 * quantity, so `.nth(1)` matches nothing and `fill()` times out at 10s against a row that is
 * on screen and looks entirely normal.
 *
 * `.last()` rather than a fixed index because `unit` is a combobox too and both it and the
 * price column can be switched off in the column picker; the price is always the rightmost.
 */
export function lineUnitPrice(row: Locator): Locator {
  return row.locator('input[role="combobox"]').last()
}

/** The quantity field on a document line row — still the row's only number input. */
export function lineQuantity(row: Locator): Locator {
  return row.locator('input[type="number"]').first()
}

/**
 * The description cell on a document line row — where the product search lives.
 *
 * ⚠ Not `row.locator('td').first()`, which is what the autocomplete specs used. Since
 * 2026-10-08 every line opens with a `td.line-no` cell holding its number, so the first cell
 * has no input and `fill()` waits out its timeout on a row that looks entirely normal.
 */
export function lineDescription(row: Locator): Locator {
  return row.locator('td.line-no + td')
}

/**
 * Each line of the open document form as one string — its text and its fields' values. A line with
 * no product holds its description in a field, which a text match never sees.
 */
export async function lineValues(page: Page): Promise<string[]> {
  return page.locator('.line-table tbody tr').evaluateAll((rows) => rows.map((r) =>
    [r.textContent || '', ...Array.from(r.querySelectorAll('input, textarea')).map((i) => (i as HTMLInputElement).value)].join(' | ')))
}
