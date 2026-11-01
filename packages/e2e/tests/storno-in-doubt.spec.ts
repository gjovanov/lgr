import { test, expect } from '@playwright/test'
// Relative: Playwright runs specs under Node, which does not resolve the workspace's `config`.
import { computePosTotals } from '../../config/src/pos-totals'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession } from './helpers/cash-register'

/**
 * FR-23: a storno whose print goes `unknown` is held, never voided, on the simulated Eltrade.
 *
 * The paper runs out at the close, with the money on the device. Nothing can prove what it did: the
 * dialog says so, a second press prints nothing, and a person settles it on the document's page. Voided
 * and given back, the next press printed a second fiscal storno. Run it as
 * `cash-register-fiscal.spec.ts` says. Serial: one session, one device, one sale, one storno.
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's
const PASSWORD = 'test12345'
const CLOSE = 0x38

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
const stub = (path: string, body: unknown) => fetch(`${STUB}${path}`, { method: 'POST', body: JSON.stringify(body) })
const closedStornos = (state: any) => state.receipts.filter((r: any) => r.kind === 'storno' && !r.voided)

let admin: Session
let manager: Session
let managerName = ''
let deviceId = ''
let till: { id: string; warehouseId: string }
let sale: any
let stornoId = ''
let stornoNumber = ''
/** What the till rings, at the article's own price and rate. */
let saleBody: Record<string, unknown>

