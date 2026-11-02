import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession } from './helpers/cash-register'
import { openSelect } from './helpers/vuetify'

/**
 * FR-23 R2 — a credit note refunded in cash or by card prints a storno of the receipt that paid its
 * invoice, on the simulated Eltrade. The credit note takes the goods back, once; the storno moves money.
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
const fault = (body: Record<string, number>) => fetch(`${STUB}/fault`, { method: 'POST', body: JSON.stringify(body) })
/** The device's close of a receipt: past its money. */
const CLOSE = 0x38
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

/** A draft for `quantity` of the article, by `method`, as the form would save it. */
async function draft(method: string, quantity = 1, extra: Record<string, unknown> = {}) {
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
    ...extra,
  })
  return { id: String(invoice.id), total }
}

/** A cash invoice issued and paid at the counter: its receipt on the device. */
async function paidInvoice(quantity = 2) {
  const inv = await draft('cash', quantity)
  await ok(cashier, 'POST', `/invoices/${inv.id}/send`, {})
  const { invoice } = await ok(cashier, 'GET', `/invoices/${inv.id}`)
  expect(invoice.status).toBe('paid')
  return { ...inv, invoice, receipt: invoice.paymentReceipts[0] }
}

const creditNote = (invoiceId: string, method: string, quantity = 2) => draft(method, quantity, { type: 'credit_note', relatedInvoiceId: invoiceId })

