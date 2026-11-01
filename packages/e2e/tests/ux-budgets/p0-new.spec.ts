import { test, expect } from '@playwright/test'
import { startWalk } from '../helpers/ux-budget'

/**
 * P0-new — from wherever the person is, a blank daily document in another app (FR-22.49).
 *
 * „+ Нов" sits in every app's top bar. Each leg starts on a page of one app and ends on the new
 * form of a document that lives in a different one (the till's leg stays inside Invoicing, where
 * the till lives now); the budget is ≤ 2 clicks (FR-22 §3). On a desktop the menu opens on hover
 * (FR-05), so a leg costs one click, and the recorder counts a second when hover did not open it.
 * Crossing apps is a page load, which the leg records.
 *
 * Nothing is saved, so the walk needs no data of its own.
 */

const LEGS = [
  { id: 'P0-new-inventory', from: 'Продукти', start: '/inventory/products', entry: 'Изходяща фактура', url: /\/invoicing\/invoices\/new$/ },
  { id: 'P0-new-invoicing', from: 'Документи за продажба', start: '/invoicing/invoices', entry: 'Стокова разписка', url: /\/inventory\/movements\/new$/ },
  { id: 'P0-new-pos', from: 'Каса', start: '/invoicing/cash-sales/new', entry: 'Поръчка от клиент', url: /\/invoicing\/internal-orders\/new$/ },
]

for (const leg of LEGS) {
  test(`${leg.id}: from ${leg.start} to a new „${leg.entry}"`, async ({ page }, testInfo) => {
    const walk = await startWalk(page, testInfo, {
      id: leg.id,
      title: `From ${leg.from} (${leg.start}) to a new „${leg.entry}" in another app, through „+ Нов"`,
      start: leg.start,
    })
    await walk.shot('start')

    await walk.menu('Нов', leg.entry)
    await page.waitForURL(leg.url)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    await walk.shot('new-form')

    const result = walk.finish()
    expect(result.clicks, result.trail.join('\n')).toBeLessThanOrEqual(2)
    expect(result.typed).toBe(0)
    expect(result.hops).toBeLessThanOrEqual(1)
  })
}
