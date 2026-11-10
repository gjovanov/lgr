import { test, expect } from '@playwright/test'
// Relative: Playwright runs specs under Node, which does not resolve the workspace's `config`.
import { computePosTotals } from '../../config/src/pos-totals'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'
import { openTillSession, tillCatalog } from './helpers/cash-register'

/**
 * FR-23 R3 (#363): a customer brings back one of two articles, through the storno dialog, on the simulated Eltrade.
 *
 * All of it stays the default and one press. "Part of it" names a line and how much of it, says what goes back, and
 * prints only that, citing the sale's УНП and number. The journal says „частично", and what is left goes back by one
 * press of all of it, and the session closes on a difference of 0. Run it as `cash-register-fiscal.spec.ts` says.
 * Serial: one session, one device, one sale.
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's
const PASSWORD = 'e2e-test-pw-12345'
const LAST_NUMBER = 100_000 + (Date.now() % 800_000)
const INVOICE_ACTION = 'Issue invoice'

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
/** An amount as the page writes it, whichever separator its locale takes. */
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '[.,]'))

let admin: Session
let manager: Session
let managerName = ''
let deviceId = ''
let till: { id: string; warehouseId: string }
let sale: any
let first: { name: string; unitPrice: number; rate: number }
let saleTotal = 0
let partAmount = 0