const onHand = async () => {
  const { products } = await ok(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
  return (products || []).find((p: any) => p.productId === article.productId).stockAvailable as number
}

const issuing = (page: any) => page.waitForResponse((r: any) => /\/invoices\/[^/]+\/send$/.test(r.url()) && r.request().method() === 'POST')
const paying = (page: any) => page.waitForResponse((r: any) => /\/invoices\/[^/]+\/payments$/.test(r.url()) && r.request().method() === 'POST')

test.describe('FR-23 R2 — a storno for a refund on a credit note', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of cash-register-fiscal.spec.ts`).toBe(true)

    admin = await apiLogin()
    // A fiscal receipt names its operator: a user created through the API gets a code. A manager may reverse money (H4).
    cashierName = `e2e-refund-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${cashierName}@lgr.test`, username: cashierName, password: PASSWORD, firstName: 'E2E', lastName: 'Refund', role: 'manager' })
    cashier = await apiLogin('acme-corp', cashierName, PASSWORD)
    till = await openTillSession(cashier)

    const { products } = await ok(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
    article = (products || []).find((p: any) => (p.stockAvailable ?? 0) >= 12 && p.unitPrice > 0)
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
    await fault({}).catch(() => undefined)
    await paper(true).catch(() => undefined)
    if (admin) await call(admin, 'PUT', '', { settings: { cashRegister: settingsBefore ?? { requireConnectedDevice: false } } })
    if (deviceId) {
      await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
      await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    }
    const open = till ? await call(cashier, 'GET', `/trade/pos/session/${till.id}`) : null
    if (open?.json?.session?.status === 'open') await call(cashier, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
  })

  test('a credit note issued in cash through the UI prints a storno citing the original УНП, and the stock returns once', async ({ page }) => {
    const inv = await paidInvoice(2)
    const stock = await onHand()
    const note = await creditNote(inv.id, 'cash', 2)
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${note.id}/edit`)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(200)

    const { invoice: issued } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(issued.status).toBe('paid')
    expect(issued.amountPaid).toBe(note.total)
    expect(issued.paymentReceipts).toHaveLength(1)

    // The device saw one storno, citing the receipt that paid the invoice: its УНП and its number.
    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('storno')
    expect(printed[0].voided ?? false).toBe(false)
    expect(printed[0].header[1]).toBe(inv.receipt.unp)
    expect(printed[0].header[2]).toBe('S')
    expect(printed[0].header[5]).toBe(inv.receipt.receiptNumber)
    expect(printed[0].sales.map((s: any) => s.text.replace(/\s+/g, ' '))).toEqual([`Връщане по кредитно известие № ${issued.invoiceNumber}`])
    expect(printed[0].payments).toEqual([{ mode: 'P', amount: note.total }])

    // The goods came back with the credit note, and only with it.
    expect(await onHand()).toBe(stock + 2)

    // In the journal under its own kind, naming the credit note.
    const number = issued.paymentReceipts[0].number
    await page.goto(`/invoicing/cash-sales?q=${number}`)
    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: number, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByTestId('journal-kind-chip')).toContainText('Credit note refund')
    await expect(row).toContainText(issued.invoiceNumber)
  })

  test('a refund recorded later: the Refund action, the server saying what prints and what the receipts hold, and a partial storno', async ({ page }) => {
    const inv = await paidInvoice(2)
    const note = await creditNote(inv.id, 'bank_transfer', 2)
    await ok(cashier, 'POST', `/invoices/${note.id}/send`, {})
    const { invoice: issued } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(issued.printsOnPayment).toEqual(['cash', 'card'])
    const part = cents(note.total / 2)
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${note.id}/edit`)
    await page.getByRole('button', { name: 'Refund', exact: true }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Refund' })
    await dialog.getByLabel('Amount').fill(String(part))
    await openSelect(dialog, /Payment Method/i)
    await page.getByRole('option', { name: 'Cash', exact: true }).click()
    await expect(dialog.getByTestId('payment-prints')).toContainText('storno')
    await expect(dialog.getByTestId('refund-holds')).toBeVisible()

    const answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(200)
    await expect(dialog).toBeHidden()

    const printed = (await device()).receipts.slice(before)
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('storno')
    expect(printed[0].header[5]).toBe(inv.receipt.receiptNumber)
    expect(printed[0].payments).toEqual([{ mode: 'P', amount: part }])
    const { invoice: after } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(after.status).toBe('partially_paid')
    expect(after.amountPaid).toBe(part)
  })

  test('no receipt to storno: refused in words the person can act on, the draft a draft, and the bank takes it', async ({ page }) => {
    const inv = await draft('bank_transfer', 1)
    await ok(cashier, 'POST', `/invoices/${inv.id}/send`, {})
    const note = await creditNote(inv.id, 'cash', 1)
    const before = (await device()).receipts.length

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${note.id}/edit`)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    const refused = await sending
    expect(refused.status()).toBe(409)
    expect((await refused.json()).code).toBe('no_receipt_to_storno')
    await expect(page.getByText(/Refund it by bank/).first()).toBeVisible()

    expect((await ok(cashier, 'GET', `/invoices/${note.id}`)).invoice.status).toBe('draft')
    expect((await device()).receipts).toHaveLength(before)

    await ok(cashier, 'PUT', `/invoices/${note.id}`, { paymentMethod: 'bank_transfer' })
    await ok(cashier, 'POST', `/invoices/${note.id}/send`, {})
    await ok(cashier, 'POST', `/invoices/${note.id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: note.total, method: 'bank_transfer' })
    expect((await ok(cashier, 'GET', `/invoices/${note.id}`)).invoice.status).toBe('paid')
    expect((await device()).receipts).toHaveLength(before)
  })

  test('a failed print leaves it issued and unrefunded, says why, and the Refund action gives it', async ({ page }) => {
    const inv = await paidInvoice(1)
    const note = await creditNote(inv.id, 'cash', 1)

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/invoices/${note.id}/edit`)
    await paper(false)
    const sending = issuing(page)
    await page.getByRole('button', { name: 'Issue', exact: true }).first().click()
    expect((await sending).status()).toBe(200)
    await paper(true)

    const notice = page.getByTestId('receipt-error')
    await expect(notice).toContainText('nothing was refunded')
    const { invoice: failed } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(failed.status).toBe('sent')
    expect(failed.amountPaid ?? 0).toBe(0)

    await notice.getByTestId('receipt-retry').click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Refund' })
    await expect(dialog.getByLabel('Amount')).toHaveValue(String(note.total))
    const answer = paying(page)
    await dialog.getByTestId('payment-save').click()
    expect((await answer).status()).toBe(200)
    expect((await ok(cashier, 'GET', `/invoices/${note.id}`)).invoice.status).toBe('paid')
  })

  test('once a storno printed, its total cannot change and it cannot be voided', async () => {
    const inv = await paidInvoice(1)
    const note = await creditNote(inv.id, 'cash', 1)
    await ok(cashier, 'POST', `/invoices/${note.id}/send`, {})
    const edit = await call(cashier, 'PUT', `/invoices/${note.id}`, { total: cents(note.total / 2) })
    expect(edit.status).toBe(409)
    expect(edit.json.code).toBe('fiscally_paid')
    expect((await call(cashier, 'POST', `/invoices/${note.id}/void`)).status).toBe(409)
  })

  test('the session expects the money back, and its report says it on a line of its own', async ({ page }) => {
    const { report, expected } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(report.counts.refunds).toBeGreaterThan(0)
    expect(report.counts.payments).toBeGreaterThan(0)
    expect(cents(report.byMethod.cash + (await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)).session.openingBalance)).toBe(expected.cash)

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    const { session } = await ok(cashier, 'GET', `/trade/pos/session/${till.id}`)
    await page.goto('/pos/sessions')
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: session.sessionNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByTestId('session-report-open').click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('session-report') })
    await expect(dialog.getByTestId('session-report-refunds')).toContainText(String(report.counts.refunds))
  })

  test('a receipt in doubt: printed asks for the number off its slip, since a refund cites it, and goes on without one', async ({ page }) => {
    // Only a process dying mid-print leaves one, so the state is the browser's here: this is the page.
    // What the server does with what they say is `cash-invoice-refunds.flow.test.ts`.
    const { id, total } = await draft('bank_transfer')
    await ok(cashier, 'POST', `/invoices/${id}/send`, {})
    const { receipt } = await ok(cashier, 'POST', `/invoices/${id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: total, method: 'cash' })
    const receiptId = receipt.id
    await page.route(`**/cash-register/documents/${receiptId}`, async (route) => {
      const { json } = await call(cashier, 'GET', `/cash-register/documents/${receiptId}`)
      json.row.fiscal.inDoubt = true
      return route.fulfill({ json })
    })
    const said: unknown[] = []
    await page.route(`**/cash-register/documents/${receiptId}/settle`, (route) => {
      said.push(route.request().postDataJSON())
      return route.fulfill({ json: { document: {} } })
    })

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${receiptId}/view`)
    await page.getByTestId('receipt-settle-printed').click()

    const number = page.getByTestId('receipt-settle-number')
    const confirm = page.getByTestId('receipt-settle-confirm')
    await expect(page.getByText('this receipt can only be refunded by bank')).toBeVisible()
    await expect(confirm).toBeEnabled()
    // Letters are no number a storno can cite.
    await number.locator('input').fill('ФБ-1')
    await expect(confirm).toBeDisabled()
    await number.locator('input').fill('123')
    await confirm.click()
    await expect.poll(() => said).toEqual([{ printed: true, receiptNumber: '123' }])

    // Not printed asks for nothing: nothing printed.
    await page.getByTestId('receipt-settle-not-printed').click()
    await expect(number).toHaveCount(0)
    await confirm.click()
    await expect.poll(() => said.length).toBe(2)
    expect(said[1]).toEqual({ printed: false })

    // And printed, with nothing typed, says nothing about a number.
    await page.getByTestId('receipt-settle-printed').click()
    await number.locator('input').fill('')
    await confirm.click()
    await expect.poll(() => said.length).toBe(3)
    expect(said[2]).toEqual({ printed: true })
  })

  test('a storno that may have printed: nothing is refunded, a second press prints nothing, and a person settles it on its page', async ({ page }) => {
    const inv = await paidInvoice(1)
    const note = await creditNote(inv.id, 'bank_transfer', 1)
    await ok(cashier, 'POST', `/invoices/${note.id}/send`, {})
    const press = () => call(cashier, 'POST', `/invoices/${note.id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: note.total, method: 'cash' })

    // The roll runs out at its close: its money is on the device, and the receipt is still open.
    await fault({ paperOutAt: CLOSE })
    const first = await press()
    expect(first.status).toBe(409)
    expect(first.json.code).toBe('receipt_in_doubt')
    const stornoId = first.json.receipt.id
    expect((await device()).receiptOpen).toBe(true)
    const { invoice: held } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(held.status).toBe('sent')
    expect(held.amountPaid ?? 0).toBe(0)

    const before = await device()
    const again = await press()
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_in_doubt')
    expect(again.json.receipt.id).toBe(stornoId)
    expect((await device()).fiscalCommands).toBe(before.fiscalCommands)

    // The session names it, and will not close over it.
    const preview = await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(preview.unfinishedReceipts).toEqual([expect.objectContaining({ id: stornoId, inDoubt: true, kind: 'refund' })])

    await loginForApp(page, 'acme-corp', cashierName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${stornoId}/view`)
    await expect(page.getByTestId('receipt-in-doubt')).toContainText('so nothing was refunded')
    await expect(page.getByTestId('journal-document-status')).toContainText('In doubt')

    // Still open on the device: what the device does next decides, so nothing is final.
    await page.getByTestId('receipt-settle-not-printed').click()
    await expect(page.getByRole('dialog').filter({ hasText: 'It is voided with its number' })).toBeVisible()
    const refusing = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${stornoId}/settle`))
    await page.getByTestId('receipt-settle-confirm').click()
    expect((await refusing).status()).toBe(409)
    await expect(page.getByText('A receipt is still open on the fiscal device')).toBeVisible()
    await expect(page.getByTestId('receipt-in-doubt')).toBeVisible()

    // Paper back, and the X report it asks for clears it: finished on paper, once.
    await fault({})
    await paper(true)
    await ok(admin, 'POST', `/fiscal/device/${deviceId}/x-report`)

    await page.getByTestId('receipt-settle-printed').click()
    await expect(page.getByRole('dialog').filter({ hasText: 'The refund is recorded on the credit note' })).toBeVisible()
    // A storno asks for no number: it is what cites one.
    await expect(page.getByTestId('receipt-settle-number')).toHaveCount(0)
    const settling = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${stornoId}/settle`))
    await page.getByTestId('receipt-settle-confirm').click()
    expect((await settling).status()).toBe(200)
    await expect(page.getByTestId('receipt-in-doubt')).toHaveCount(0)
    await expect(page.getByTestId('journal-document-status')).toContainText('Completed')
    await expect(page.getByText('Storno settled')).toBeVisible()

    const { invoice: refunded } = await ok(cashier, 'GET', `/invoices/${note.id}`)
    expect(refunded.status).toBe('paid')
    expect(refunded.amountPaid).toBe(note.total)
    expect((await ok(cashier, 'GET', `/trade/pos/session/${till.id}/close-preview`)).unfinishedReceipts).toEqual([])
  })
})
