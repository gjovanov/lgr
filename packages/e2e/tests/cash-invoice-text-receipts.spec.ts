import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession } from './helpers/cash-register'

/**
 * FR-23 (owner, 2026-11-01) — a cash invoice on a device that is not fiscalized.
 *
 * The device is `scripts/eltrade-tcp-stub.ts` as the unit in the field: status S4=84h, S5=90h, and 90h
 * refused until service sets it up. It says so itself, so the receipt prints as text, and nobody
 * chose that: no field, no setting, no switch. Run it as `cash-register-fiscal.spec.ts` says. Serial:
 * one session, one device, one invoice, and the session's report counting it.
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's
const PASSWORD = 'test12345'

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
const cents = (n: number) => Math.round(n * 100) / 100

let admin: Session
let cashier: Session
let cashierName = ''
let deviceId = ''
let till: { id: string; warehouseId: string }
let settingsBefore: any
let invoiceTotal = 0
let sessionNumber = ''
let draftId = ''

const gate = (on: boolean) => ok(admin, 'PUT', '', { settings: { cashRegister: { ...(settingsBefore || {}), requireConnectedDevice: on } } })

test.describe('FR-23 — a cash invoice on a device that is not fiscalized', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of cash-register-fiscal.spec.ts`).toBe(true)

    admin = await apiLogin()
    cashierName = `e2e-text-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${cashierName}@lgr.test`, username: cashierName, password: PASSWORD, firstName: 'E2E', lastName: 'Text', role: 'manager' })
    cashier = await apiLogin('acme-corp', cashierName, PASSWORD)
    till = await openTillSession(cashier)

    const { products } = await ok(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
    const article = (products || []).find((p: any) => (p.stockAvailable ?? 0) >= 2 && p.unitPrice > 0)
    expect(article, 'an article with stock at the store — is the DB seeded?').toBeTruthy()
    await fetch(`${STUB}/reset`, { method: 'POST', body: JSON.stringify({ unfiscalized: true }) })

    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId: till.warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (not fiscalized)', deviceNumber: SERIAL, manufacturer: 'eltrade', connectionType: 'tcp', connectionParams: params, warehouseId: till.warehouseId,
      })
      deviceId = created.fiscalDevice?.id || created.fiscalDevice?._id
    }
    const connected = await call(admin, 'POST', `/fiscal/device/${deviceId}/connect`)
    expect(connected.status, `connect → ${JSON.stringify(connected.json)} (is the server running with FISCAL_TCP_ALLOW_LOOPBACK=1?)`).toBe(200)

    const { org } = await ok(admin, 'GET', '')
    settingsBefore = org?.settings?.cashRegister
    await gate(true)

    const { contact } = await ok(admin, 'POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Клиент ${cashierName}` })
    const rate = article.taxRate || 0
    const net = cents(article.unitPrice * 2)
    const taxAmount = cents(net * rate / 100)
    invoiceTotal = cents(net + taxAmount)
    const { invoice } = await ok(cashier, 'POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: contact.id || contact._id, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [{
        productId: article.productId, description: article.productName, quantity: 2, unit: article.unit || 'pcs', unitPrice: article.unitPrice,
        taxRate: rate, taxAmount, lineTotal: invoiceTotal, warehouseId: till.warehouseId,
      }],
      subtotal: net, taxTotal: taxAmount, total: invoiceTotal, paymentMethod: 'cash',
    })
    draftId = String(invoice.id)
  })

  test.afterAll(async () => {
    await fetch(`${STUB}/reset`, { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined)
    if (admin) await call(admin, 'PUT', '', { settings: { cashRegister: settingsBefore ?? { requireConnectedDevice: false } } })
    if (deviceId) {
      await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
      await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    }
    const open = till ? await call(cashier, 'GET', `/trade/pos/session/${till.id}`) : null
    if (open?.json?.session?.status === 'open') await call(cashier, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
  })

  test('issued at the counter, it prints a text receipt and is paid, and no fiscal command reaches the device', async ({ page }) => {
    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${draftId}/edit`)
    const sending = page.waitForResponse((r: any) => /\/invoices\/[^/]+\/send$/.test(r.url()) && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    const answer = await sending
    expect(answer.status()).toBe(200)
    expect((await answer.json()).receiptError).toBeUndefined()

    const { invoice } = await ok(cashier, 'GET', `/invoices/${draftId}`)
    expect(invoice).toMatchObject({ status: 'paid' })
    expect(invoice.amountDue).toBe(0)
    expect(invoice.paymentReceipts).toHaveLength(1)
    expect(invoice.paymentReceipts[0].unp).toBeUndefined()

    const state = await device()
    expect(state.fiscalCommands).toBe(0)
    expect(state.receipts).toHaveLength(0)
    expect(state.textReceipts).toBe(1)
    const printed = state.nonFiscalLines.join(' ').replace(/\s+/g, ' ')
    expect(printed).toContain(`Фактура № ${invoice.invoiceNumber}`)
    expect(printed).toContain('NON-FISCAL')
    expect(printed).toContain(invoiceTotal.toFixed(2))

    // In the journal under its own kind, naming the invoice it paid.
    const number = invoice.paymentReceipts[0].number
    await page.goto(`/invoicing/cash-sales?q=${number}`)
    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByTestId('journal-kind-chip')).toContainText('Invoice payment')
  })

  test('the session report counts it as a text receipt, and the drawer expects its money', async ({ page }) => {
    const { expected, report } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(expected.cash).toBeCloseTo(invoiceTotal, 2)
    expect(report.counts).toMatchObject({ payments: 1, text: 1, fiscal: 0 })
    expect(report.total).toBeCloseTo(invoiceTotal, 2)
    sessionNumber = report.sessionNumber

    const closed = await ok(cashier, 'POST', `/trade/pos/session/${till.id}/close`, { counted: { cash: expected.cash } })
    expect(closed.report.counts).toMatchObject({ payments: 1, text: 1, fiscal: 0 })
    expect(closed.report.receipts).toBeUndefined()

    await loginForApp(page)
    await page.goto('/pos/sessions')
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: sessionNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByTestId('session-report-open').click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('session-report') })
    await expect(dialog.getByTestId('session-report-payments')).toContainText('1')
    await expect(dialog.getByTestId('session-report-total')).toContainText(invoiceTotal.toFixed(2))
    await expect(dialog.getByTestId('session-report')).toContainText(/Text receipts\s*1/)
  })
})
