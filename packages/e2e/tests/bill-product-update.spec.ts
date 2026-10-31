import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { receivedBill } from './helpers/bills'
import { openSelect } from './helpers/vuetify'

/**
 * The supplier bill form's „With product update": ON for a new bill, remembered per user once
 * they change it, and safe left on — an untouched bill is not "unsaved", so nothing is written.
 */

test.describe('Supplier bill form — with product update', () => {
  test('„With product update" is ON for a new bill, and the user\'s choice is remembered', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    const chip = page.getByTestId('bill-product-update')
    await expect(chip).toContainText(/^\s*With product update\s*$/)
    await expect(chip.locator('input[type="checkbox"]')).toBeChecked()
    // The product columns are there from the start: the buying and selling price, three tiers by name.
    const heads = page.locator('.line-table thead th')
    await expect(heads.filter({ hasText: /^Buying Price$/ })).toHaveCount(1)
    await expect(heads.filter({ hasText: /^Цена 1$/ })).toHaveCount(1)

    await chip.locator('input[type="checkbox"]').click()
    await expect(chip).toContainText('Without product update')
    await page.reload()
    await expect(page.getByTestId('bill-product-update')).toContainText('Without product update')
    await expect(heads.filter({ hasText: /^Buying Price$/ })).toHaveCount(0)

    // Back on, and remembered as such.
    await page.getByTestId('bill-product-update').locator('input[type="checkbox"]').click()
    await page.reload()
    await expect(page.getByTestId('bill-product-update')).toContainText(/^\s*With product update\s*$/)
  })

  test('a bill in another currency offers no product update and says why; back in the org\'s, it does', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    const chip = page.getByTestId('bill-product-update')
    await expect(chip).toBeVisible()

    await openSelect(page, /^Currency$/)
    await page.getByRole('option', { name: 'USD', exact: true }).click()
    await expect(chip).toHaveCount(0)
    await expect(page.getByTestId('bill-no-product-update')).toHaveText('In USD: this bill updates no products')
    const heads = page.locator('.line-table thead th')
    await expect(heads.filter({ hasText: /^Buying Price$/ })).toHaveCount(0)

    await openSelect(page, /^Currency$/)
    await page.getByRole('option', { name: 'EUR', exact: true }).click()
    await expect(chip).toBeVisible()
    await expect(page.getByTestId('bill-no-product-update')).toHaveCount(0)
    await expect(heads.filter({ hasText: /^Buying Price$/ })).toHaveCount(1)
  })

  test('opened untouched with the switch ON, a bill is not "unsaved": Print does not save it first', async ({ page }) => {
    const bill = await receivedBill()
    await loginForApp(page)
    const puts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/invoices\/[0-9a-f]{24}$/.test(r.url())) puts.push(r.url())
    })

    await page.goto(`/invoicing/bills/${bill.id}/edit`)
    // Seeded from the catalog — the article's purchase price, not the bill's own unit price (2.75).
    await expect(page.locator('.line-table thead th').filter({ hasText: /^Buying Price$/ })).toHaveCount(1, { timeout: 15000 })
    const heads: string[] = await page.locator('.line-table thead th').allInnerTexts()
    const buying = heads.findIndex((h) => h.trim() === 'Buying Price')
    expect(buying).toBeGreaterThan(0)
    await expect(page.locator('.line-table tbody tr').first().locator('td').nth(buying).locator('input')).toHaveValue('2.5')

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('print-now').click()])
    expect(download.suggestedFilename()).toBe(`${bill.number}.pdf`)
    expect(puts, 'Print saves only a form that differs from what is stored').toEqual([])
  })
})
