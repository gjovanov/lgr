import { test, expect } from '@playwright/test'
// Relative: Playwright runs specs under Node, which does not resolve the workspace's `config`.
// The server's own totals function, so the request is what the till sends (FR-21.30).
import { computePosTotals } from '../../config/src/pos-totals'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession } from './helpers/cash-register'
import { openSelect } from './helpers/vuetify'

/**
 * FR-21 §8.3 items 1, 4 and 9 — the cash register on a fiscal device.
 *
 * The device is `scripts/eltrade-tcp-stub.ts`: the integration tests' `EltradeSimulator`, behind a
 * TCP socket, so the till, the driver and the ISL protocol run as they do on a shop's A3. Start it,
 * and the server with loopback allowed for fiscal devices (refused otherwise, ignored in production):
 *
 *   bun packages/e2e/scripts/eltrade-tcp-stub.ts &
 *   cd packages/portal-api && FISCAL_TCP_ALLOW_LOOPBACK=1 bun src/unified.ts
 *   cd packages/e2e && bunx playwright test --project=cash-register-fiscal
 *
 * The device is registered on the store (ST-01) for this spec and deactivated after it, so no other
 * spec ever prints on it. Serial: one session, rung, joined, stornoed and closed in order.
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's: a УНП naming another device is refused

type Session = Awaited<ReturnType<typeof apiLogin>>
async function call(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/api/org/${s.orgId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const ok = async (s: Session, method: string, path: string, body?: unknown) => {
  const r = await call(s, method, path, body)
  expect(r.status, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`).toBeLessThan(300)
  return r.json
}
const device = async () => (await fetch(`${STUB}/state`)).json() as Promise<any>

let admin: Session
let cashier: Session
let cashierName = ''
let manager: Session
let deviceId = ''
let till: { id: string; warehouseId: string }
let sale: any
let joined: any
/** The sale the terminal rang up as cash on delivery. */
let delivered: any
/** Three articles at one VAT rate, which the device is programmed for (`beforeAll`). */
let articles: any[] = []
const cents = (n: number) => Math.round(n * 100) / 100

