import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost, apiPut } from './helpers/api'
import { openSelect } from './helpers/vuetify'
import {
  ASSET, BANK, BOOKS_ADMIN, BOOKS_ORG, CUSTOMER, CUSTOMERS_ROOT, NATIVE_ANALYTIC, NATIVE_ORG, SECOND_CUSTOMER, booksOrgReady,
} from './helpers/books-org'

/**
 * FR-25a §3.1–§3.4 on an org that keeps imported books: the chart, the analytics, a bank account and a fixed asset, as
 * the books import wrote them (`packages/tests/src/helpers/books-org.ts`, run by `scripts/nightly.ts` after the seed).
 * What the import wrote is as booked: it opens read-only, and the server refuses a change too. What a person may change
 * is an analytic of LGR's own, in an org that keeps no books: there a contact linked to it is saved.
 *
 * Skipped without the books org (`E2E_BOOKS_ORG`): a run on the plain seed has none.
 */
test.skip(!booksOrgReady(), 'needs the books org that scripts/nightly.ts adds after the seed')

const books = () => apiLogin(BOOKS_ORG.slug, BOOKS_ADMIN.username, BOOKS_ADMIN.password)
const signIn = (page: any, org: string = BOOKS_ORG.slug) => loginForApp(page, org, BOOKS_ADMIN.username, BOOKS_ADMIN.password)
const idOf = (doc: any) => String(doc?._id ?? doc?.id ?? '')
const rowsOf = (page: any) => page.locator('.v-data-table tbody tr')
/** The analytic form's path: the test id is on the field, the value on its input. */
const pathOf = (page: any) => page.getByTestId('analytic-path').locator('input')

/** A refused change: the status and the stable code the screens read. */
async function expectAsBooked(res: Response) {
  expect(res.status, 'the server refuses a change to what the books hold').toBe(422)
  expect((await res.json()).code).toBe('books_as_booked')
}

test('a books org\'s account opens read-only, with what the books say of it', async ({ page }) => {
  const session = await books()
  const { accounts } = await apiGet(session, '/accounting/account?size=0')
  const receivables = accounts.find((a: any) => a.code === '411')
  expect(receivables, 'the imported chart holds 411').toBeTruthy()
  await expectAsBooked(await apiPut(session, `/accounting/account/${idOf(receivables)}`, { name: 'Changed by e2e' }))

  await signIn(page)
  await page.goto(`/accounting/accounts/${idOf(receivables)}/edit`)
  await expect(page.getByTestId('account-as-booked')).toBeVisible({ timeout: 15000 })
  const code = page.getByLabel('Account Code')
  await expect(code).toHaveValue('411')
  await expect(code).toBeDisabled()
  await expect(page.getByLabel('Name', { exact: true }).first()).toBeDisabled()
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0)

  // The books' own words for it: settled on both sides, and kept by customer.
  await expect(page.getByTestId('account-balance-side')).toHaveText('Both sides')
  const root = page.getByTestId('account-analytic-root')
  await expect(root).toHaveText('Customers')
  // Each root opens the analytics of that root.
  await root.click()
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(CUSTOMERS_ROOT)
  await expect(rowsOf(page).filter({ hasText: CUSTOMER.name })).toHaveCount(1, { timeout: 15000 })
})

test('the analytics tree opens a root and lists what is under it', async ({ page }) => {
  await signIn(page)
  await page.goto('/accounting/analytics')
  const rows = rowsOf(page)
  // The whole tree: every root, and what is under each.
  await expect(rows.filter({ hasText: ASSET.name })).toHaveCount(1, { timeout: 15000 })
  await expect(rows.filter({ hasText: CUSTOMER.name })).toHaveCount(1)

  const customers = rows.filter({ hasText: CUSTOMERS_ROOT }).filter({ has: page.getByTestId('analytics-open-root') })
  await expect(customers).toHaveCount(1)
  await customers.getByTestId('analytics-open-root').click()

  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(CUSTOMERS_ROOT)
  // The root and its two customers, and nothing of another root.
  await expect(rows.filter({ hasText: ASSET.name })).toHaveCount(0, { timeout: 15000 })
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: CUSTOMER.name })).toHaveCount(1)
  await expect(rows.filter({ hasText: SECOND_CUSTOMER.name })).toHaveCount(1)
  // Opened, the root offers no button to open it again.
  await expect(page.getByTestId('analytics-open-root')).toHaveCount(0)
})

test('an imported analytic shows its properties as booked, and nothing of it can be changed', async ({ page }) => {
  const session = await books()
  const { analytics } = await apiGet(session, `/accounting/analytics?root=${encodeURIComponent(CUSTOMERS_ROOT)}&size=0`)
  const customer = analytics.find((a: any) => a.path === CUSTOMER.path)
  // The import linked the partner to the Contact it made for it.
  expect(customer).toMatchObject({ kind: 'customer', contactName: CUSTOMER.name })
  await expectAsBooked(await apiPut(session, `/accounting/analytics/${idOf(customer)}`, { params: [{ key: 'E2E', value: 'changed' }] }))

  await signIn(page)
  await page.goto(`/accounting/analytics/${idOf(customer)}`)
  await expect(page.getByTestId('analytic-as-booked')).toBeVisible({ timeout: 15000 })
  await expect(pathOf(page)).toHaveValue(CUSTOMER.path)

  // The file's properties, in the file's order, as text.
  const properties = page.getByTestId('analytic-properties').locator('tbody tr')
  await expect(properties.first().locator('td').first()).toHaveText('БУЛСТАТ')
  await expect(properties.filter({ hasText: 'БУЛСТАТ' })).toContainText(CUSTOMER.eik)
  await expect(properties.filter({ hasText: 'МОЛ' })).toContainText(CUSTOMER.representative)
  // Nothing to type into, add or save: the links are shown, not offered.
  await expect(page.getByTestId('analytic-property-row')).toHaveCount(0)
  await expect(page.getByTestId('analytic-add-property')).toHaveCount(0)
  await expect(page.getByTestId('analytic-contact')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0)
  await expect(page.getByTestId('analytic-links')).toContainText(CUSTOMER.name)
})

