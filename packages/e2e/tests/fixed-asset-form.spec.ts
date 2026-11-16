import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiDelete } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * The fixed asset form (FR-25a §3.4), for an asset kept in LGR: made with its book side and its tax side, opened
 * again, changed, and found on the register. An asset the books import made is another matter (as booked, read-only)
 * and needs imported books, which the seed does not hold.
 *
 * ⚠ The route stores the form's body as the document and refuses a body that names a field the server sets
 * (`services/biz/server-owned.ts`, S-36). So the two saves here are also the check that the form sends only what a
 * person may choose: a server-owned field added to `payloadOf` would turn every save of the form into a 422, and
 * nothing else in the suite would say so.
 */
test.describe('Fixed asset form', () => {
  test.describe.configure({ mode: 'serial' })

  const stamp = Date.now().toString(36)
  const code = `E2E-FA-${stamp}`
  const name = `E2E lathe ${stamp}`
  let assetId = ''

  test.afterAll(async () => {
    if (!assetId) return
    const session = await apiLogin()
    await apiDelete(session, `/accounting/fixed-asset/${assetId}`)
  })

  /** An account out of the chart: the list is long, so the option is asked for by typing its code. */
  async function pickAccount(page: any, form: any, label: RegExp, option: string) {
    await openSelect(form, label)
    await form.getByRole('combobox', { name: label }).fill(option.split(' - ')[0])
    await page.getByRole('option', { name: option, exact: true }).click()
  }

  /** The Save the form shell offers, and the answer of the route it calls. */
  async function saveAndWait(page: any, method: 'POST' | 'PUT') {
    const [response] = await Promise.all([
      page.waitForResponse((r: any) => r.request().method() === method && /\/accounting\/fixed-asset(\/[0-9a-f]{24})?$/.test(new URL(r.url()).pathname)),
      page.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    return response
  }

  test('an asset is made with its book and tax sides', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/fixed-assets/new')
    const form = page.locator('form')
    await expect(form.getByLabel(/^code$/i)).toBeVisible({ timeout: 15000 })

    await form.getByLabel(/^code$/i).fill(code)
    await form.getByLabel(/^name$/i).fill(name)
    await form.getByLabel(/^category$/i).fill('Machines')
    await form.getByLabel(/^purchase date$/i).fill('2026-01-15')
    await form.getByLabel(/^purchase price$/i).fill('1200')
    await form.getByLabel(/^salvage value$/i).fill('200')
    // Entered in years, stored in months.
    await form.getByLabel(/^useful life$/i).fill('3')
    await pickAccount(page, form, /^asset account$/i, '1500 - Equipment')
    await pickAccount(page, form, /^depreciation expense account$/i, '5500 - Depreciation Expense')
    await pickAccount(page, form, /^accumulated depreciation account$/i, '1550 - Accumulated Depreciation')

    // The tax side: a category brings its statutory rate, and the purchase price as the tax value.
    await openSelect(form, /^tax category$/i)
    await page.getByRole('option', { name: /^II\s/ }).click()
    await expect(form.getByLabel(/^tax depreciation rate$/i)).toHaveValue('30')
    await expect(form.getByLabel(/^tax value$/i)).toHaveValue('1200')
    await form.getByLabel(/^put into service$/i).fill('2026-02-01')

    const response = await saveAndWait(page, 'POST')
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    const sent = response.request().postDataJSON()
    expect(sent).toMatchObject({
      code, name, category: 'Machines', purchaseDate: '2026-01-15', purchasePrice: 1200, salvageValue: 200,
      usefulLifeMonths: 36, depreciationMethod: 'straight_line', status: 'active',
      taxCategory: '2', taxDepreciationRate: 30, taxValue: 1200, inServiceDate: '2026-02-01',
      // A new asset is worth its price.
      currentValue: 1200,
    })
    assetId = String((await response.json()).fixedAsset?._id ?? (await response.json()).fixedAsset?.id ?? '')
    expect(assetId, 'the answer names the new asset').toMatch(/^[0-9a-f]{24}$/)

    // The form goes back to the register.
    await page.waitForURL(/\/accounting\/fixed-assets$/, { timeout: 15000 })

    const session = await apiLogin()
    const { fixedAsset } = await apiGet(session, `/accounting/fixed-asset/${assetId}`)
    expect(fixedAsset).toMatchObject({
      code, name, usefulLifeMonths: 36, purchasePrice: 1200, currentValue: 1200,
      taxCategory: '2', taxDepreciationRate: 30, taxValue: 1200, imported: false,
    })
  })

  test('the asset opens again as it was saved, and an edit is kept', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/accounting/fixed-assets/${assetId}/edit`)
    const form = page.locator('form')
    await expect(form.getByLabel(/^code$/i)).toHaveValue(code, { timeout: 15000 })
    await expect(form.getByLabel(/^name$/i)).toHaveValue(name)
    // Stored in months, shown in years.
    await expect(form.getByLabel(/^useful life$/i)).toHaveValue('3')
    await expect(form.getByLabel(/^tax depreciation rate$/i)).toHaveValue('30')
    await expect(form.getByLabel(/^put into service$/i)).toHaveValue('2026-02-01')
    // An asset kept in LGR is not "as booked".
    await expect(page.getByTestId('fixed-asset-as-booked')).toHaveCount(0)
    // Its tax schedule is worked out from its tax side: a row a year from the month it was put into service (February),
    // at 30 % a year, until the tax value is written off. 40 months: 11 + 12 + 12 + 5.
    const taxYears = page.getByTestId('fixed-asset-tax-schedule').locator('tbody tr')
    await expect(taxYears).toHaveCount(4)
    const cells = (row: number) => taxYears.nth(row).locator('td')
    await expect(cells(0).nth(0)).toHaveText('2026')
    await expect(cells(0).nth(1)).toHaveText('11')
    await expect(cells(0).nth(2)).toContainText('330.00')
    await expect(cells(3).nth(0)).toHaveText('2029')
    await expect(cells(3).nth(1)).toHaveText('5')
    await expect(cells(3).nth(2)).toContainText('150.00')
    await expect(cells(3).nth(3)).toContainText('1,200.00')

    await form.getByLabel(/^name$/i).fill(`${name} (edited)`)
    await form.getByLabel(/^salvage value$/i).fill('300')
    const response = await saveAndWait(page, 'PUT')
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    // An edit leaves the value alone: it is not the price any more once depreciation is posted.
    expect(Object.keys(response.request().postDataJSON())).not.toContain('currentValue')

    const session = await apiLogin()
    const { fixedAsset } = await apiGet(session, `/accounting/fixed-asset/${assetId}`)
    expect(fixedAsset).toMatchObject({
      code, name: `${name} (edited)`, salvageValue: 300, usefulLifeMonths: 36, currentValue: 1200,
      taxCategory: '2', taxDepreciationRate: 30, taxValue: 1200,
    })
  })

  test('the register finds it by its code, its tax category and where it comes from', async ({ page }) => {
    const session = await apiLogin()
    const total = async (query: string) => (await apiGet(session, `/accounting/fixed-asset?search=${encodeURIComponent(code)}&${query}`)).total
    // A filter that is ignored answers the whole list: each one is read against its opposite.
    expect(await total('taxCategory=2')).toBe(1)
    expect(await total('taxCategory=5')).toBe(0)
    expect(await total('imported=false')).toBe(1)
    expect(await total('imported=true')).toBe(0)

    await loginForApp(page)
    await page.goto('/accounting/fixed-assets')
    await expect(page.getByRole('heading', { name: /fixed assets/i })).toBeVisible({ timeout: 15000 })
    await page.getByLabel(/^search$/i).fill(code)
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: code })
    await expect(row).toHaveCount(1, { timeout: 15000 })
    await expect(row).toContainText(`${name} (edited)`)
    // Kept in LGR: no lock beside its name.
    await expect(row.getByTestId('fixed-asset-imported')).toHaveCount(0)

    // Where it comes from, in the page: an asset of the books is never this one.
    await openSelect(page, /^origin$/i)
    await page.getByRole('option', { name: "From the accountant's books", exact: true }).click()
    await expect(row).toHaveCount(0, { timeout: 15000 })
    await openSelect(page, /^origin$/i)
    await page.getByRole('option', { name: 'Kept in LGR', exact: true }).click()
    await expect(row).toHaveCount(1, { timeout: 15000 })
  })
})
