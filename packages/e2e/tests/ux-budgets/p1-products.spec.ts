import { test, expect } from '@playwright/test'
import { startWalk } from '../helpers/ux-budget'

/**
 * P1 — Products. The job: find an article, see its stock (and what is reserved or on order),
 * change its selling price.
 *
 * Products used: PRD-0011..0015 (the inventory walks' share of the acme-corp seed).
 */
test('P1 products: find an article, check its stock, change its selling price', async ({ page }, testInfo) => {
  const walk = await startWalk(page, testInfo, {
    id: 'P1',
    title: 'Products — find an article, check stock, change its selling price',
    start: '/inventory/products',
  })
  await walk.shot('list')

  await walk.type(page.getByRole('textbox', { name: /Търсене/ }), 'Product 12', 'search for the article')
  const row = page.locator('tbody tr').filter({ hasText: 'PRD-0012' })
  await expect(row).toBeVisible()
  await walk.shot('found')

  // The row's stock badges give quantity per warehouse; nothing on the list says reserved or on order.
  const rowText = (await row.innerText()).toLowerCase()
  if (!/резерв|поръчан|очаква/.test(rowText)) walk.note('List row: no reserved or on-order figure (#203.8, #4.5).')

  await walk.click(row.getByRole('link', { name: /Product 12/ }), 'open the article')
  await page.waitForURL(/\/products\/[^/]+\/edit/)

  // The edit tab holds SKU, name, barcode and description; prices live on the „Цени" tab.
  await walk.click(page.getByRole('tab', { name: /^Цени$/ }), 'open the prices tab')
  await page.waitForURL(/\/pricing$/)
  const selling = page.getByLabel(/Продажна цена/).first()
  await expect(selling).toBeVisible()
  await walk.fill(selling, '115', 'new selling price')
  await walk.click(page.getByRole('button', { name: /Запази/ }).first(), 'save')
  await expect(page.locator('.v-snackbar')).toBeVisible()
  await walk.shot('saved')
  const afterSave = page.url()
  if (!/\/products\/[^/]+\/pricing$/.test(afterSave)) walk.note(`Save left the article for ${afterSave.replace(/^https?:\/\/[^/]+/, '')}.`)

  await walk.click(page.getByRole('tab', { name: /^Наличност$/ }), 'open the stock tab')
  await page.waitForURL(/\/stock$/)
  await page.waitForLoadState('networkidle')
  await walk.shot('stock-tab')
  const stockText = (await page.locator('.v-main').innerText()).toLowerCase()
  if (!/резерв/.test(stockText)) walk.note('Stock tab: no reserved quantity shown.')
  if (!/поръчан|очаква|на път/.test(stockText)) walk.note('Stock tab: no ordered / awaiting-delivery quantity shown.')

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)
})
