import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin } from './helpers/api'
import { cashRegisterExport, closeTillSession, createBackOfficeCashSale, journal, ringTillSale, stockOf } from './helpers/cash-register'

/**
 * FR-21 (#171), R1 — one cash register, one journal.
 *
 * `/invoicing/cash-sales` is one page for the till's sales (POS rows until R2 copied them), the
 * back office's and the imports'. The till sale here is rung through the API by
 * the seeded cashier, and the back-office sale saved as the invoicing terminal saves one
 * (`helpers/cash-register.ts`): the seed has neither.
 *
 * R2: a till sale is a cash-register document, so what reads only documents carries it — the
 * cash-register report and both exports, the list and the per-product pivot (§8.3 item 7).
 *
 * Not here yet (§8.3): the receipt's УНП and the Z-report on close need a fiscal device in
 * Playwright, and the server refuses a loopback TCP device (`fiscal/tcp-target.ts`, SSRF): the TCP
 * stub the spec planned needs a test seam first (handover §4). A back-office sale joining a
 * session is R5.
 *
 * Serial: the storno, the roles and the old links are all about the one sale rung in `beforeAll`.
 */
test.describe.configure({ mode: 'serial' })

// No `import type` in a spec (CLAUDE.md, E2E gotcha 2): the types come from the helper's values.
let sale: Awaited<ReturnType<typeof ringTillSale>>
let backOffice: Awaited<ReturnType<typeof createBackOfficeCashSale>>
let stornoNumber = ''

const rowOf = (page: any, number: string) =>
  page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })

