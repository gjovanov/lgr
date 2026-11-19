import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * The account form (FR-25a §3.1), for an account of LGR's own: made through its form, opened again, changed. An org that
 * keeps no books has nothing "as booked", so the form takes input and offers Save. A books org's account is the other
 * case, read-only, and is `books-chart.spec.ts` (the `books` project).
 *
 * `accounting-crud.spec.ts` saves an existing account unchanged; this makes one, and keeps an edit.
 */
test.describe('Account form', () => {
  test.describe.configure({ mode: 'serial' })

  const stamp = Date.now().toString(36)
  const code = `E2E-${stamp}`
  const name = `E2E office supplies ${stamp}`
  let accountId = ''

  test.afterAll(async () => {
    // Nothing is booked on it, so the route deletes it.
    if (accountId) await apiDelete(await apiLogin(), `/accounting/account/${accountId}`)
  })

  /** One option of a select. */
  async function choose(page: any, label: RegExp, option: string) {
    await openSelect(page, label)
    await page.getByRole('option', { name: option, exact: true }).click()
  }

  /** The Save the form shell offers, and the answer of the route it calls. */
  async function saveAndWait(page: any, method: 'POST' | 'PUT') {
    const [response] = await Promise.all([
      page.waitForResponse((r: any) => r.request().method() === method && /\/accounting\/account(\/[0-9a-f]{24})?$/.test(new URL(r.url()).pathname)),
      page.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    return response
  }

  test('an account of LGR\'s own is made through its form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts/new')
    const codeField = page.getByLabel('Account Code')
    await expect(codeField).toBeEditable({ timeout: 15000 })
    // An org of LGR's own: nothing here is as booked.
    await expect(page.getByTestId('account-as-booked')).toHaveCount(0)

    await codeField.fill(code)
    await page.getByLabel('Name', { exact: true }).first().fill(name)
    await choose(page, /^account type$/i, 'expense')
    await choose(page, /^sub type$/i, 'operating_expense')
    await page.getByLabel('Currency', { exact: true }).fill('EUR')
    await page.getByLabel('Description', { exact: true }).fill('Made by the e2e suite')

    const response = await saveAndWait(page, 'POST')
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({
      code, name, type: 'expense', subType: 'operating_expense', currency: 'EUR', description: 'Made by the e2e suite', isActive: true,
    })
    const made = (await response.json()).account
    accountId = String(made?._id ?? made?.id ?? '')
    expect(accountId, 'the answer names the new account').toMatch(/^[0-9a-f]{24}$/)
    // The form goes back to the chart.
    await page.waitForURL(/\/accounting\/accounts(\?.*)?$/, { timeout: 15000 })

    const { account } = await apiGet(await apiLogin(), `/accounting/account/${accountId}`)
    expect(account).toMatchObject({ code, name, type: 'expense', subType: 'operating_expense', currency: 'EUR', description: 'Made by the e2e suite', isActive: true })
  })

  test('it opens again as it was saved, and an edit is kept', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/accounting/accounts/${accountId}/edit`)
    await expect(page.getByLabel('Account Code')).toHaveValue(code, { timeout: 15000 })
    await expect(page.getByLabel('Name', { exact: true }).first()).toHaveValue(name)
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Made by the e2e suite')
    // The books say nothing of an account of LGR's own: no Books section.
    await expect(page.getByTestId('account-books')).toHaveCount(0)

    await page.getByLabel('Name', { exact: true }).first().fill(`${name} (edited)`)
    await page.getByLabel('Description', { exact: true }).fill('Edited by the e2e suite')
    const response = await saveAndWait(page, 'PUT')
    expect(response.status(), 'the route takes what the form sends').toBe(200)

    const { account } = await apiGet(await apiLogin(), `/accounting/account/${accountId}`)
    expect(account).toMatchObject({ code, name: `${name} (edited)`, type: 'expense', subType: 'operating_expense', description: 'Edited by the e2e suite' })
  })
})
