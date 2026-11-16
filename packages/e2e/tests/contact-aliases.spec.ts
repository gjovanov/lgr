import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'

/**
 * FR-28.12 — a contact's other names („Also known as"), as the person at the contact form meets them.
 *
 * One supplier of this spec's own. What it pins: a name confirmed with Enter is a chip; a name typed and left
 * unconfirmed is still saved (it used to be the kind of thing a form drops without a word); the list and a
 * document's supplier field find the contact by the other name; a chip closed is a name removed. What the names
 * are FOR on an import is `integration/contact-aliases.flow` and `unit/supplier-name`.
 *
 * Serial: the cases build on the one contact.
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const company = `E2E Other Names ${stamp} GMBH`
// Not part of the company's name, so only the other names can find it.
const confirmed = `EON+${stamp}`
const typedOnly = `Kurzform ${stamp}`

let admin: Awaited<ReturnType<typeof apiLogin>>
let contactId = ''

const aliasesOf = async () => (await apiGet(admin, `/invoicing/contact/${contactId}`)).contact.aliases

test.beforeAll(async () => {
  admin = await apiLogin()
  const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'supplier', companyName: company }))
  contactId = contact._id || contact.id
})

test.afterAll(async () => {
  if (contactId) await apiDelete(admin, `/invoicing/contact/${contactId}`)
})

async function openForm(page: any) {
  await loginForApp(page)
  await page.goto(`/invoicing/contacts/${contactId}/edit`)
  // The form has loaded once it shows the contact's own name.
  await expect(page.getByLabel(/company name/i)).toHaveValue(company)
  return page.getByTestId('contact-aliases')
}

const save = async (page: any) => {
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await page.waitForURL(/\/invoicing\/contacts(\?.*)?$/)
}

test('a name confirmed with Enter is a chip, a name typed and left is kept by the save, and both are stored tidy', async ({ page }) => {
  const field = await openForm(page)
  const input = field.locator('input')

  await input.fill(confirmed)
  await input.press('Enter')
  await expect(field.locator('.v-chip', { hasText: confirmed })).toBeVisible()

  // Typed, with stray spaces, and never confirmed: the save takes it.
  await input.fill(`  ${typedOnly}  `)
  await save(page)

  expect(await aliasesOf()).toEqual([confirmed, typedOnly])
})

test('the contacts list finds the contact by an other name', async ({ page }) => {
  await loginForApp(page)
  await page.goto('/invoicing/contacts')
  await page.getByLabel(/search/i).first().fill(confirmed.toLowerCase())
  await expect(page.getByRole('cell', { name: company })).toBeVisible()
})

test('a document\'s supplier field finds the contact by an other name', async ({ page }) => {
  await loginForApp(page)
  await page.goto('/invoicing/bills/new')
  const party = page.locator('.v-autocomplete').first()
  await party.locator('input').fill(typedOnly)
  await expect(page.getByRole('option', { name: company })).toBeVisible()
})

test('the form shows the names it stored, and a chip closed is a name removed, down to none', async ({ page }) => {
  let field = await openForm(page)
  await expect(field.locator('.v-chip')).toHaveText([confirmed, typedOnly])

  await field.locator('.v-chip', { hasText: typedOnly }).locator('.v-chip__close').click()
  await expect(field.locator('.v-chip')).toHaveText([confirmed])
  await save(page)
  expect(await aliasesOf()).toEqual([confirmed])

  field = await openForm(page)
  await field.locator('.v-chip', { hasText: confirmed }).locator('.v-chip__close').click()
  await expect(field.locator('.v-chip')).toHaveCount(0)
  await save(page)
  expect(await aliasesOf()).toEqual([])
})