test.describe('FR-21 — one cash register, one journal', () => {
  test.beforeAll(async () => {
    sale = await ringTillSale()
    backOffice = await createBackOfficeCashSale()
  })

  // The storno went into this session too. Left open, it would hide the terminal's "Open
  // Session" button from `pos-terminal.spec.ts` (helpers/cash-register.ts says why).
  test.afterAll(async () => {
    if (sale) await closeTillSession(sale.sessionId)
  })

  test('a till sale and a back-office sale are in the journal, alike', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    const till = rowOf(page, sale.number)
    await expect(till).toBeVisible({ timeout: 10000 })
    await expect(till).toContainText('Till')
    await expect(till.getByTestId('journal-status-chip')).toHaveText('Completed')

    await page.goto(`/invoicing/cash-sales?q=${backOffice.number}`)
    await expect(rowOf(page, backOffice.number)).toContainText('Back office', { timeout: 10000 })

    // A document opens on its invoicing page, where it prints and emails.
    await rowOf(page, backOffice.number).getByRole('link', { name: backOffice.number, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${backOffice.id}/edit`))
  })

  test('R2: the cash-register report and both exports, which read only documents, carry the till sale', async () => {
    const admin = await apiLogin()
    const res = await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/org/${admin.orgId}/reports/cash-register/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ params: {} }),
    })
    expect(res.status).toBe(200)
    const report: any = await res.json()
    const row = report.rows.find((r: any) => r.number === sale.number)
    expect(row, `${sale.number} is in the report`).toBeTruthy()
    expect(row.docType).toBe('cash_sale')
    expect(row.total).toBeCloseTo(sale.total, 2)

    // The exports, narrowed to the sale by its number: the list has its row, and the pivot is the
    // one item it sold.
    const list = await cashRegisterExport(admin, { search: sale.number })
    expect(list.some(cells => cells.includes(sale.number)), `${sale.number} is in the list export`).toBe(true)
    const pivot = await cashRegisterExport(admin, { search: sale.number, aggregated: true, columns: ['sku', 'totalQuantity', 'grossTotal'] })
    const item = pivot.find(cells => cells[0] === sale.sku)
    expect(item, `${sale.sku} is in the aggregate export`).toBeTruthy()
    expect(item![1]).toBe(1)
    expect(Number(item![2])).toBeCloseTo(sale.total, 2)
  })

  test('a storno from the invoicing journal shows in both, and the stock is back', async ({ page }) => {
    const admin = await apiLogin()
    expect(await stockOf(admin, sale)).toBe(sale.stockBefore - 1)

    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    const row = rowOf(page, sale.number)
    await expect(row).toBeVisible({ timeout: 10000 })
    await row.getByTestId('storno-button').click()

    const dialog = page.getByTestId('storno-dialog')
    await expect(dialog).toBeVisible()
    // Enabled once it has found the open session in the sale's warehouse (the cashier's).
    await expect(dialog.getByTestId('storno-confirm')).toBeEnabled({ timeout: 10000 })
    await dialog.getByTestId('storno-confirm').click()
    await expect(dialog).toBeHidden({ timeout: 15000 })
    await expect(row.getByTestId('journal-status-chip')).toHaveText('Stornoed')

    const storno = (await journal(admin, 'kind=storno&size=100')).rows.find((r: any) => r.relatedId === sale.id)
    expect(storno, 'the storno is in the journal').toBeTruthy()
    stornoNumber = storno.number

    await page.goto(`/invoicing/cash-sales?q=${stornoNumber}`)
    await expect(rowOf(page, stornoNumber).getByTestId('journal-kind-chip')).toHaveText('Storno', { timeout: 10000 })
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    await expect(rowOf(page, sale.number).getByTestId('journal-status-chip')).toHaveText('Stornoed', { timeout: 10000 })
    expect(await stockOf(admin, sale)).toBe(sale.stockBefore)
  })

  test('the storno is on Reports → Export → Cash register, negative and naming its sale — from an old link too', async ({ page }) => {
    expect(stornoNumber, 'the storno test above made one').not.toBe('')
    await loginForApp(page)
    // The second link is one made when the tab still offered Draft / Completed: it asks for everything.
    for (const qs of [`tab=cash_register&q=${stornoNumber}`, `tab=cash_register&status=draft,stornoed,paid&q=${stornoNumber}`]) {
      await page.goto(`/reports/export?${qs}`)
      const row = rowOf(page, stornoNumber)
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(row).toContainText(`Storno of ${sale.number}`)
      await expect(row).toContainText(`-€${sale.total.toFixed(2)}`)
    }
  })

  test('the storno opens on the journal\'s page, which prints it — and so does its row', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${stornoNumber}`)
    const row = rowOf(page, stornoNumber)
    await expect(row).toBeVisible({ timeout: 10000 })

    const fromRow = page.waitForEvent('download')
    await row.getByRole('button', { name: 'Print' }).click()
    expect((await fromRow).suggestedFilename()).toBe(`${stornoNumber}.pdf`)

    await row.getByRole('link', { name: stornoNumber, exact: true }).click()
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/[0-9a-f]{24}\/view/)
    await expect(page.getByTestId('journal-document-title')).toHaveText(stornoNumber)
    const fromPage = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Print' }).click()
    expect((await fromPage).suggestedFilename()).toBe(`${stornoNumber}.pdf`)
  })

  test('a cashier sees the till sale but no Storno button', async ({ page }) => {
    const another = await ringTillSale()
    await loginForApp(page, 'acme-corp', 'sales', 'test123')
    await page.goto(`/invoicing/cash-sales?q=${another.number}`)
    const row = rowOf(page, another.number)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row.getByTestId('storno-button')).toHaveCount(0)
  })

  test('an accountant, who has no POS permission, reads the journal in invoicing', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'accountant', 'test123')
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
    await expect(rowOf(page, sale.number)).toBeVisible({ timeout: 10000 })
    await expect(rowOf(page, sale.number).getByTestId('storno-button')).toHaveCount(0)
  })

  test('column choices and filters survive a reload', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    const header = (name: string) => page.locator('.v-data-table').first().getByRole('columnheader', { name, exact: true })
    await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 10000 })
    await expect(header('Session')).toHaveCount(0)

    await page.getByRole('button', { name: 'Columns' }).click()
    const picker = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Columns' })
    await picker.locator('.v-list-item').filter({ has: page.getByText('Session', { exact: true }) }).locator('input[type="checkbox"]').check()
    await picker.getByRole('button', { name: 'Close' }).click()
    await expect(header('Session')).toBeVisible()

    await page.reload()
    await expect(header('Session')).toBeVisible({ timeout: 10000 })

    await page.goto('/invoicing/cash-sales?kind=storno')
    await page.reload()
    await expect(page).toHaveURL(/[?&]kind=storno/)
    const chips = page.getByTestId('journal-kind-chip')
    await expect(chips.first()).toHaveText('Storno', { timeout: 10000 })
    await expect(chips.filter({ hasNotText: /^\s*Storno\s*$/ })).toHaveCount(0)
  })

  test('an old /pos/orders/:id link and the invoicing view open the same sale, with its storno', async ({ page }) => {
    await loginForApp(page)
    for (const path of [`/pos/orders/${sale.id}`, `/invoicing/cash-sales/${sale.id}/view`]) {
      await page.goto(path)
      await expect(page.getByTestId('journal-document-title')).toHaveText(sale.number, { timeout: 10000 })
      await expect(page.getByTestId('journal-document-status')).toHaveText('Stornoed')
      await expect(page.getByTestId('journal-related')).toContainText(stornoNumber)
      await expect(page.getByTestId('journal-line')).toHaveCount(1)
    }
  })
})