test.describe('FR-23 R3 — the till\'s partial storno', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of cash-register-fiscal.spec.ts`).toBe(true)

    admin = await apiLogin()
    managerName = `e2e-part-${Date.now().toString(36)}`
    await ok(admin, 'POST', '/user', { email: `${managerName}@lgr.test`, username: managerName, password: PASSWORD, firstName: 'E2E', lastName: 'Part', role: 'manager' })
    manager = await apiLogin('acme-corp', managerName, PASSWORD)
    till = await openTillSession(manager)

    const products = await tillCatalog(manager, till.warehouseId)
    const articles = (products || []).filter((p: any) => (p.stockAvailable ?? 0) >= 3 && p.unitPrice > 0)
    // Two of one VAT rate, so one VAT group on the device.
    const rate = Number(articles[0]?.taxRate || 0)
    const two = articles.filter((p: any) => Number(p.taxRate || 0) === rate).slice(0, 2)
    expect(two.length, 'two articles with stock at the store — is the DB seeded?').toBe(2)
    const rates = [0, 20, 20, 9, 0, 0, 0, 0]
    rates[rate >= 18 ? 1 : rate >= 7 ? 3 : 0] = rate
    await stub('/reset', { rates, lastDocNumber: LAST_NUMBER })

    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId: till.warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (part)', deviceNumber: SERIAL, manufacturer: 'eltrade', connectionType: 'tcp', connectionParams: params, warehouseId: till.warehouseId,
      })
      deviceId = created.fiscalDevice?.id || created.fiscalDevice?._id
    }
    const connected = await call(admin, 'POST', `/fiscal/device/${deviceId}/connect`)
    expect(connected.status, `connect → ${JSON.stringify(connected.json)} (is the server running with FISCAL_TCP_ALLOW_LOOPBACK=1?)`).toBe(200)

    const quantities = [3, 1]
    const lines = two.map((a: any, i: number) => {
      const net = quantities[i] * a.unitPrice
      return { productId: a.productId, name: a.productName, quantity: quantities[i], unitPrice: a.unitPrice, discount: 0, taxRate: rate, lineTotal: Math.round(net * 100) / 100, taxAmount: Math.round(((net * rate) / 100) * 100) / 100 }
    })
    first = { name: two[0].productName, unitPrice: two[0].unitPrice, rate }
    const t = computePosTotals(lines)
    saleTotal = t.total
    const rung = await ok(manager, 'POST', `/trade/pos/session/${till.id}/transaction`, {
      type: 'sale', lines, subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'cash', amount: t.total }], changeDue: 0,
    })
    sale = rung.transaction
    expect(sale.fiscalReceiptNumber).toBeTruthy()
  })

  test.afterAll(async () => {
    if (deviceId) {
      await call(admin, 'POST', `/fiscal/device/${deviceId}/disconnect`)
      await call(admin, 'DELETE', `/fiscal/device/${deviceId}`)
    }
    const open = till ? await call(manager, 'GET', `/trade/pos/session/${till.id}`) : null
    if (open?.json?.session?.status === 'open') await call(manager, 'POST', `/trade/pos/session/${till.id}/close`, { closeWithoutFiscal: true, closingBalance: 0 })
    await stub('/reset', {}).catch(() => undefined)
  })

  test('one article comes back through the dialog: only its line prints, citing the sale, and the journal says part', async ({ page }) => {
    await loginForApp(page, 'acme-corp', managerName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${sale.id}/view`)
    await page.getByTestId('storno-button').click()

    // All of it is the default and the fast path: confirm is there at once, with nothing to pick.
    const confirm = page.getByTestId('storno-confirm')
    await expect(confirm).toBeEnabled({ timeout: 15000 })
    await expect(page.getByTestId('storno-lines')).toHaveCount(0)

    await page.getByTestId('storno-part').click()
    await expect(page.getByTestId('storno-line')).toHaveCount(2)
    // A part with nothing picked, or with more than is left, cannot be confirmed.
    await expect(confirm).toBeDisabled()
    const quantity = page.getByTestId('storno-line-quantity').first().locator('input')
    await quantity.fill('4')
    await expect(confirm).toBeDisabled()
    await quantity.fill('1')
    await expect(confirm).toBeEnabled()

    partAmount = computePosTotals([{ quantity: 1, unitPrice: first.unitPrice, taxRate: first.rate }]).total
    await expect(page.getByTestId('storno-amount')).toContainText(money(partAmount))

    const answering = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${sale.id}/storno`) && r.request().method() === 'POST')
    await confirm.click()
    const answer = await answering
    expect(answer.status(), JSON.stringify(await answer.json())).toBe(200)

    const printed = closedStornos(await device())
    expect(printed).toHaveLength(1)
    expect(printed[0].sales).toHaveLength(1)
    expect(printed[0].sales[0].quantity).toBe(1)
    expect(printed[0].total).toBe(partAmount)
    expect(printed[0].payments).toEqual([{ mode: 'P', amount: partAmount }])
    expect(printed[0].header[1]).toBe(sale.unpNumber)
    expect(printed[0].header[5]).toBe(sale.fiscalReceiptNumber)

    await expect(page.getByTestId('journal-document-status')).toContainText('Partly stornoed')
    await expect(page.getByTestId('journal-line-returned').first()).toBeVisible()
    const { row, lines } = await ok(manager, 'GET', `/cash-register/documents/${sale.id}`)
    expect(row.status).toBe('partial')
    expect(lines.map((l: any) => [l.returned, l.left])).toEqual([[1, 2], [0, 1]])

    // The journal's list carries the badge too, and its filter finds it.
    await page.goto(`/invoicing/cash-sales?q=${row.number}`)
    const listed = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: row.number, exact: true }) })
    await expect(listed.getByTestId('journal-status-chip')).toContainText('Partly stornoed', { timeout: 15000 })
    // What is left can still be invoiced, and still go back.
    await expect(listed.getByRole('button', { name: INVOICE_ACTION })).toBeVisible()
    await expect(listed.getByTestId('storno-button')).toBeVisible()
    expect((await ok(manager, 'GET', '/cash-register/documents?status=partial&size=100')).rows.map((r: any) => r.id)).toContain(sale.id)
  })

  test('what is left goes back by one press, and the session closes on a difference of 0', async ({ page }) => {
    await loginForApp(page, 'acme-corp', managerName, PASSWORD)
    await page.goto(`/invoicing/cash-sales/${sale.id}/view`)
    await page.getByTestId('storno-button').click()
    await expect(page.getByTestId('storno-left')).toContainText(money(saleTotal - partAmount), { timeout: 15000 })
    await expect(page.getByTestId('storno-whole')).toContainText('All that is left')

    const answering = page.waitForResponse(r => r.url().endsWith(`/cash-register/documents/${sale.id}/storno`) && r.request().method() === 'POST')
    await page.getByTestId('storno-confirm').click()
    expect((await answering).status()).toBe(200)

    const printed = closedStornos(await device())
    expect(printed).toHaveLength(2)
    expect(printed[1].sales).toHaveLength(2)
    expect(Math.round((printed[0].total + printed[1].total) * 100)).toBe(Math.round(saleTotal * 100))
    await expect(page.getByTestId('journal-document-status')).toContainText('Stornoed')
    await expect(page.getByTestId('storno-button')).toHaveCount(0)

    const preview = await ok(manager, 'GET', `/trade/pos/session/${till.id}/close-preview`)
    expect(preview.report.total).toBe(0)
    expect(preview.report.counts).toMatchObject({ sales: 1, stornos: 2 })
    expect(preview.unfinishedReceipts).toEqual([])
    const closed = await ok(manager, 'POST', `/trade/pos/session/${till.id}/close`, { counted: { cash: preview.expected.cash, card: preview.expected.card, other: preview.expected.other ?? 0 } })
    expect(closed.session.closingBreakdown.find((b: any) => b.method === 'cash').difference).toBe(0)
  })
})
