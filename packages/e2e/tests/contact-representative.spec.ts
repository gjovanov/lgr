import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'

/**
 * FR-25a §3.5 — a contact's МОЛ (the person legally responsible for the company), as the person at the contact form
 * meets it: a field of its own beside the tax and VAT numbers, and, on a contact whose notes still keep it the old way
 * as a line `МОЛ: <name>`, an offer to move it into the field.
 *
 * One customer of this spec's own. What it pins: a name typed with stray spaces is stored trimmed, and the contacts
 * list finds the contact by it; the move takes exactly that line out of the notes and leaves the other lines as they
 * were, is not offered while the field holds another name, can be undone, and stores nothing until the contact is
 * saved. What counts as such a line is `unit/party-identity`.
 *
 * Serial: the cases build on the one contact.
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const company = `E2E Representative ${stamp} LTD`
const typed = `Ivan Petrov ${stamp}`
const inNotes = `Maria Ivanova ${stamp}`
const otherNotes = 'Pays on the 5th\nCall before delivery'
const notesWithLine = `Pays on the 5th\nМОЛ: ${inNotes}\nCall before delivery`

let admin: Awaited<ReturnType<typeof apiLogin>>
let contactId = ''

const stored = async () => (await apiGet(admin, `/invoicing/contact/${contactId}`)).contact

test.beforeAll(async () => {
  admin = await apiLogin()
  const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'customer', companyName: company }))
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
  const field = page.getByTestId('contact-representative')
  return {
    representative: field.locator('input'),
    // The form's own notes, not the notes panel beside it.
    notes: page.locator('form').filter({ has: field }).getByLabel('Notes', { exact: true }),
    offer: page.getByTestId('representative-in-notes'),
  }
}

const save = async (page: any) => {
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await page.waitForURL(/\/invoicing\/contacts(\?.*)?$/)
}

test('a МОЛ typed in its field is stored tidy, and the contacts list finds the contact by it', async ({ page }) => {
  const { representative } = await openForm(page)
  await expect(representative).toHaveValue('')
  await representative.fill(`  ${typed}  `)
  await save(page)
  expect((await stored()).representative).toBe(typed)

  await page.getByLabel(/search/i).first().fill(typed.toLowerCase())
  await expect(page.getByRole('cell', { name: company })).toBeVisible()
})

test('a МОЛ kept as a notes line moves into the field, and only that line leaves the notes', async ({ page }) => {
  const { representative, notes, offer } = await openForm(page)
  await expect(representative).toHaveValue(typed)

  // The field holds another name: which of the two stays is a person's call, so nothing is offered.
  await notes.fill(notesWithLine)
  await expect(offer).toHaveCount(0)

  await representative.fill('')
  await expect(offer).toContainText(inNotes)
  await page.getByTestId('move-representative').click()
  await expect(representative).toHaveValue(inNotes)
  await expect(notes).toHaveValue(otherNotes)
  await expect(page.getByTestId('representative-moved')).toBeVisible()

  // Undone, both are as they were and the offer is back.
  await page.getByTestId('undo-move-representative').click()
  await expect(representative).toHaveValue('')
  await expect(notes).toHaveValue(notesWithLine)
  await expect(offer).toBeVisible()

  await page.getByTestId('move-representative').click()
  await expect(representative).toHaveValue(inNotes)
  // Nothing of it is stored until the contact is saved.
  expect((await stored()).representative).toBe(typed)
  await save(page)
  expect(await stored()).toMatchObject({ representative: inNotes, notes: otherNotes })

  // Opened again, the name is in its field and there is nothing left to move.
  const again = await openForm(page)
  await expect(again.representative).toHaveValue(inNotes)
  await expect(again.notes).toHaveValue(otherNotes)
  await expect(again.offer).toHaveCount(0)
})
