import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { closeTillSession, openTillSession, ringTillSale } from './helpers/cash-register'

/**
 * The session report: a close prints LGR's own figures after the Z-report, because a device's Z
 * counts only its fiscal receipts, so a till printing text receipts closed on a Z of zeros.
 *
 * Here with no device on the store (acme-corp sells without one): the close dialog shows the report
 * the close keeps on the session, and POS Sessions shows it again and says why it cannot print it.
 * The printed report is `cash-register-fiscal.spec.ts`'s, on the simulated Eltrade.
 */
test.describe.configure({ mode: 'serial' })

let sale: Awaited<ReturnType<typeof ringTillSale>>
let sessionNumber = ''

test.beforeAll(async () => {
  const cashier = await apiLogin('acme-corp', 'sales', 'test123')
  // A fresh session: one an earlier spec left open is closed first, so the report counts this sale.
  const stale = await openTillSession(cashier)
  await closeTillSession(stale.id, cashier)
  sale = await ringTillSale(cashier)
})

test('a close that met a sale printing says to wait, and the session stays open to close again', async ({ page }) => {
  // The device's side is `integration/pos-close.flow`; here, what the dialog makes of the answer.
  await page.route(`**/trade/pos/session/${sale.sessionId}/close`, route => route.fulfill({
    status: 409,
    json: { code: 'receipt_open', message: 'A sale is printing on this device. Wait for it to finish, then close again.' },
  }))
  await loginForApp(page, 'acme-corp', 'sales', 'test123')
  await page.goto('/pos/terminal')
  await page.getByRole('button', { name: 'Close Session' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Close the register' })
  const confirm = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(confirm).toBeEnabled({ timeout: 15000 })
  await confirm.click()

  await expect(dialog).toContainText('The session is still open')
  await expect(dialog).toContainText('Wait for it to finish, then close again.')
  await expect(dialog).not.toContainText('could NOT be closed')
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible()
})

test('the close dialog shows the session report the close keeps', async ({ page }) => {
  await loginForApp(page, 'acme-corp', 'sales', 'test123')
  await page.goto('/pos/terminal')
  await page.getByRole('button', { name: 'Close Session' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Close the register' })
  const confirm = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(confirm).toBeEnabled({ timeout: 15000 })

  const closing = page.waitForResponse(r => r.url().includes(`/trade/pos/session/${sale.sessionId}/close`) && r.request().method() === 'POST')
  await confirm.click()
  const res = await closing
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Nothing to print on: the Z-report is skipped, and so is the report's print — it is kept all the same.
  expect(body.fiscalStatus).toBe('skipped')
  expect(body.reportError).toBeUndefined()
  expect(body.report).toMatchObject({ counts: { sales: 1, stornos: 0 } })
  expect(body.report.total).toBeCloseTo(sale.total, 2)
  expect(body.report.byMethod.card).toBeCloseTo(sale.total, 2)
  sessionNumber = body.report.sessionNumber

  const report = dialog.getByTestId('session-report')
  await expect(report).toContainText(sessionNumber)
  await expect(dialog.getByTestId('session-report-total')).toContainText(sale.total.toFixed(2))
  await expect(dialog.getByTestId('session-report-error')).toHaveCount(0)
})

test('POS Sessions shows the report again, and says why it cannot print it', async ({ page }) => {
  expect(sessionNumber, 'the close above ran').toBeTruthy()
  await loginForApp(page)
  await page.goto('/pos/sessions')
  const row = page.locator('.v-data-table tbody tr').filter({ hasText: sessionNumber })
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.getByTestId('session-report-open').click()

  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('session-report') })
  await expect(dialog.getByTestId('session-report')).toContainText(sessionNumber)
  await expect(dialog.getByTestId('session-report-total')).toContainText(sale.total.toFixed(2))

  // No device on the store: nothing prints, and it says so.
  const printing = page.waitForResponse(r => r.url().includes(`/trade/pos/session/${sale.sessionId}/report/print`))
  await dialog.getByRole('button', { name: 'Print report' }).click()
  expect((await printing).status()).toBe(409)
  await expect(page.getByText('No fiscal printer is set up for this warehouse')).toBeVisible()
})