test.describe('FR-23 — a storno that may have printed', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of cash-register-fiscal.spec.ts`).toBe(true)

    admin = await apiLogin()
    managerName = `e2e-doubt-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${managerName}@lgr.test`, username: managerName, password: PASSWORD, firstName: 'E2E', lastName: 'Doubt', role: 'manager' })
    manager = await apiLogin('acme-corp', managerName, PASSWORD)
    till = await openTillSession(manager)

    const { products } = await ok(manager, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
    const article = (products || []).find((p: any) => (p.stockAvailable ?? 0) >= 2 && p.unitPrice > 0)
    expect(article, 'an article with stock at the store — is the DB seeded?').toBeTruthy()
    const rate = Number(article.taxRate || 0)
    // A device whose VAT group for that rate carries it, as `cash-register-fiscal.spec.ts` programs it.
    const rates = [0, 20, 20, 9, 0, 0, 0, 0]
    rates[rate >= 18 ? 1 : rate >= 7 ? 3 : 0] = rate
    await stub('/reset', { rates })

    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId: till.warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (doubt)', deviceNumber: SERIAL, manufacturer: 'eltrade', connectionType: 'tcp', connectionParams: params, warehouseId: till.warehouseId,
      })
      deviceId = created.fiscalDevice?.id || created.fiscalDevice?._id
    }
    const connected = await call(admin, 'POST', `/fiscal/device/${deviceId}/connect`)
    expect(connected.status, `connect → ${JSON.stringify(connected.json)} (is the server running with FISCAL_TCP_ALLOW_LOOPBACK=1?)`).toBe(200)

    const line = { productId: article.productId, name: article.productName, quantity: 1, unitPrice: article.unitPrice, discount: 0, taxRate: rate }
    const t = computePosTotals([{ quantity: 1, unitPrice: article.unitPrice, taxRate: rate, discount: 0 }])
    saleBody = {
      type: 'sale', lines: [{ ...line, taxAmount: t.taxTotal, lineTotal: t.subtotal }],
      subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'cash', amount: t.total }], changeDue: 0, nonFiscal: false,
    }
    const rung = await ok(manager, 'POST', `/trade/pos/session/${till.id}/transaction`, saleBody)
    sale = rung.transaction
    expect(sale.fiscalReceiptNumber).toBeTruthy()
  })

  test.afterAll(async () => {
    await stub('/fault', {}).catch(() => undefined)
    await stub('/paper', { on: true }).catch(() => undefined)
    if (deviceId) {
      await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
      await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    }
    const open = till ? await call(manager, 'GET', `/trade/pos/session/${till.id}`) : null
    if (open?.json?.session?.status === 'open') await call(manager, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
    await stub('/reset', {}).catch(() => undefined)
  })

  test('the paper runs out at its close: the dialog says what is true, and it is not voided', async ({ page }) => {
    await stub('/fault', { paperOutAt: CLOSE })
    await loginForApp(page, 'acme-corp', managerName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${sale.id}/view`)
    await page.getByTestId('storno-button').click()
    const confirm = page.getByTestId('storno-confirm')
    await expect(confirm).toBeEnabled({ timeout: 15000 })

    const answering = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${sale.id}/storno`) && r.request().method() === 'POST')
    await confirm.click()
    const answer = await answering

    expect(answer.status()).toBe(409)
    const body = await answer.json()
    expect(body.code).toBe('storno_in_doubt')
    stornoId = body.receipt.id
    stornoNumber = body.receipt.number
    const message = page.getByTestId('storno-error')
    await expect(message).toContainText('may have printed')
    await expect(message).toContainText('Do not press storno again')
    await expect(confirm).toBeDisabled()
    // The page reads the sale again behind the dialog. What it said stays, and so does the button.
    await expect(page.getByTestId('journal-document-status')).toContainText('Stornoed')
    await expect(message).toContainText('Do not press storno again')
    await expect(confirm).toBeDisabled()

    const { row } = await ok(manager, 'GET', `/cash-register/documents/${stornoId}`)
    expect(row).toMatchObject({ kind: 'storno', status: 'inDoubt', fiscal: { state: 'unknown', inDoubt: true } })
    const state = await device()
    expect(closedStornos(state)).toHaveLength(0)
    expect(state.receiptOpen).toBe(true)
    // Nothing was refunded, and the session says why it cannot close.
    const preview = await ok(manager, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(preview.report.counts).toMatchObject({ sales: 1, stornos: 0 })
    expect(preview.unfinishedReceipts).toEqual([expect.objectContaining({ id: stornoId, inDoubt: true, kind: 'storno' })])
    const refused = await call(manager, 'POST', `/trade/pos/session/${till.id}/close`, { counted: { cash: 0 } })
    expect(refused.json.code).toBe('receipts_unfinished')
    expect((await device()).closure).toBe(state.closure)
  })

  test('a second press is refused, says the same, and prints nothing more', async () => {
    const before = await device()

    const again = await call(manager, 'POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'customer_return', sessionId: till.id })

    expect(again.status).toBe(409)
    expect(again.json.code).toBe('storno_in_doubt')
    expect(again.json.receipt.id).toBe(stornoId)
    const after = await device()
    expect(after.fiscalCommands).toBe(before.fiscalCommands)
    expect(after.receipts).toHaveLength(before.receipts.length)
  })

  test('the document page: a receipt still open is not final, and the person settles it once it is cleared', async ({ page }) => {
    await loginForApp(page, 'acme-corp', managerName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${stornoId}/view`)
    await expect(page.getByTestId('receipt-in-doubt')).toContainText('Nothing can prove whether this storno printed')
    await expect(page.getByTestId('journal-document-status')).toContainText('In doubt')

    // The money is on the device and its receipt is open: what the device does next decides.
    await page.getByTestId('receipt-settle-not-printed').click()
    const refusing = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${stornoId}/settle`))
    await page.getByTestId('receipt-settle-confirm').click()
    expect((await refusing).status()).toBe(409)
    await expect(page.getByText('A receipt is still open on the fiscal device')).toBeVisible()
    await expect(page.getByTestId('receipt-in-doubt')).toBeVisible()

    // Paper back, and the X report it asks for clears it: the storno is finished, on paper, once.
    await stub('/fault', {})
    await stub('/paper', { on: true })
    await ok(admin, 'POST', `/fiscal/device/${deviceId}/x-report`)
    expect(closedStornos(await device())).toHaveLength(1)

    await page.getByTestId('receipt-settle-printed').click()
    const settling = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${stornoId}/settle`))
    await page.getByTestId('receipt-settle-confirm').click()
    expect((await settling).status()).toBe(200)
    await expect(page.getByTestId('receipt-in-doubt')).toHaveCount(0)
    await expect(page.getByTestId('journal-document-status')).toContainText('Completed')
    await expect(page.getByText('Storno settled')).toBeVisible()
  })

  test('a sale that may have printed: no storno is offered, the page asks for the number off the slip, and its storno cites it', async ({ page }) => {
    await stub('/fault', { paperOutAt: CLOSE })
    const rung = await ok(manager, 'POST', `/trade/pos/session/${till.id}/transaction`, saleBody)
    await stub('/fault', {})
    await stub('/paper', { on: true })
    const inDoubt = rung.transaction
    expect(inDoubt.fiscal.state).toBe('unknown')

    const refused = await call(manager, 'POST', `/cash-register/documents/${inDoubt.id}/storno`, { reason: 'customer_return', sessionId: till.id })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('sale_receipt_in_doubt')

    await ok(admin, 'POST', `/fiscal/device/${deviceId}/x-report`)
    const onTheSlip = (await device()).receipts.at(-1).number

    await loginForApp(page, 'acme-corp', managerName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${inDoubt.id}/view`)
    await expect(page.getByTestId('receipt-in-doubt')).toContainText('fiscal receipt printed')
    await expect(page.getByTestId('storno-button')).toHaveCount(0)

    await page.getByTestId('receipt-settle-printed').click()
    const confirm = page.getByTestId('receipt-settle-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('receipt-settle-number').locator('input').fill('ФБ-1')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('receipt-settle-number').locator('input').fill(onTheSlip)
    const settling = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${inDoubt.id}/settle`))
    await confirm.click()
    expect((await settling).status()).toBe(200)
    await expect(page.getByTestId('receipt-in-doubt')).toHaveCount(0)
    await expect(page.getByTestId('storno-button')).toBeVisible()

    await ok(manager, 'POST', `/cash-register/documents/${inDoubt.id}/storno`, { reason: 'customer_return', sessionId: till.id })
    const cited = (await device()).receipts.at(-1)
    expect(cited.kind).toBe('storno')
    expect(cited.header[5]).toBe(onTheSlip)
  })

  test('the device holds one storno for each, the refunds are booked once, and the session closes', async () => {
    const state = await device()
    expect(closedStornos(state)).toHaveLength(2)
    expect(closedStornos(state)[0].header[5]).toBe(sale.fiscalReceiptNumber)

    const { row } = await ok(manager, 'GET', `/cash-register/documents/${stornoId}`)
    expect(row).toMatchObject({ number: stornoNumber, status: 'completed', fiscal: { state: 'printed' } })
    expect(row.stock).toBe('moved')
    const preview = await ok(manager, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(preview.report.counts).toMatchObject({ sales: 2, stornos: 2 })
    expect(preview.report.total).toBe(0)
    expect(preview.unfinishedReceipts).toEqual([])

    expect((await call(manager, 'POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'customer_return', sessionId: till.id })).status).toBe(400)
    expect(closedStornos(await device())).toHaveLength(2)

    const closed = await ok(manager, 'POST', `/trade/pos/session/${till.id}/close`, { counted: { cash: preview.expected.cash, card: preview.expected.card, other: preview.expected.other ?? 0 } })
    expect(closed.fiscalStatus).toBe('closed')
  })
})
