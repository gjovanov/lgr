import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-31.1 (#796): saving does not switch the unsaved-edits guard off. On the eight forms that stay open after a save,
 * an edit made after it was dropped on leaving without a word: the form had said "saved" once, and never asked again.
 *
 * Each case: edit, Save, edit again, leave — the leave asks. And on the warehouse and the movement form, the two the
 * field test walks (§8): a form left untouched, and one left right after its save, never ask.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

async function session() {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  const data = await res.json()
  const orgId = (data.org?.id || data.org?._id) as string
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await r.json()
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`)
    return json
  }
  return { call }
}

type Api = Awaited<ReturnType<typeof session>>
const idOf = (doc: any) => String(doc?._id || doc?.id)
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`

async function defaultWarehouseId(api: Api) {
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  return idOf(warehouses.find((w: any) => w.isDefault && !w.isExternal) || warehouses.find((w: any) => !w.isExternal))
}

interface FormCase {
  name: string
  /** Makes the record through the API; the page to open it on. */
  open: (api: Api) => Promise<string>
  /** The field the case types in, by its role and accessible name. */
  field: { role: 'textbox' | 'spinbutton'; label: string }
  values: [string, string]
}

const cases: FormCase[] = [
  {
    name: 'warehouse',
    open: async (api) => {
      const s = stamp()
      const { warehouse } = await api.call('POST', '/warehouse/warehouse', { code: `U${s.slice(-6)}`, name: `E2E Склад ${s}`, type: 'warehouse' })
      return `/inventory/warehouses/${idOf(warehouse)}/edit`
    },
    field: { role: 'textbox', label: 'Name' },
    values: ['E2E Склад saved', 'E2E Склад edited after the save'],
  },
  {
    name: 'category',
    open: async (api) => {
      const { productCategory } = await api.call('POST', '/warehouse/product-category', { name: `E2E Категория ${stamp()}` })
      return `/inventory/categories/${idOf(productCategory)}/edit`
    },
    field: { role: 'textbox', label: 'Name' },
    values: ['E2E Категория saved', 'E2E Категория edited after the save'],
  },
  {
    name: 'price list',
    open: async (api) => {
      const { priceList } = await api.call('POST', '/warehouse/price-list', { name: `E2E Ценова листа ${stamp()}`, currency: 'EUR', items: [] })
      return `/inventory/price-lists/${idOf(priceList)}/edit`
    },
    field: { role: 'textbox', label: 'Name' },
    values: ['E2E Ценова листа saved', 'E2E Ценова листа edited after the save'],
  },
  {
    name: 'inventory count',
    open: async (api) => {
      const { inventoryCount } = await api.call('POST', '/warehouse/inventory-count', {
        warehouseId: await defaultWarehouseId(api), date: new Date().toISOString().slice(0, 10), type: 'partial', lines: [],
      })
      return `/inventory/inventory-counts/${idOf(inventoryCount)}/edit`
    },
    field: { role: 'textbox', label: 'Notes' },
    values: ['counted the front shelf', 'counted the front shelf, then the back'],
  },
  {
    name: 'stock movement',
    open: async (api) => {
      const { stockMovement } = await api.call('POST', '/warehouse/movement', {
        type: 'receipt', date: new Date().toISOString(), toWarehouseId: await defaultWarehouseId(api), lines: [], totalAmount: 0,
      })
      return `/inventory/movements/${idOf(stockMovement)}`
    },
    field: { role: 'textbox', label: 'Notes' },
    values: ['delivery note 1', 'delivery note 1, corrected'],
  },
  {
    name: 'POS device',
    open: async (api) => {
      const { fiscalDevice } = await api.call('POST', '/fiscal/device', {
        deviceNumber: `U${stamp().slice(-7)}`, name: `E2E Каса ${stamp()}`, manufacturer: 'datecs', connectionType: 'browser',
        warehouseId: await defaultWarehouseId(api),
      })
      return `/invoicing/configuration/devices/${idOf(fiscalDevice)}`
    },
    field: { role: 'textbox', label: 'Name' },
    values: ['E2E Каса saved', 'E2E Каса edited after the save'],
  },
  {
    name: 'timesheet',
    open: async (api) => {
      const employees = (await api.call('GET', '/payroll/employee?size=1')).employees || []
      const { timesheet } = await api.call('POST', '/payroll/timesheet', {
        employeeId: idOf(employees[0]), date: new Date().toISOString().slice(0, 10), hoursWorked: 8, overtimeHours: 0, type: 'regular', status: 'submitted',
      })
      return `/payroll/timesheets/${idOf(timesheet)}/edit`
    },
    field: { role: 'spinbutton', label: 'Hours Worked' },
    values: ['6', '7'],
  },
  {
    name: 'payroll run',
    open: async (api) => {
      const { payrollRun } = await api.call('POST', '/payroll/run', { name: `E2E Ведомост ${stamp()}`, period: { from: '2026-10-01', to: '2026-10-31' }, currency: 'EUR' })
      return `/payroll/runs/${idOf(payrollRun)}/edit`
    },
    field: { role: 'textbox', label: 'Name' },
    values: ['E2E Ведомост saved', 'E2E Ведомост edited after the save'],
  },
]

const leaveDialog = (page: any) => page.locator('.v-overlay--active .v-card').filter({ hasText: 'You have unsaved changes' })
const saveButton = (page: any) => page.getByRole('button', { name: /^save$/i }).first()

/** Open the form on its record, once the record's values are in the field. */
async function openLoaded(page: any, url: string, field: FormCase['field'], signIn = true) {
  if (signIn) await loginForApp(page)
  const loaded = page.waitForResponse((r: any) => r.request().method() === 'GET' && url.split('/').some((part) => part.length > 20 && r.url().includes(part)))
  await page.goto(url)
  await loaded
  const input = page.getByRole(field.role, { name: field.label, exact: true }).first()
  await expect(input).toBeVisible({ timeout: 15000 })
  return input
}

async function save(page: any) {
  const put = page.waitForResponse((r: any) => r.request().method() === 'PUT')
  await saveButton(page).click()
  expect((await put).status()).toBe(200)
  await expect(saveButton(page)).not.toHaveClass(/v-btn--loading/)
}

test.describe('an edit after a save is asked about on leaving (FR-31.1)', () => {
  for (const c of cases) {
    test(`${c.name}: edit, save, edit, leave`, async ({ page }) => {
      const url = await c.open(await session())
      const input = await openLoaded(page, url, c.field)
      await input.fill(c.values[0])
      await save(page)
      await input.fill(c.values[1])
      await page.getByTestId('form-back').click()
      await expect(leaveDialog(page)).toHaveCount(1)
    })
  }
})

test.describe('no question where nothing is lost (FR-31.1, FR-31.2)', () => {
  for (const c of cases.filter((x) => x.name === 'warehouse' || x.name === 'stock movement')) {
    test(`${c.name}: left untouched, and left right after a save`, async ({ page }) => {
      const url = await c.open(await session())
      await openLoaded(page, url, c.field)
      await page.getByTestId('form-back').click()
      await expect(page).not.toHaveURL(url)
      await expect(leaveDialog(page)).toHaveCount(0)

      const input = await openLoaded(page, url, c.field, false)
      await input.fill(c.values[0])
      await save(page)
      await page.getByTestId('form-back').click()
      await expect(page).not.toHaveURL(url)
      await expect(leaveDialog(page)).toHaveCount(0)
    })
  }

  test('warehouse: a load slower than the old half-second timer, left untouched, asks nothing (FR-31.2)', async ({ page }) => {
    const url = await cases[0].open(await session())
    await loginForApp(page)
    const id = url.split('/').at(-2)!
    await page.route(`**/warehouse/warehouse/${id}`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })
    await page.goto(url)
    const input = page.getByRole('textbox', { name: 'Name', exact: true }).first()
    await expect(input).toHaveValue(/E2E Склад/, { timeout: 15000 })
    await page.getByTestId('form-back').click()
    await expect(page).not.toHaveURL(url)
    await expect(leaveDialog(page)).toHaveCount(0)
  })
})
