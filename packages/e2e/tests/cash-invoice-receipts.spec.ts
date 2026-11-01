import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession } from './helpers/cash-register'
import { openSelect } from './helpers/vuetify'

/**
 * FR-23 R1 — a fiscal receipt for a payment on an invoice, on the simulated Eltrade.
 *
 * The device is `scripts/eltrade-tcp-stub.ts`, as in `cash-register-fiscal.spec.ts`: run it, and the
 * server with loopback allowed (see that spec's header). The demo org turns the printer gate off, so
 * this spec turns it on for its own run, and back off after. Serial: one session, one device.
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's: a УНП naming another device is refused
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
const paper = (on: boolean) => fetch(`${STUB}/paper`, { method: 'POST', body: JSON.stringify({ on }) })
const cents = (n: number) => Math.round(n * 100) / 100

let admin: Session
let cashier: Session
let cashierName = ''
let deviceId = ''
let till: { id: string; warehouseId: string }
let article: any
let customer = ''
/** The org's cash-register settings as the seed left them: this spec restores them. */
let settingsBefore: any

async function gate(on: boolean) {
  await ok(admin, 'PUT', '', { settings: { cashRegister: { ...(settingsBefore || {}), requireConnectedDevice: on } } })
}

/** A draft invoice for one of the article, by `method`, as the form would save it. */
async function draft(method: string, quantity = 1) {
  const rate = article.taxRate || 0
  const net = cents(article.unitPrice * quantity)
  const taxAmount = cents(net * rate / 100)
  const total = cents(net + taxAmount)
  const { invoice } = await ok(cashier, 'POST', '/invoices', {
    type: 'invoice', direction: 'outgoing', contactId: customer, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{
      productId: article.productId, description: article.productName, quantity, unit: article.unit || 'pcs', unitPrice: article.unitPrice,
      taxRate: rate, taxAmount, lineTotal: total, warehouseId: till.warehouseId,
    }],
    subtotal: net, taxTotal: taxAmount, total, paymentMethod: method,
  })
  return { id: String(invoice.id), total }
}

const issuing = (page: any) => page.waitForResponse((r: any) => /\/invoices\/[^/]+\/send$/.test(r.url()) && r.request().method() === 'POST')
const paying = (page: any) => page.waitForResponse((r: any) => /\/invoices\/[^/]+\/payments$/.test(r.url()) && r.request().method() === 'POST')

