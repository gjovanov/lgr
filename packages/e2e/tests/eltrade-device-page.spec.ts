import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { loginForApp } from './helpers/login'

/**
 * POS → Devices → an Eltrade: every report the device has prints from its card and reaches the
 * device; what its protocol lacks (reading operators back, an operator report, the electronic
 * journal) is disabled with the reason, instead of answering "not supported" after a click; and an
 * admin names the reserve payment slot „НАЛОЖЕН ПЛАТЕЖ" for cash on delivery in one click.
 *
 * The device is `scripts/eltrade-tcp-stub.ts` — the integration tests' `EltradeSimulator` behind
 * TCP — as in cash-register-fiscal.spec.ts, which shares the stub and the device row (serial
 * ED123456): run the project with `--workers=1`.
 *
 *   bun packages/e2e/scripts/eltrade-tcp-stub.ts &
 *   cd packages/portal-api && FISCAL_TCP_ALLOW_LOOPBACK=1 bun src/unified.ts
 *   cd packages/e2e && bunx playwright test --project=cash-register-fiscal --workers=1
 */
test.describe.configure({ mode: 'serial' })

const API = process.env.BASE_URL || 'http://localhost:4001'
const STUB_PORT = Number(process.env.ELTRADE_STUB_PORT) || 8299
const STUB = `http://127.0.0.1:${STUB_PORT + 1}`
const SERIAL = 'ED123456' // the simulator's

/** 45h daily report; 4Fh/5Eh fiscal memory by date (short/detailed); 5Fh/49h by number. */
const CMD = { DAILY: 0x45, FM_DATE: 0x4F, FM_DATE_DETAILED: 0x5E, FM_NUMBER: 0x5F, FM_NUMBER_DETAILED: 0x49 }

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
/** The report the device recorded last, once it has recorded `count`. */
const lastReport = async (count: number) => {
  await expect.poll(async () => (await device()).reports.length, { timeout: 15000 }).toBe(count)
  return (await device()).reports.at(-1)
}

let admin: Session
let deviceId = ''

