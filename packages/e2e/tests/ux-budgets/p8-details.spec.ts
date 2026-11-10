import { test, expect } from '@playwright/test'
import { startWalk } from '../helpers/ux-budget'

/**
 * P8 — Invoice: three articles added through „Details" (FR-28.23, .28).
 *
 * A counter sale needs three articles and the user knows them by looking: they open the product dialog, which
 * is the Products list in a window, tick three rows and add them. Each lands on a line of its own through the
 * line's own after-pick logic (price, unit, tax), in the order ticked.
 *
 * Today's number, measured on the build before FR-28 slice 3 with the same three rows: the dialog took ONE
 * article, so each article was a trip — open it from the line, click the row, it closed: 6 clicks, 0 typed,
 * 3 dialogs. Through the multi-select: 5 clicks, 0 typed, 1 dialog.
 *
 * Starts on a new invoice (reaching it is setup and is not counted).
 */

/** FR-28 §6: P8 ≤ 8 clicks · 0 typed · 1 dialog. */
const BUDGET = { clicks: 8, typed: 0, dialogs: 1 }

test('P8 details: three articles added to an invoice through the product dialog', async ({ page }, testInfo) => {
  const walk = await startWalk(page, testInfo, {
    id: 'P8',
    title: 'Invoice — three articles added through „Details"',
    start: '/invoicing/invoices/new',
  })
  const table = page.locator('.line-table').first()
  const dialog = page.getByTestId('product-picker')
  const rows = dialog.locator('.picker-table tbody tr')

  // ── 1. Open „Details" from the first line ──
  await walk.click(table.locator('tbody tr').first().getByTestId('product-details'), 'open „Details" on the first line')
  walk.dialog('the product dialog')
  await expect(rows.first()).toBeVisible({ timeout: 10000 })
  await walk.shot('dialog-open')

  // ── 2. Tick three articles (the first three rows of the page: the user knows them by looking) ──
  const names: string[] = []
  for (let i = 0; i < 3; i++) {
    names.push((await rows.nth(i).locator('td').nth(2).innerText()).trim())
    await walk.click(rows.nth(i), `tick the article in row ${i + 1}`)
  }
  // The walks run in Bulgarian: the count, not the words.
  await expect(page.getByTestId('product-picker-selected')).toContainText('3')

  // ── 3. Add them ──
  await walk.click(page.getByTestId('product-picker-add'), 'press „Add 3 articles"')
  await expect(dialog).toBeHidden()

  // Three lines hold the three articles, in the order ticked, and a blank line waits after them.
  const values = async () => table.locator('tbody tr td.line-no + td input').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
  await expect.poll(async () => (await values()).filter(Boolean).length, { timeout: 10000 }).toBe(3)
  const held = (await values()).filter(Boolean)
  walk.note(`Lines: ${held.join(' | ')}`)
  expect(held).toEqual(names)
  expect((await values()).length, 'a blank line waits after the three').toBeGreaterThanOrEqual(4)

  const result = walk.finish()

  // ── FR-28 §6 budget for P8 ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.dialogs).toBeLessThanOrEqual(BUDGET.dialogs)
  expect(result.hops).toBe(0)
})
