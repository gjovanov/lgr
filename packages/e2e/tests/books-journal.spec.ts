import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPut } from './helpers/api'
import { BOOKS_ADMIN, BOOKS_ORG, CUSTOMER, PAID_INVOICE, PART_PAID_INVOICE, PAYMENT, VAT_PERIOD, booksOrgReady } from './helpers/books-org'

/**
 * FR-25a §3.6 and §3.8 on an org that keeps imported books: the journal entries the books import wrote, with their
 * document header, and the filed VAT month whose rows are those documents (`packages/tests/src/helpers/books-org.ts`).
 *
 * An imported entry is as booked: it shows its header and offers no edit, and the server refuses one. The journal's
 * "unpaid" filter lists an invoice paid in part, and not one paid in full. A link opens the document it names, and a
 * VAT register row opens its journal entry.
 *
 * Skipped without the books org (`E2E_BOOKS_ORG`): a run on the plain seed has none.
 */
test.skip(!booksOrgReady(), 'needs the books org that scripts/nightly.ts adds after the seed')

type Session = Awaited<ReturnType<typeof apiLogin>>
let session: Session
/** The imported entries, by `<docType> <docNumber>`. */
let entries: Map<string, any>

const keyOf = (d: { docType: string; docNumber: string }) => `${d.docType} ${d.docNumber}`
const idOf = (doc: any) => String(doc?._id ?? doc?.id ?? '')
const entryOf = (d: { docType: string; docNumber: string }) => {
  const entry = entries.get(keyOf(d))
  expect(entry, `the import wrote ${keyOf(d)}`).toBeTruthy()
  return entry
}
const signIn = (page: any) => loginForApp(page, BOOKS_ORG.slug, BOOKS_ADMIN.username, BOOKS_ADMIN.password)
const cardOf = (page: any) => page.getByTestId('journal-document-card')

test.beforeAll(async () => {
  session = await apiLogin(BOOKS_ORG.slug, BOOKS_ADMIN.username, BOOKS_ADMIN.password)
  const { journalEntries } = await apiGet(session, '/accounting/journal?size=0')
  entries = new Map(journalEntries.filter((e: any) => e.docType).map((e: any) => [keyOf(e), e]))
})

test('an imported entry shows its document header, as booked, and refuses an edit', async ({ page }) => {
  const invoice = entryOf(PART_PAID_INVOICE)
  expect(invoice).toMatchObject({ sourceModule: 'plusminus', ledger: 'books', status: 'posted' })
  const put = await apiPut(session, `/accounting/journal/${idOf(invoice)}`, { description: 'Changed by e2e' })
  expect(put.status, 'the server refuses an edit of an imported entry').toBe(422)
  expect((await put.json()).code).toBe('journal_entry_as_booked')

  await signIn(page)
  await page.goto(`/accounting/journal-entries/${idOf(invoice)}/edit`)
  const card = cardOf(page)
  // It says something of its document, so its card opens; and it is as booked.
  await expect(card).toHaveAttribute('data-open', 'true', { timeout: 15000 })
  await expect(card.getByTestId('as-booked-chip')).toBeVisible()

  await expect(card.getByRole('combobox', { name: /^document type$/i })).toHaveValue(PART_PAID_INVOICE.docType)
  const number = card.getByLabel(/^document number$/i)
  await expect(number).toHaveValue(PART_PAID_INVOICE.docNumber)
  await expect(number).toBeDisabled()
  await expect(card.getByRole('combobox', { name: /^register type$/i })).toHaveValue('01 · Invoice')
  await expect(card.getByRole('combobox', { name: /^paid by$/i })).toHaveValue('Bank')
  await expect(card.getByLabel(/^paid$/i)).toHaveValue(String(PART_PAID_INVOICE.paid))
  await expect(card.getByLabel(/^partner$/i)).toHaveValue(CUSTOMER.name)
  // The total, and what of it is still open.
  await expect(card).toContainText(`${PART_PAID_INVOICE.total.toFixed(2)}`)
  await expect(card).toContainText(`${PART_PAID_INVOICE.open.toFixed(2)}`)
  // Who keyed it in the accountant's program.
  await expect(card.getByTestId('journal-source')).toContainText('operator1')

  // Nothing to save, post or void, and the entry's own fields take no input.
  for (const name of [/^save$/i, /^post$/i, /^void$/i]) await expect(page.getByRole('button', { name })).toHaveCount(0)
  await expect(page.getByLabel(/^description$/i).first()).toBeDisabled()
})

