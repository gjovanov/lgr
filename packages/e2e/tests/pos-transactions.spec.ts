import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'
import { ensureJournalRows } from './helpers/cash-register'

/**
 * FR-21.13: `/pos/orders` is the cash-register journal („Касови продажби"), the same page as
 * `/invoicing/cash-sales`; the route names did not change. This file covers the page itself, and
 * `cash-register.spec.ts` the two apps together.
 *
 * The seed has neither a till sale nor a cash sale: one of each is added when missing.
 */
test.describe('POS — the cash-register journal', () => {
  test.beforeAll(async () => {
    await ensureJournalRows()
  })

  test('renders under its new title', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
  })

  test('offers the journal filters', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')

    await expect(page.getByLabel(/search/i).first()).toBeVisible()
    for (const name of [/^Kind$/, /^Origin$/, /^Status$/, /^Receipt$/, /^Payment$/]) {
      await expect(page.getByRole('combobox', { name })).toBeVisible()
    }
  })

  test('shows the default columns and keeps the others off until asked for', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })
    for (const name of ['Number', 'Date & time', 'Kind', 'Origin', 'Customer', 'Payment', 'Total', 'Receipt', 'Status']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible()
    }
    // FR-21 §3.4: off by default, turned on from the column picker.
    for (const name of ['Session', 'Cashier', 'Warehouse', 'Device', 'Net', 'VAT', 'Stock', 'Reference']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toHaveCount(0)
    }
  })

  test('has a pagination footer', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await expect(page.locator('.v-data-table-footer')).toBeVisible({ timeout: 10000 })
  })

  test('a kind filter narrows the rows and lands in the URL', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 10000 })

    // Read the rows only once the filtered page has arrived: the previous page may hold stornos.
    const filtered = page.waitForResponse(r => r.url().includes('/cash-register/documents') && /[?&]kind=sale/.test(r.url()))
    await openSelect(page, /^Kind$/)
    await page.getByRole('option', { name: /^Sale$/ }).click()
    await filtered

    await expect(page).toHaveURL(/[?&]kind=sale/)
    const chips = page.getByTestId('journal-kind-chip')
    await expect(chips.first()).toBeVisible()
    await expect(chips.filter({ hasNotText: /^\s*Sale\s*$/ })).toHaveCount(0)
  })

  test('an old link to the replaced list still reads as "all"', async ({ page }) => {
    await loginForApp(page)
    // The invoicing list this journal replaced wrote `status=draft,completed,paid`.
    await page.goto('/pos/orders?status=draft,completed,paid')
    await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('journal-status-chip').first()).toBeVisible()
  })

  test('search does not break the page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    await page.getByLabel(/search/i).first().fill('test-search-query')
    await expect(page).toHaveURL(/[?&]q=test-search-query/)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
  })

  test('a row opens its detail page, which leads back to the journal', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    const first = page.locator('.v-data-table tbody tr').first()
    await expect(first).toBeVisible({ timeout: 10000 })
    const number = (await first.locator('td').first().textContent())?.trim() || ''
    expect(number).not.toBe('')

    await first.getByRole('link', { name: 'Open' }).click()
    await expect(page).toHaveURL(/\/pos\/orders\/[0-9a-f]{24}/)
    await expect(page.getByTestId('journal-document-title')).toHaveText(number)

    await page.getByRole('link', { name: 'Back to cash sales' }).click()
    await expect(page).toHaveURL(/\/pos\/orders(\?|$)/)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
  })
})