test.describe('the device page on an Eltrade', () => {
  test.beforeAll(async () => {
    const reachable = await fetch(`${STUB}/state`).then(r => r.ok, () => false)
    expect(reachable, `the Eltrade stub is not running on ${STUB} — see the header of this spec`).toBe(true)
    await fetch(`${STUB}/reset`, { method: 'POST', body: '{}' })

    admin = await apiLogin()
    const { warehouses } = await ok(admin, 'GET', '/warehouse/warehouse?size=1')
    const warehouseId = warehouses?.[0]?._id || warehouses?.[0]?.id
    expect(warehouseId, 'a warehouse — is the DB seeded?').toBeTruthy()

    // One row per serial per org: cash-register-fiscal.spec.ts uses the same one.
    const params = { ip: '127.0.0.1', tcpPort: STUB_PORT }
    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const existing = (fiscalDevices || []).find((d: any) => d.deviceNumber === SERIAL)
    if (existing) {
      deviceId = existing.id || existing._id
      await ok(admin, 'PUT', `/fiscal/device/${deviceId}`, { isActive: true, warehouseId, connectionType: 'tcp', connectionParams: params, manufacturer: 'eltrade' })
    } else {
      const created = await ok(admin, 'POST', '/fiscal/device', {
        name: 'E2E Eltrade (simulated)', deviceNumber: SERIAL, manufacturer: 'eltrade',
        connectionType: 'tcp', connectionParams: params, warehouseId,
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
  })

  test('every report the device has prints from its card, and the device records it', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/pos/devices/${deviceId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Reports/i }).click()
    const card = (feature: string) => page.getByTestId(`report-${feature}`)

    // Read Status: the device answers with its own serial.
    const status = page.locator('.v-card', { hasText: 'Device Status' })
    await status.getByRole('button', { name: 'Read Status' }).click()
    await expect(status.getByRole('cell', { name: SERIAL, exact: true })).toBeVisible({ timeout: 15000 })

    const start = await device()
    let count = start.reports.length

    await card('xReport').getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.DAILY, data: '2' })
    await expect(page.getByText('X-Report printed')).toBeVisible()

    await card('zReport').getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.DAILY, data: '0' })
    expect((await device()).closure).toBe(start.closure + 1)

    const byDate = card('fmReportByDate')
    await byDate.getByLabel('From').fill('2026-10-01')
    await byDate.getByLabel('To').fill('2026-10-31')
    await byDate.getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.FM_DATE, data: '011026,311026' })
    await byDate.getByLabel('Detailed').check()
    await byDate.getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.FM_DATE_DETAILED, data: '011026,311026' })

    const byNumber = card('fmReportByNumber')
    // Printing with the numbers still empty is answered with what is missing, and sends nothing.
    await byNumber.getByRole('button', { name: 'Print' }).click()
    await expect(page.getByText('Enter the first and the last Z-report number.')).toBeVisible()
    await byNumber.getByLabel('Start Number').fill('1')
    await byNumber.getByLabel('End Number').fill('13')
    await byNumber.getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.FM_NUMBER, data: '0001,0013' })
    await byNumber.getByLabel('Detailed').check()
    await byNumber.getByRole('button', { name: 'Print' }).click()
    expect(await lastReport(++count)).toEqual({ cmd: CMD.FM_NUMBER_DETAILED, data: '0001,0013' })

    expect((await device()).receiptOpen).toBe(false)
  })

  test('what the Eltrade protocol lacks is disabled, with the reason — not offered and refused', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/pos/devices/${deviceId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Reports/i }).click()
    const frames = (await device()).frames

    await expect(page.getByTestId('report-operatorReport').getByRole('button', { name: 'Print' })).toBeDisabled()
    await expect(page.getByTestId('why-operatorReport')).toHaveText('The Eltrade protocol has no operator report')
    await expect(page.getByTestId('report-electronicJournal').getByRole('button', { name: 'Print' })).toBeDisabled()
    await expect(page.getByTestId('why-electronicJournal')).toHaveText('The Eltrade protocol has no electronic-journal (KLEN) print')
    // What it has carries no reason.
    for (const feature of ['xReport', 'zReport', 'fmReportByDate', 'fmReportByNumber', 'paymentNames']) {
      await expect(page.getByTestId(`why-${feature}`)).toHaveCount(0)
    }

    // Operators: sixteen of them, programmed from here and never read back.
    await page.getByRole('tab', { name: /Operators/i }).click()
    await expect(page.getByTestId('operator-notes')).toContainText('Eltrade devices cannot report their operators — program them from here')
    const rows = page.getByTestId('operators').locator('tbody tr')
    await expect(rows).toHaveCount(16)
    for (const button of await rows.getByRole('button', { name: 'Read from Device' }).all()) await expect(button).toBeDisabled()
    expect((await device()).frames).toBe(frames)
  })

  test('an operator programmed from the page reaches the device', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/pos/devices/${deviceId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Operators/i }).click()
    const row = page.getByTestId('operators').locator('tbody tr').nth(15)
    await expect(row.locator('td').first()).toHaveText('16')
    const inputs = row.locator('input') // name, password
    await inputs.nth(0).fill('Иван Петров')
    await inputs.nth(1).fill('1234')
    await row.getByRole('button', { name: 'Program on Device' }).click()
    await expect.poll(async () => (await device()).operators['16'], { timeout: 15000 }).toBe('Иван Петров')
  })

  test('payment types: read from the device; one click names the reserve slot „НАЛОЖЕН ПЛАТЕЖ"', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/pos/devices/${deviceId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Reports/i }).click()
    const card = page.getByTestId('payment-types')

    await card.getByRole('button', { name: 'Read from Device' }).click()
    await expect(card.locator('tbody tr')).toHaveCount(11)
    await expect(card.getByTestId('payment-R')).toContainText('РЕЗЕРВ')
    await expect(card.getByTestId('payment-R')).toContainText('Cash on delivery')

    await card.getByTestId('name-cod-slot').click()
    await expect.poll(async () => (await device()).paymentNames.R, { timeout: 15000 }).toBe('НАЛОЖЕН ПЛАТЕЖ')
    await expect(card.getByTestId('payment-R')).toContainText('НАЛОЖЕН ПЛАТЕЖ')
    await expect(page.getByText('R is now named "НАЛОЖЕН ПЛАТЕЖ" on the device')).toBeVisible()
  })
})