test.describe('FR-23 — a receipt for a payment on an invoice', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of cash-register-fiscal.spec.ts`).toBe(true)

    admin = await apiLogin()
    // A fiscal receipt names its operator: a user created through the API gets a code.
    cashierName = `e2e-counter-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${cashierName}@lgr.test`, username: cashierName, password: PASSWORD, firstName: 'E2E', lastName: 'Counter', role: 'manager' })
    cashier = await apiLogin('acme-corp', cashierName, PASSWORD)
    till = await openTillSession(cashier)

    const { products } = await ok(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
    article = (products || []).find((p: any) => (p.stockAvailable ?? 0) >= 6 && p.unitPrice > 0)
    expect(article, 'an article with stock at the store — is the DB seeded?').toBeTruthy()
    const rate = article.taxRate || 0
    const group = rate >= 18 ? 1 : rate >= 7 ? 3 : 0 // Б, Г, А: the rate's group
    const rates = [0, 20, 20, 9, 0, 0, 0, 0]
    rates[group] = rate
    await fetch(`${STUB}/reset`, { method: 'POST', body: JSON.stringify({ rates }) })

    const { contact } = await ok(admin, 'POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Клиент ${cashierName}` })
    customer = contact.id || contact._id

    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId: till.warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (simulated)', deviceNumber: SERIAL, manufacturer: 'eltrade', connectionType: 'tcp', connectionParams: params, warehouseId: till.warehouseId,
      })
      deviceId = created.fiscalDevice?.id || created.fiscalDevice?._id
    }
    const connected = await call(admin, 'POST', `/fiscal/device/${deviceId}/connect`)
    expect(connected.status, `connect → ${JSON.stringify(connected.json)} (is the server running with FISCAL_TCP_ALLOW_LOOPBACK=1?)`).toBe(200)

    const { org } = await ok(admin, 'GET', '')
    settingsBefore = org?.settings?.cashRegister
    await gate(true)
  })

  test.afterAll(async () => {
    await paper(true).catch(() => undefined)
    if (admin) await call(admin, 'PUT', '', { settings: { cashRegister: settingsBefore ?? { requireConnectedDevice: false } } })
    if (deviceId) {
      await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
      await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    }
    const open = till ? await call(cashier, 'GET', `/trade/pos/session/${till.id}`) : null
    if (open?.json?.session?.status === 'open') await call(cashier, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
  })

  test('a cash invoice issued at the counter prints its lines and „Фактура № …", and is paid', async ({ page }) => {
    const { id, total } = await draft('cash', 2)
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(200)

    const { invoice } = await ok(cashier, 'GET', `/invoices/${id}`)
    expect(invoice.status).toBe('paid')
    expect(invoice.invoiceNumber).toMatch(/^INV-/)
    expect(invoice.paymentReceipts).toHaveLength(1)

    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toMatchObject({ kind: 'fiscal', texts: [`Фактура № ${invoice.invoiceNumber}`] })
    expect(printed[0].voided ?? false).toBe(false)
    expect(printed[0].sales).toHaveLength(1)
    expect(printed[0].sales[0].quantity).toBe(2)
    expect(printed[0].total).toBeCloseTo(total, 2)
    expect(printed[0].payments).toEqual([{ mode: 'P', amount: total }])

    // In the journal under its own kind, naming the invoice it paid.
    const number = invoice.paymentReceipts[0].number
    await page.goto(`/invoicing/cash-sales?q=${number}`)
    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByTestId('journal-kind-chip')).toContainText('Invoice payment')
    await expect(row).toContainText(invoice.invoiceNumber)
  })

  test('a part payment prints „Плащане по фактура № …" for that amount; the last one pays the invoice', async ({ page }) => {
    const { id, total } = await draft('bank_transfer', 3)
    await ok(cashier, 'POST', `/invoices/${id}/send`, {})
    const { invoice } = await ok(cashier, 'GET', `/invoices/${id}`)
    const first = cents(total / 3)
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    await page.getByRole('button', { name: 'Record Payment' }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Record Payment' })
    await dialog.getByLabel('Amount').fill(String(first))
    await openSelect(dialog, /Payment Method/i)
    await page.getByRole('option', { name: 'Cash', exact: true }).click()
    await expect(dialog.getByTestId('payment-prints')).toBeVisible()

    let answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(200)
    await expect(dialog).toBeHidden()

    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].total).toBeCloseTo(first, 2)
    expect(printed[0].texts).toEqual([])
    expect(printed[0].sales.map((s: any) => s.text.replace('\n', ' '))).toEqual([`Плащане по фактура № ${invoice.invoiceNumber}`])
    expect((await ok(cashier, 'GET', `/invoices/${id}`)).invoice.status).toBe('partially_paid')

    // The rest, by card: the dialog opens on what is still due.
    await page.getByRole('button', { name: 'Record Payment' }).first().click()
    await expect(dialog.getByLabel('Amount')).toHaveValue(String(cents(total - first)))
    await openSelect(dialog, /Payment Method/i)
    await page.getByRole('option', { name: 'Card', exact: true }).click()
    answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(200)

    const after = (await ok(cashier, 'GET', `/invoices/${id}`)).invoice
    expect(after.status).toBe('paid')
    const all = (await device()).receipts.slice(before)
    expect(all).toHaveLength(2)
    expect(all[1].payments[0].mode).toBe('L')
    expect(cents(all.reduce((s: number, r: any) => s + r.total, 0))).toBe(total)
  })

  test('a failed print leaves it issued and unpaid, says why, and the Pay action takes the money again', async ({ page }) => {
    const { id, total } = await draft('cash')
    const before = (await device()).receipts.filter((r: any) => !r.voided).length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    await paper(false)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(200)

    await expect(page.getByTestId('receipt-error')).toContainText('the receipt did not print')
    const issued = (await ok(cashier, 'GET', `/invoices/${id}`)).invoice
    expect(issued).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(issued.invoiceNumber).toMatch(/^INV-/)

    // Printing fails again, in the dialog: it stays open, says so, and offers to print again.
    await page.getByTestId('receipt-retry').click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Record Payment' })
    let answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(503)
    await expect(dialog.getByTestId('payment-refusal')).toContainText('no payment was recorded')
    await expect(dialog.getByTestId('payment-save')).toContainText('Print again')

    await paper(true)
    answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(200)
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('receipt-error')).toHaveCount(0)

    expect((await ok(cashier, 'GET', `/invoices/${id}`)).invoice).toMatchObject({ status: 'paid', amountPaid: total })
    expect((await device()).receipts.filter((r: any) => !r.voided)).toHaveLength(before + 1)
  })

  test('a cash-on-delivery print that fails at issue prints on its own: no money is taken, and the form asks until it has', async ({ page }) => {
    const { id, total } = await draft('cash_on_delivery')
    const before = (await device()).receipts.filter((r: any) => !r.voided).length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    await paper(false)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(200)

    await expect(page.getByTestId('receipt-error')).toContainText('the receipt did not print')
    // The money is the courier's: nothing here offers to take it.
    await expect(page.getByTestId('receipt-retry')).toHaveCount(0)

    // An unpaid delivery invoice looks like any other, so the document says it, not this page's memory.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('receipt-error')).toContainText('has not printed')

    await paper(true)
    const printing = page.waitForResponse((r: any) => /\/invoices\/[^/]+\/receipt$/.test(r.url()) && r.request().method() === 'POST')
    await page.getByTestId('receipt-print').click()
    expect((await printing).status()).toBe(200)
    await expect(page.getByTestId('receipt-error')).toHaveCount(0)

    const printed = (await device()).receipts.filter((r: any) => !r.voided).slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].payments).toEqual([{ mode: 'R', amount: total }])
    const { invoice } = await ok(cashier, 'GET', `/invoices/${id}`)
    expect(invoice).toMatchObject({ status: 'sent', amountPaid: 0, receiptToPrint: false })
    expect(invoice.paymentReceipts).toHaveLength(1)
  })

  test('no open session: the draft stays a draft and says what to do', async ({ page }) => {
    // Someone who never opened one. The seeded admin may have: the specs share a database.
    const clerk = `e2e-clerk-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${clerk}@lgr.test`, username: clerk, password: PASSWORD, firstName: 'E2E', lastName: 'Clerk', role: 'manager' })
    const { id } = await draft('cash')
    const before = (await device()).frames

    await loginForApp(page, 'acme-corp', clerk, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(409)

    await expect(page.getByTestId('issue-error')).toContainText('Open a session at the till first')
    expect((await ok(admin, 'GET', `/invoices/${id}`)).invoice.status).toBe('draft')
    expect((await device()).frames).toBe(before)
  })

  test('a receipt nothing can prove: the document says why it waits, and the journal asks a manager, twice', async ({ page }) => {
    // Only a process dying mid-print leaves one, so the state is the browser's here: this is the page.
    // What the server does with it is `payment-receipt-proof.flow.test.ts`.
    const { id, total } = await draft('bank_transfer')
    await ok(cashier, 'POST', `/invoices/${id}/send`, {})
    const { receipt } = await ok(cashier, 'POST', `/invoices/${id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: total, method: 'cash' })
    await page.route(`**/invoices/${id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const { json } = await call(cashier, 'GET', `/invoices/${id}`)
      json.invoice.receiptInDoubt = { id: receipt.id, number: receipt.number }
      return route.fulfill({ json })
    })
    await page.route(`**/cash-register/documents/${receipt.id}`, async (route) => {
      const { json } = await call(cashier, 'GET', `/cash-register/documents/${receipt.id}`)
      json.row.fiscal.inDoubt = true
      return route.fulfill({ json })
    })
    let said: unknown
    await page.route(`**/cash-register/documents/${receipt.id}/settle`, (route) => {
      said = route.request().postDataJSON()
      return route.fulfill({ json: { document: {} } })
    })

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    await expect(page.getByTestId('receipt-in-doubt')).toContainText(receipt.number)

    await page.getByTestId('receipt-in-doubt-open').click()
    await expect(page).toHaveURL(new RegExp(`/cash-sales/${receipt.id}/view`))
    await expect(page.getByTestId('receipt-in-doubt')).toContainText('Nothing can prove')

    await page.getByTestId('receipt-settle-not-printed').click()
    expect(said).toBeUndefined()
    await page.getByTestId('receipt-settle-confirm').click()
    await expect.poll(() => said).toEqual({ printed: false })
  })

  test('once printed, its total cannot change and it cannot be voided', async () => {
    const { id } = await draft('cash')
    await ok(cashier, 'POST', `/invoices/${id}/send`, {})
    const moved = await call(cashier, 'PUT', `/invoices/${id}`, { total: 1 })
    expect(moved.status).toBe(409)
    expect(moved.json.code).toBe('fiscally_paid')
    expect((await call(cashier, 'POST', `/invoices/${id}/void`)).json.code).toBe('fiscally_paid')
  })

  test('the session expects the money, and its report says it: invoice payments, on a line of their own', async () => {
    const { expected, report } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    const state = await device()
    const tookCash = state.receipts.filter((r: any) => !r.voided).flatMap((r: any) => r.payments).filter((p: any) => p.mode === 'P')
    expect(expected.cash).toBeCloseTo(cents(tookCash.reduce((s: number, p: any) => s + p.amount, 0)), 2)
    expect(report.counts.payments).toBe(state.receipts.filter((r: any) => !r.voided).length)
    expect(report.counts.sales).toBe(0)
  })
})
