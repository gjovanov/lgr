import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'
import { closeTillSession, createBackOfficeCashSale, ensureJournalRows, ownCashier, ringTillSale, stornoTillSale } from './helpers/cash-register'

/**
 * FR-21.13: `/invoicing/cash-sales` is the cash-register journal („Касови продажби"). This file
 * covers the page itself, and `cash-register.spec.ts` what it shows of the till and the back office.
 *
 * The seed has neither a till sale nor a cash sale: one of each is added when missing.
 */
test.describe('The cash-register journal', () => {
  test.beforeAll(async () => {
    await ensureJournalRows()
  })

  test('renders under its new title', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
  })

  test('offers the journal filters', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByLabel(/search/i).first()).toBeVisible()
    for (const name of [/^Kind$/, /^Origin$/, /^Status$/, /^Receipt$/, /^Payment$/]) {
      await expect(page.getByRole('combobox', { name })).toBeVisible()
    }
  })

  test('shows the default columns and keeps the others off until asked for', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

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
    await page.goto('/invoicing/cash-sales')
    await expect(page.locator('.v-data-table-footer')).toBeVisible({ timeout: 10000 })
  })

  test('a kind filter narrows the rows and lands in the URL', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
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
    await page.goto('/invoicing/cash-sales?status=draft,completed,paid')
    await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('journal-status-chip').first()).toBeVisible()
  })

  test('search does not break the page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    await page.getByLabel(/search/i).first().fill('test-search-query')
    await expect(page).toHaveURL(/[?&]q=test-search-query/)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
  })

  // ⚠ A row of each kind, by its number: what the first row of the journal is depends on who ran before.
  const rowOf = (page: any, number: string) => page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })

  async function openRow(page: any, number: string) {
    await page.goto(`/invoicing/cash-sales?q=${number}`)
    await expect(rowOf(page, number)).toBeVisible({ timeout: 15000 })
    await rowOf(page, number).getByRole('link', { name: number, exact: true }).click()
  }

  test('a till sale opens on the journal\'s page, with its tender and its stock, and leads back', async ({ page }) => {
    const cashier = await ownCashier('journal')
    const sale = await ringTillSale(cashier.session)
    try {
      // Whoever opens it: `sales` reads the back-office form too, and that is not the page for it.
      await loginForApp(page, 'acme-corp', 'sales', 'test123')
      await openRow(page, sale.number)

      await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/view$`))
      await expect(page.getByTestId('journal-document-title')).toHaveText(sale.number)
      await expect(page.getByTestId('journal-document-status')).toHaveText('Completed')
      await expect(page.getByTestId('journal-line')).toHaveCount(1)
      await expect(page.getByTestId('journal-movement')).toHaveCount(1)
      await expect(page.getByText('Card', { exact: true })).toBeVisible()

      await page.getByRole('link', { name: 'Back to cash sales' }).click()
      await expect(page).toHaveURL(/\/invoicing\/cash-sales(\?|$)/)
      await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
    } finally {
      await closeTillSession(sale.sessionId, cashier.session)
      await cashier.drop()
    }
  })

  test('a back-office sale opens on its document page', async ({ page }) => {
    const sale = await createBackOfficeCashSale()
    await loginForApp(page)
    await openRow(page, sale.number)
    await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/edit$`))
  })

  // The form read "Completed" for it and named no storno.
  test('a stornoed till sale opens there too, reads as stornoed, and names its storno', async ({ page }) => {
    const cashier = await ownCashier('storno')
    const sale = await ringTillSale(cashier.session)
    try {
      const storno = await stornoTillSale(sale)
      await loginForApp(page)
      await openRow(page, sale.number)

      await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/view$`))
      await expect(page.getByTestId('journal-document-status')).toHaveText('Stornoed')
      await expect(page.getByTestId('journal-related').getByRole('link', { name: storno, exact: true })).toBeVisible()

      // And the chain leads on: a storno opens on the same page.
      await page.getByTestId('journal-related').getByRole('link', { name: storno, exact: true }).click()
      await expect(page).toHaveURL(/\/invoicing\/cash-sales\/[0-9a-f]{24}\/view$/)
      await expect(page.getByTestId('journal-document-title')).toHaveText(storno)
    } finally {
      await closeTillSession(sale.sessionId, cashier.session)
      await cashier.drop()
    }
  })

  // The form printed the raw `cash_on_delivery`.
  test('a cash-on-delivery sale opens there too, and names its method in words', async ({ page }) => {
    const cashier = await ownCashier('cod')
    const sale = await ringTillSale(cashier.session, 'cash_on_delivery')
    try {
      await loginForApp(page)
      await openRow(page, sale.number)
      await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/view$`))
      await expect(page.getByText('Cash on delivery', { exact: true })).toBeVisible()
      await expect(page.getByText('cash_on_delivery')).toHaveCount(0)
    } finally {
      await closeTillSession(sale.sessionId, cashier.session)
      await cashier.drop()
    }
  })
})