test('the unpaid filter lists an invoice paid in part, and not one paid in full', async ({ page }) => {
  const partPaid = entryOf(PART_PAID_INVOICE)
  const paid = entryOf(PAID_INVOICE)
  const { journalEntries } = await apiGet(session, '/accounting/journal?unpaid=true&size=0')
  const unpaid = journalEntries.map(keyOf)
  expect(unpaid).toContain(keyOf(PART_PAID_INVOICE))
  expect(unpaid).not.toContain(keyOf(PAID_INVOICE))

  await signIn(page)
  await page.goto('/accounting/journal-entries')
  await expect(page.getByRole('heading', { name: /journal entries/i })).toBeVisible({ timeout: 15000 })
  const row = (entry: any) => page.locator('.v-data-table tbody tr').filter({ hasText: entry.entryNumber })
  await expect(row(partPaid)).toHaveCount(1, { timeout: 15000 })
  await expect(row(paid)).toHaveCount(1)

  const [request] = await Promise.all([
    page.waitForRequest((r: any) => new URL(r.url()).pathname.endsWith('/accounting/journal') && new URL(r.url()).searchParams.get('unpaid') === 'true'),
    page.getByLabel(/^unpaid$/i).check(),
  ])
  expect(request.method()).toBe('GET')
  await expect(row(paid)).toHaveCount(0, { timeout: 15000 })
  await expect(row(partPaid)).toHaveCount(1)
})

test('a link opens the document it names, and that one links back', async ({ page }) => {
  const invoice = entryOf(PART_PAID_INVOICE)
  const payment = entryOf(PAYMENT)
  // The server found the one entry each link names.
  const { journalEntry } = await apiGet(session, `/accounting/journal/${idOf(invoice)}`)
  expect(journalEntry.links).toEqual([expect.objectContaining({ docType: PAYMENT.docType, docNumber: PAYMENT.docNumber, entryId: idOf(payment) })])

  await signIn(page)
  await page.goto(`/accounting/journal-entries/${idOf(invoice)}/edit`)
  const card = cardOf(page)
  const link = card.getByTestId('journal-links').locator('tbody tr').filter({ hasText: PAYMENT.docType })
  await expect(link).toContainText(PAYMENT.docNumber, { timeout: 15000 })
  await link.getByRole('button', { name: /open the linked entry/i }).click()

  await expect(page).toHaveURL(new RegExp(`/accounting/journal-entries/${idOf(payment)}/edit$`))
  await expect(card.getByLabel(/^document number$/i)).toHaveValue(PAYMENT.docNumber, { timeout: 15000 })
  await expect(card.getByRole('combobox', { name: /^document type$/i })).toHaveValue(PAYMENT.docType)

  // The payment names the invoice it paid: a click on its row opens that one.
  const back = card.getByTestId('journal-links').locator('tbody tr').filter({ hasText: PART_PAID_INVOICE.docNumber })
  await back.click()
  await expect(page).toHaveURL(new RegExp(`/accounting/journal-entries/${idOf(invoice)}/edit$`))
})

test('a row of the filed VAT register opens its journal entry', async ({ page }) => {
  const invoice = entryOf(PART_PAID_INVOICE)
  await signIn(page)
  await page.goto(`/accounting/tax-returns/${VAT_PERIOD}`)
  const row = page.locator('.v-data-table tbody tr').filter({ hasText: PART_PAID_INVOICE.docNumber })
  await expect(row).toHaveCount(1, { timeout: 15000 })
  // The register's row is found by its type and number, and names the entry by its number.
  const entry = row.getByRole('link', { name: invoice.entryNumber })
  await expect(entry).toBeVisible()
  // The other row is the other invoice's, and opens that one's entry.
  await expect(page.locator('.v-data-table tbody tr').filter({ hasText: PAID_INVOICE.docNumber }).getByRole('link', { name: entryOf(PAID_INVOICE).entryNumber })).toBeVisible()

  await entry.click()
  await expect(page).toHaveURL(new RegExp(`/accounting/journal-entries/${idOf(invoice)}/edit$`))
  await expect(cardOf(page).getByLabel(/^document number$/i)).toHaveValue(PART_PAID_INVOICE.docNumber, { timeout: 15000 })
})
