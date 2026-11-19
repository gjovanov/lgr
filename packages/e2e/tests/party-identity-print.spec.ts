import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost, apiPut } from './helpers/api'
import { okJson } from './helpers/bills'
import { draftDocument } from './helpers/draft-document'
import { pdfHasText } from './helpers/pdf-text'

/**
 * FR-25a §3.5 and §3.7 on paper: what a printed invoice says of its two parties beyond their names, the customer's МОЛ
 * and the company's, and the town the company issues its documents in where a document names no place of its own.
 *
 * The invoice form is the printed form on screen (its party blocks and its signature footer), and Print brings down the
 * server's PDF, which must say the same. What the HTML says, byte for byte, is `unit/print-party-identity.test.ts`; here
 * the path a person takes: the field set, the form shows it, the print carries it.
 *
 * The company is the suite's shared org: its МОЛ and town are put back when the spec ends (as `org-settings-save.spec.ts`
 * does). Everything else is this spec's own and is removed.
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
let admin: Awaited<ReturnType<typeof apiLogin>>

/** Today, as a date input holds it. */
const today = () => new Date().toISOString().split('T')[0]

/** Print, as the form offers it in one click, and the PDF it brings down. */
async function printed(page: any, number: string): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('print-now').click()])
  expect(download.suggestedFilename()).toBe(`${number}.pdf`)
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
  return bytes
}

test.beforeAll(async () => {
  admin = await apiLogin()
})

test.describe('the customer\'s МОЛ', () => {
  const representative = `Петър Тестов ${stamp}`
  let contactId = ''
  let invoiceId = ''
  let number = ''

  test.beforeAll(async () => {
    const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', {
      type: 'customer', companyName: `E2E Printed Representative ${stamp} LTD`, representative,
    }))
    contactId = String(contact._id || contact.id)
    const { invoice } = await okJson(await apiPost(admin, '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId, issueDate: today(), currency: 'EUR', exchangeRate: 1, paymentMethod: 'bank_transfer',
      lines: [{ description: `E2E printed line ${stamp}`, quantity: 1, unit: 'pcs', unitPrice: 100, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120 }],
      subtotal: 100, discountTotal: 0, taxTotal: 20, total: 120,
    }))
    invoiceId = String(invoice._id || invoice.id)
    number = invoice.invoiceNumber
  })

  test.afterAll(async () => {
    // A draft: the route deletes it. Then the contact.
    if (invoiceId) await apiDelete(admin, `/invoices/${invoiceId}`)
    if (contactId) await apiDelete(admin, `/invoicing/contact/${contactId}`)
  })

  test('the invoice to a customer with a МОЛ prints it in the customer\'s block', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${invoiceId}/edit`)
    await expect(page.getByTestId('contact-party-representative')).toHaveText(`Representative: ${representative}`, { timeout: 15000 })

    const pdf = await printed(page, number)
    expect(pdfHasText(pdf, representative), 'the printed invoice names the customer\'s МОЛ').toBe(true)
  })
})

test.describe('the company\'s МОЛ and place of issue', () => {
  const representative = `Мария Примерова ${stamp}`
  const town = `Тестоград ${stamp}`
  let before: any

  test.beforeAll(async () => {
    before = (await apiGet(admin, '')).org
    // As Settings → Organization saves them (`org-settings-save.spec.ts` is that page's own spec).
    const res = await apiPut(admin, '', { representative, placeOfIssue: town })
    expect(res.status).toBe(200)
  })

  test.afterAll(async () => {
    if (before) await apiPut(admin, '', { representative: before.representative ?? '', placeOfIssue: before.placeOfIssue ?? '' })
  })

  test('a new invoice prints the company\'s МОЛ, and its town as the place where the document names none', async ({ page }) => {
    // Signed in after the company set them: the session's org carries them.
    await loginForApp(page)

    // An invoice made now, with no place of its own, prints both.
    const draft = await draftDocument('invoice', 'outgoing', `E2E company identity ${stamp}`)
    try {
      await page.goto(`/invoicing/invoices/${draft.id}/edit`)
      await expect(page.getByTestId('org-party-representative')).toHaveText(`Representative: ${representative}`, { timeout: 15000 })
      await expect(page.locator('.signature-footer')).toContainText(`Place of transaction: ${town}`)
      const pdf = await printed(page, draft.invoiceNumber)
      expect(pdfHasText(pdf, representative), 'the printed invoice names the company\'s МОЛ').toBe(true)
      expect(pdfHasText(pdf, town), 'the printed invoice names the town of issue').toBe(true)
    } finally {
      await apiDelete(admin, `/invoices/${draft.id}`)
    }

    // The new invoice's form, which is the printed form on screen. It starts at its warehouse's town (FR-22.27), a
    // place of its own; emptied, it names none, and the company's town is what it prints.
    await page.goto('/invoicing/invoices/new')
    await expect(page.getByTestId('org-party-representative')).toHaveText(`Representative: ${representative}`, { timeout: 15000 })
    await page.getByLabel('Place of transaction', { exact: true }).fill('')
    await expect(page.locator('.signature-footer')).toContainText(`Place of transaction: ${town}`)
  })
})