test.describe('an analytic of LGR\'s own', () => {
  test.describe.configure({ mode: 'serial' })

  const company = `E2E analytic contact ${Date.now().toString(36)}`
  let session: Awaited<ReturnType<typeof apiLogin>>
  let analyticId = ''
  let contactId = ''

  test.beforeAll(async () => {
    session = await apiLogin(NATIVE_ORG.slug, BOOKS_ADMIN.username, BOOKS_ADMIN.password)
    const res = await apiPost(session, '/invoicing/contact', { type: 'customer', companyName: company })
    expect(res.status).toBeLessThan(300)
    contactId = idOf((await res.json()).contact)
    const { analytics } = await apiGet(session, '/accounting/analytics?size=0')
    const analytic = analytics.find((a: any) => a.path === NATIVE_ANALYTIC.path)
    analyticId = idOf(analytic)
    // As the step left it: no contact yet.
    expect(analytic.contactId ?? null).toBeNull()
  })

  test.afterAll(async () => {
    // Back as the step left it, so a second run starts from the same analytic.
    if (analyticId) await apiPut(session, `/accounting/analytics/${analyticId}`, { contactId: null })
    if (contactId) await apiDelete(session, `/invoicing/contact/${contactId}`)
  })

  test('a contact linked to it is saved, and shown again', async ({ page }) => {
    await signIn(page, NATIVE_ORG.slug)
    await page.goto(`/accounting/analytics/${analyticId}`)
    await expect(pathOf(page)).toHaveValue(NATIVE_ANALYTIC.path, { timeout: 15000 })
    await expect(page.getByTestId('analytic-as-booked')).toHaveCount(0)

    // The contact picker searches the server as one types.
    await openSelect(page, /^contact$/i)
    await page.getByRole('combobox', { name: /^contact$/i }).fill(company)
    await page.getByRole('option', { name: company }).click()

    const [response] = await Promise.all([
      page.waitForResponse((r: any) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounting/analytics/${analyticId}`)),
      page.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({ contactId })

    const { analytic } = await apiGet(session, `/accounting/analytics/${analyticId}`)
    expect(analytic).toMatchObject({ contactId, contactName: company })

    // Opened again, the field shows the contact (as its selection: the input itself is for searching).
    await page.reload()
    await expect(page.getByTestId('analytic-contact')).toContainText(company, { timeout: 15000 })
  })
})

test('a bank account\'s analytic link opens the analytic', async ({ page }) => {
  const session = await books()
  const { bankAccounts } = await apiGet(session, '/accounting/bank-account?size=0')
  const bank = bankAccounts.find((b: any) => b.iban === BANK.iban)
  expect(bank, 'the import made the bank account of the БАНКОВИ СМЕТКИ analytic').toBeTruthy()

  await signIn(page)
  await page.goto(`/accounting/bank-accounts/${idOf(bank)}/edit`)
  const link = page.getByTestId('bank-account-analytic').getByRole('link', { name: BANK.path })
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click()

  await expect(page).toHaveURL(/\/accounting\/analytics\/[0-9a-f]{24}$/)
  await expect(pathOf(page)).toHaveValue(BANK.path, { timeout: 15000 })
  // And back the other way: the analytic names the bank account.
  await expect(page.getByTestId('analytic-links')).toContainText(BANK.iban)
})

test('an imported fixed asset opens read-only, as booked, with the lock in the register', async ({ page }) => {
  const session = await books()
  const { fixedAssets } = await apiGet(session, '/accounting/fixed-asset?imported=true')
  const asset = fixedAssets.find((a: any) => a.name === ASSET.name)
  expect(asset).toMatchObject({ code: ASSET.path, imported: true })
  await expectAsBooked(await apiPut(session, `/accounting/fixed-asset/${idOf(asset)}`, { name: 'Changed by e2e' }))

  await signIn(page)
  await page.goto('/accounting/fixed-assets')
  const row = rowsOf(page).filter({ hasText: ASSET.name })
  await expect(row).toHaveCount(1, { timeout: 15000 })
  await expect(row.getByTestId('fixed-asset-imported')).toBeVisible()

  await row.getByRole('link', { name: ASSET.name }).click()
  await expect(page).toHaveURL(new RegExp(`/accounting/fixed-assets/${idOf(asset)}/edit$`))
  await expect(page.getByTestId('fixed-asset-as-booked')).toBeVisible({ timeout: 15000 })
  const form = page.locator('form')
  await expect(form.getByLabel(/^name$/i)).toHaveValue(ASSET.name)
  await expect(form.getByLabel(/^name$/i)).toBeDisabled()
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0)
  // What the books hold of it: its properties, and the analytic it came from.
  await expect(page.getByTestId('fixed-asset-properties')).toContainText('СМЕТКА')
  await expect(page.getByTestId('fixed-asset-analytic')).toContainText(ASSET.path)
})
