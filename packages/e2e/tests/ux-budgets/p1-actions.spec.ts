import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'
import { lineValues } from '../helpers/document-form'

/**
 * P1-act — Products: sell the article on screen (FR-22.47). A customer asks for an article the
 * user has in front of them on the Products list: open a sales invoice holding it.
 *
 * Until FR-22.47 nothing on the list or the article's page led to a document: the user went to
 * the invoicing app, opened a new invoice and searched the article again on its first line. Now the
 * row's menu offers „Продай", and the invoice opens with the article on its first line, at the
 * price the pricing chain resolves.
 *
 * The walk starts with the article's row in view (the list's search is in its URL): finding the
 * article is P1's walk. The invoice lives in another app, so the hop is a page load.
 *
 * Product used: PRD-0015 (the inventory walks' share of the acme-corp seed; P1 takes PRD-0012, P2
 * and P3 PRD-0013/0014). Nothing is saved.
 */

const SKU = 'PRD-0015'

test('P1-act products: sell the article on screen', async ({ page }, testInfo) => {
  const api = await uxApi()
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(SKU)}&size=5`)
  const product = (products || []).find((p: any) => p.sku === SKU)
  expect(product, `seed product ${SKU}`).toBeTruthy()
  const { finalPrice } = await api.get(`/pricing/resolve?productId=${product._id}&quantity=1`)
  expect(finalPrice, 'the resolved selling price').toBeGreaterThan(0)

  const walk = await startWalk(page, testInfo, {
    id: 'P1-act',
    title: 'Products — sell the article on screen: a new invoice with it on the first line',
    start: `/inventory/products?q=${SKU}`,
  })
  const row = page.locator('.v-data-table tbody tr').filter({ hasText: SKU })
  await expect(row).toHaveCount(1)
  await walk.shot('list')

  // ── The row's menu → „Продай" ──
  await walk.click(row.getByTestId('row-actions'), 'the row\'s menu (⋮)')
  await walk.shot('row-menu')
  await walk.click(page.getByTestId('row-action-sell'), '„Продай"')

  // ── A new invoice, the article on its first line ──
  await page.waitForURL(new RegExp(`/invoicing/invoices/new\\?productId=${product._id}$`))
  await expect(page.getByRole('heading', { name: 'Нова фактура' })).toBeVisible()
  await expect.poll(async () => (await lineValues(page))[0] || '', { timeout: 10000 }).toContain(product.name)
  const first = page.locator('.line-table tbody tr').first()
  await expect(first).toContainText(Number(finalPrice).toFixed(2))
  await expect(first.locator('input[type="number"]').first()).toHaveValue('1')
  await expect(page.locator('.line-table tbody tr'), 'the next line waits').toHaveCount(2)
  await walk.shot('invoice')
  // At 768 px the form's header fills the first screen: the line is below it.
  await first.scrollIntoViewIfNeeded()
  walk.scrolled('down to the lines, to see the article on the first one')
  await page.waitForTimeout(400)
  await walk.shot('invoice-line')
  walk.note(`„Продай" in the row's menu opens a new invoice in the invoicing app with ${SKU} on its first line: 1 ${product.unit} at ${Number(finalPrice).toFixed(2)}, the price the pricing chain resolves, and a blank line after it. The customer is the next field to fill.`)

  const result = walk.finish()
  // FR-22.47: the row's menu and „Продай" — no search on the invoice, nothing typed.
  expect(result.clicks).toBeLessThanOrEqual(2)
  expect(result.typed).toBe(0)
  // The invoice is another app: one page load, the only way there.
  expect(result.hops).toBeLessThanOrEqual(1)
})