test.describe('FR-21 — the cash register on a fiscal device', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of this spec`).toBe(true)

    admin = await apiLogin()
    // A fiscal receipt names its operator, and the seed's users have no operator code: a user created
    // through the API gets one (`allocateOperatorCode`). A cashier rings and closes; a manager stornos.
    const run = Date.now().toString(36)
    const person = async (role: 'sales' | 'manager') => {
      const username = `e2e-${role}-${run}`
      await ok(admin, 'POST', '/user', {
        email: `${username}@lgr.test`, username, password: 'test12345', firstName: 'E2E', lastName: role, role,
      })
      return apiLogin('acme-corp', username, 'test12345')
    }
    cashier = await person('sales')
    cashierName = `e2e-sales-${run}`
    manager = await person('manager')
    // The cashier's session on the store: the device is registered on the same warehouse.
    till = await openTillSession(cashier)

    // The articles this spec sells: three with stock at the store, all at ONE VAT rate. In a full run
    // other specs have changed articles before this one, so "the first article's rate" was not the
    // rate of the ones sold, and the device refused a line (a voided receipt).
    const { products } = await ok(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
    const sellable = (products || []).filter((p: any) => (p.stockAvailable ?? 0) >= 2 && p.unitPrice > 0)
    const byRate = new Map<number, any[]>()
    for (const p of sellable) byRate.set(Number(p.taxRate || 0), [...(byRate.get(Number(p.taxRate || 0)) || []), p])
    const [rate, same] = [...byRate.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [20, []]
    expect(same.length, 'three articles with stock at the store, at one VAT rate — is the DB seeded?').toBeGreaterThanOrEqual(3)
    articles = same.slice(0, 3)

    // A fresh device whose VAT group for that rate carries it. The driver refuses a line whose rate no
    // group is programmed at, as a real Eltrade does (the seed's articles are at 18 %, a Bulgarian
    // device's Б at 20 %). The rate's group is the one `fiscal/vat-groups` maps it to.
    const group = rate >= 18 ? 1 : rate >= 7 ? 3 : 0 // Б, Г, А
    const rates = [0, 20, 20, 9, 0, 0, 0, 0]
    rates[group] = rate
    const programmed = await (await fetch(`${STUB}/reset`, { method: 'POST', body: JSON.stringify({ rates }) })).json()
    expect(programmed.rates[group]).toBe(rate)

    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    // `tcpPort` is a TCP device's port; `port` names a serial one.
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId: till.warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (simulated)', deviceNumber: SERIAL, manufacturer: 'eltrade',
        connectionType: 'tcp', connectionParams: params, warehouseId: till.warehouseId,
      })
      deviceId = created.fiscalDevice?.id || created.fiscalDevice?._id
    }
    const connected = await call(admin, 'POST', `/fiscal/device/${deviceId}/connect`)
    expect(connected.status, `connect → ${JSON.stringify(connected.json)} (is the server running with FISCAL_TCP_ALLOW_LOOPBACK=1?)`).toBe(200)
  })

  test.afterAll(async () => {
    if (!deviceId) return
    await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
    await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    // A session the steps below did not get to close.
    const open = await call(cashier, 'GET', `/trade/pos/session/${till?.id}`)
    if (open.json?.session?.status === 'open') await call(cashier, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
  })

  test('1. a fiscal sale of two articles by card: one receipt with its УНП, the same sale in both journals', async ({ page }) => {
    const lines = articles.slice(0, 2).map((p: any) => ({
      productId: p.productId, name: p.productName, quantity: 1, unitPrice: p.unitPrice, discount: 0,
      taxRate: p.taxRate || 0, taxAmount: cents(p.unitPrice * (p.taxRate || 0) / 100), lineTotal: cents(p.unitPrice),
    }))
    const t = computePosTotals(lines.map((l: any) => ({ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, discount: 0 })))
    const before = (await device()).receipts.length

    const rung = await ok(cashier, 'POST', `/trade/pos/session/${till.id}/transaction`, {
      type: 'sale', lines, subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'card', amount: t.total }], changeDue: 0, nonFiscal: false,
    })
    sale = rung.transaction

    // The device printed one fiscal receipt: both articles, paid by card.
    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('fiscal')
    expect(printed[0].voided ?? false).toBe(false)
    expect(printed[0].sales).toHaveLength(2)
    expect(printed[0].total).toBeCloseTo(t.total, 2)
    expect(sale.unpNumber).toMatch(new RegExp(`^${SERIAL}-\\d{4}-\\d{7}$`))
    expect(sale.fiscalReceiptNumber).toBeTruthy()

    // The journal names it with its УНП.
    const { rows } = await ok(admin, 'GET', `/cash-register/documents?search=${encodeURIComponent(sale.transactionNumber)}&size=10`)
    const row = rows.find((r: any) => r.number === sale.transactionNumber)
    expect(row).toMatchObject({ origin: 'pos', fiscal: { isFiscal: true, unp: sale.unpNumber, deviceNumber: SERIAL } })

    // The journal lists the same sale, with the same number and total.
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${sale.transactionNumber}`)
    const tr = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: sale.transactionNumber, exact: true }) })
    await expect(tr).toBeVisible({ timeout: 15000 })
    await expect(tr).toContainText(t.total.toFixed(2))
  })

  test('9. R5: a back-office sale by the cashier joins the open session and prints on its device', async () => {
    const p = articles[2]
    const rate = p.taxRate || 0
    const t = computePosTotals([{ quantity: 1, unitPrice: p.unitPrice, taxRate: rate, discount: 0 }])
    const before = (await device()).receipts.length

    const created = await ok(cashier, 'POST', '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [{
        productId: p.productId, description: p.productName, quantity: 1, unit: p.unit || 'pcs', unitPrice: p.unitPrice,
        discount: 0, taxRate: rate, taxAmount: t.taxTotal, lineTotal: t.total, warehouseId: till.warehouseId,
      }],
      subtotal: t.subtotal, taxTotal: t.taxTotal, total: t.total, paymentMethod: 'cash', receipt: 'fiscal',
    })
    joined = created.invoice

    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('fiscal')
    expect(printed[0].total).toBeCloseTo(t.total, 2)
    const { rows } = await ok(admin, 'GET', `/cash-register/documents?search=${encodeURIComponent(joined.invoiceNumber)}&size=10`)
    const row = rows.find((r: any) => r.number === joined.invoiceNumber)
    // A till document now: rung into the cashier's session, printed fiscally on its device.
    expect(row).toMatchObject({ origin: 'pos', sessionId: till.id, fiscal: { isFiscal: true, deviceNumber: SERIAL } })
  })

  test('cash on delivery at the terminal: slot R on the receipt, in its own words on the screen, and the close expects it without counting it', async ({ page }) => {
    const p = articles[0]
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, 'test12345')
    await page.goto('/invoicing/cash-sales/new')
    // A fiscal receipt: the switch starts on, for a till with a device that is not fiscalized yet.
    const nonFiscal = page.getByLabel('Non-fiscal')
    await expect(nonFiscal).toBeVisible({ timeout: 15000 })
    await nonFiscal.uncheck({ force: true })

    await page.getByRole('textbox', { name: /Search products/i }).fill(p.productName)
    const card = page.getByTestId('register-card').filter({ hasText: p.productName }).first()
    await expect(card).toBeVisible({ timeout: 15000 })
    await card.click()

    await openSelect(page, /Payment Method/i)
    await page.getByRole('option', { name: 'Cash on delivery', exact: true }).click()
    const selling = page.waitForResponse(r => r.url().endsWith(`/trade/pos/session/${till.id}/transaction`) && r.request().method() === 'POST')
    await page.getByTestId('complete-sale').click()
    const res = await selling
    expect(res.status()).toBe(200)
    delivered = (await res.json()).transaction

    // The method's name, not `pos.cash_on_delivery` (the key the screen used to build).
    await expect(page.getByTestId('last-sale')).toContainText('Cash on delivery')
    await expect(page.getByTestId('last-sale')).not.toContainText('pos.')
    expect(delivered.unpNumber).toMatch(new RegExp(`^${SERIAL}-`))

    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('fiscal')
    expect(printed[0].payments).toEqual([{ mode: 'R', amount: delivered.total }])

    // Expected, and nothing to enter: the courier holds it.
    await page.getByRole('button', { name: 'Close Session' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Close the register' })
    const line = dialog.getByTestId('close-cash-on-delivery')
    await expect(line).toContainText('Cash on delivery')
    await expect(line).toContainText(delivered.total.toFixed(2))
    await expect(line.locator('input')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // The journal filters by it, and its Payment column says it in words.
    await page.goto('/invoicing/cash-sales?method=cash_on_delivery')
    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: delivered.transactionNumber, exact: true }) })
    await expect(row).toContainText('Cash on delivery', { timeout: 15000 })
    await expect(page.getByRole('link', { name: sale.transactionNumber, exact: true })).toHaveCount(0)
  })

  test('POS Sessions prints an X on the session\'s device, from the session\'s menu, and offers no Z', async ({ page }) => {
    const { session } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)
    const before = await device()

    await loginForApp(page)
    await page.goto('/invoicing/cash-register/sessions')
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: session.sessionNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByTestId('session-device-report').click()

    // What an Eltrade has, and nothing it has not.
    const menu = page.getByTestId('session-device-report-menu')
    await expect(menu.getByTestId('device-report-x')).toBeVisible()
    await expect(menu.getByTestId('device-report-fm_date')).toBeVisible()
    await expect(menu.getByTestId('device-report-fm_number')).toBeVisible()
    await expect(menu.getByTestId('device-report-ej')).toHaveCount(0)
    await expect(menu.getByTestId('device-report-operator')).toHaveCount(0)
    await expect(menu).not.toContainText('Z-report')

    const printing = page.waitForResponse(r => r.url().endsWith(`/trade/pos/session/${till.id}/device-report`) && r.request().method() === 'POST')
    await menu.getByTestId('device-report-x').click()
    expect((await printing).status()).toBe(200)
    await expect(page.getByText('The report was printed on the fiscal device.')).toBeVisible()

    const after = await device()
    expect(after.reports.slice(before.reports.length)).toEqual([{ cmd: 0x45, data: '2' }])
    expect(after.closure).toBe(before.closure)
  })

  test('3 + 4. the card sale stornoed from the invoicing journal prints its storno receipt; the close runs the Z-report and expects the cash', async () => {
    const opened: any = (await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)).session
    const before = await device()

    // A storno is a manager's (STORNO_ROLES), through the journal's door, in the sale's session.
    const storno = await ok(manager, 'POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'operator_error', sessionId: till.id })
    expect(storno.transaction ?? storno).toBeTruthy()
    const afterStorno = await device()
    const stornoReceipts = afterStorno.receipts.slice(before.receipts.length)
    expect(stornoReceipts.map((r: any) => r.kind)).toEqual(['storno'])

    // Expected cash: the opening balance and the joined sale's cash. The card sale and its storno
    // are card: the drawer neither took nor gives back cash for them. Cash on delivery is the
    // courier's: expected on its own, and no part of the cash.
    const preview = await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(preview.fiscalDevice).toMatchObject({ deviceNumber: SERIAL, connected: true })
    expect(preview.expected.cash).toBeCloseTo(cents((opened.openingBalance || 0) + joined.total), 2)
    expect(preview.expected.card).toBeCloseTo(0, 2)
    expect(preview.expected.cashOnDelivery).toBeCloseTo(delivered.total, 2)

    const closed = await ok(cashier, 'POST', `/trade/pos/session/${till.id}/close`, {
      counted: { cash: preview.expected.cash, card: preview.expected.card, other: preview.expected.other ?? 0 },
    })
    expect(closed.fiscalStatus).toBe('closed')
    expect(closed.session.status).toBe('closed')
    const afterClose = await device()
    // The Z-report ran on the device: a closure more, and a report recorded.
    expect(afterClose.closure).toBe(afterStorno.closure + 1)
    expect(afterClose.reports.length).toBeGreaterThan(afterStorno.reports.length)

    // Then LGR's own figures, as a text receipt on the same device: a Z counts only the device's
    // fiscal receipts. The card sale and its storno cancel out; the joined sale's cash and the
    // courier's money are the day, on lines of their own.
    expect(closed.reportError).toBeUndefined()
    expect(closed.report).toMatchObject({ sessionNumber: opened.sessionNumber, counts: { sales: 3, stornos: 1 } })
    expect(closed.report.total).toBeCloseTo(joined.total + delivered.total, 2)
    expect(closed.report.byMethod.cash).toBeCloseTo(joined.total, 2)
    expect(closed.report.byMethod.card).toBeCloseTo(0, 2)
    expect(closed.report.byMethod.cashOnDelivery).toBeCloseTo(delivered.total, 2)
    expect(closed.session.closingBreakdown.find((l: any) => l.method === 'cash_on_delivery').counted).toBeUndefined()
    expect(afterClose.textReceipts).toBe(afterStorno.textReceipts + 1)
    expect(afterClose.nonFiscalLines.join('\n')).toContain(opened.sessionNumber)
  })

  test('the closed session\'s report prints again from POS Sessions', async ({ page }) => {
    const { session } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)
    const before = await device()

    await loginForApp(page)
    await page.goto('/invoicing/cash-register/sessions')
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: session.sessionNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByTestId('session-report-open').click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('session-report') })
    await expect(dialog.getByTestId('session-report')).toContainText(session.sessionNumber)
    await expect(dialog.getByTestId('session-report-total')).toContainText(cents(joined.total + delivered.total).toFixed(2))
    await expect(dialog.getByTestId('session-report-cod')).toContainText(delivered.total.toFixed(2))

    const printing = page.waitForResponse(r => r.url().includes(`/trade/pos/session/${till.id}/report/print`))
    await dialog.getByRole('button', { name: 'Print report' }).click()
    expect((await printing).status()).toBe(200)
    await expect(page.getByText('The session report was printed on the fiscal device.')).toBeVisible()
    const after = await device()
    expect(after.textReceipts).toBe(before.textReceipts + 1)
    expect(after.nonFiscalLines.join('\n')).toContain(session.sessionNumber)
    // Only a text receipt: a reprint never touches the device's fiscal day.
    expect(after.closure).toBe(before.closure)
    expect(after.receipts.length).toBe(before.receipts.length)
  })

  test('a closed session offers no X, and its fiscal memory report starts from its own Z-report', async ({ page }) => {
    const { session } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)
    expect(session.zReportNumber).toBeTruthy()
    const before = await device()
    const z = Number(session.zReportNumber)

    await loginForApp(page)
    await page.goto('/invoicing/cash-register/sessions')
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: session.sessionNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByTestId('session-device-report').click()
    const menu = page.getByTestId('session-device-report-menu')
    await expect(menu.getByTestId('device-report-fm_number')).toBeVisible()
    await expect(menu.getByTestId('device-report-x')).toHaveCount(0)
    await menu.getByTestId('device-report-fm_number').click()

    const params = page.getByTestId('device-report-params')
    await expect(params.getByTestId('device-report-from').locator('input')).toHaveValue(String(z))
    await expect(params.getByTestId('device-report-to').locator('input')).toHaveValue(String(z))
    const printing = page.waitForResponse(r => r.url().endsWith(`/trade/pos/session/${till.id}/device-report`) && r.request().method() === 'POST')
    await params.getByTestId('device-report-print').click()
    expect((await printing).status()).toBe(200)

    const after = await device()
    const number = String(z).padStart(4, '0')
    expect(after.reports.slice(before.reports.length)).toEqual([{ cmd: 0x5F, data: `${number},${number}` }])
  })
})
