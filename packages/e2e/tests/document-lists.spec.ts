import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'
import { rowAction, rowOffers, rowOf } from './helpers/row-actions'
import { listGeometry } from './helpers/list-geometry'
import { lineValues } from './helpers/document-form'

/**
 * FR-22.23 / .24 / .50 — the document lists on a laptop.
 *
 * - A list fits 1366 px with no sideways scroll, a row is one line tall, and a row's actions are
 *   ONE menu button. A row of icons used to run past the table's edge at 1366 px, so the row's
 *   last actions were reached by scrolling sideways.
 * - Each action is offered exactly when the API takes it: Void on an issued document, Delete on a
 *   draft (the list offered „Анулирай" on drafts only and Delete on every row).
 * - A row offers Print, Copy and the credit note; the list's Create says what it creates.
 *
 * The rules themselves are held against the real routes in
 * `integration/document-row-actions.flow`; this spec holds the lists to them.
 */
test.use({ viewport: { width: 1366, height: 768 } })

const LISTS = [
  { path: '/invoicing/invoices', create: /^new invoice$/i, type: 'invoice', direction: 'outgoing' },
  { path: '/invoicing/bills', create: /^new incoming invoice$/i, type: 'invoice', direction: 'incoming' },
  { path: '/invoicing/proforma', create: /^new proforma invoice$/i, type: 'proforma', direction: 'outgoing' },
]

/** A draft of the kind a list shows (the seed has no proformas): a one-line service document. */
async function draftDocument(type: string, direction: string, description = `E2E list ${Date.now().toString(36)}`): Promise<any> {
  const session = await apiLogin()
  const side = direction === 'incoming' ? 'supplier' : 'customer'
  const { contacts } = await apiGet(session, `/invoicing/contact?type=${side}&size=1`)
  expect(contacts?.[0], `a seeded ${side}`).toBeTruthy()
  const res = await apiPost(session, '/invoices', {
    type,
    direction,
    contactId: contacts[0]._id,
    issueDate: new Date().toISOString().split('T')[0],
    currency: 'EUR',
    exchangeRate: 1,
    paymentMethod: 'bank_transfer',
    lines: [{ description, quantity: 1, unit: 'pcs', unitPrice: 100, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120 }],
    subtotal: 100,
    discountTotal: 0,
    taxTotal: 20,
    total: 120,
  })
  expect(res.status, `setup ${direction} ${type}: ${res.status}`).toBeLessThan(300)
  return { ...(await res.json()).invoice, contact: contacts[0], description }
}

for (const list of LISTS) {
  test(`${list.path}: fits 1366 px, one line and one menu per row, a labelled Create`, async ({ page }) => {
    await draftDocument(list.type, list.direction)
    await loginForApp(page)
    await page.goto(list.path)
    const rows = page.locator('.v-data-table tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 10000 })
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('create-button').first()).toHaveText(list.create)

    const geo = await listGeometry(page)
    expect(geo.rows, 'rows to measure').toBeGreaterThan(0)
    expect(geo.hidden, 'no sideways scroll at 1366 px').toBeLessThanOrEqual(1)
    expect(geo.tallest, 'every row is one line tall').toBeLessThan(2 * geo.lineHeight)
    expect(new Set(geo.actionButtons), 'one menu button per row').toEqual(new Set([1]))
  })
}

test('sales list: a row offers what the API allows for it — and Copy, Print, the credit note', async ({ page }) => {
  const session = await apiLogin()
  const description = `E2E row menu ${Date.now().toString(36)}`
  const draft = await draftDocument('invoice', 'outgoing', description)
  const issuedDraft = await draftDocument('invoice', 'outgoing', description)
  const contact = issuedDraft.contact
  const sent = (await (await apiPost(session, `/invoices/${issuedDraft._id}/send`, {})).json()).invoice
  expect(sent.status).toBe('sent')

  await loginForApp(page)

  // ── A draft: issued or deleted — never voided, emailed or corrected ──
  await page.goto(`/invoicing/invoices?q=${encodeURIComponent(draft.invoiceNumber)}`)
  const draftRow = rowOf(page, draft.invoiceNumber)
  await expect(draftRow).toBeVisible({ timeout: 10000 })
  for (const key of ['open', 'issue', 'print', 'copy', 'delete']) {
    expect(await rowOffers(draftRow, key), `a draft offers ${key}`).toBe(true)
  }
  for (const key of ['void', 'email', 'credit-note', 'payment']) {
    expect(await rowOffers(draftRow, key), `a draft does not offer ${key}`).toBe(false)
  }

  // ── An issued invoice: voided, paid, emailed, corrected — never deleted ──
  await page.goto(`/invoicing/invoices?q=${encodeURIComponent(sent.invoiceNumber)}`)
  const sentRow = rowOf(page, sent.invoiceNumber)
  await expect(sentRow).toBeVisible({ timeout: 10000 })
  for (const key of ['open', 'print', 'copy', 'payment', 'email', 'credit-note', 'debit-note', 'void']) {
    expect(await rowOffers(sentRow, key), `an issued invoice offers ${key}`).toBe(true)
  }
  for (const key of ['issue', 'delete']) {
    expect(await rowOffers(sentRow, key), `an issued invoice does not offer ${key}`).toBe(false)
  }

  // ── „Кредитно известие" from the row (FR-22.21 / .24): a note started from the invoice ──
  await (await rowAction(sentRow, 'credit-note')).click()
  await page.waitForURL(/\/invoicing\/invoices\/new\?.*type=credit_note/)
  expect(new URL(page.url()).searchParams.get('relatedInvoiceId')).toBe(String(sent._id))
  await expect(page.locator('.doc-banner-party')).toContainText(contact.companyName || contact.lastName || '')
  await expect.poll(() => lineValues(page), { timeout: 10000 }).toEqual(expect.arrayContaining([expect.stringContaining(description)]))

  // ── „Копирай" (FR-22.24): a new draft with the document's customer and lines ──
  await page.goto(`/invoicing/invoices?q=${encodeURIComponent(sent.invoiceNumber)}`)
  await expect(sentRow).toBeVisible({ timeout: 10000 })
  await (await rowAction(sentRow, 'copy')).click()
  await page.waitForURL(/\/invoicing\/invoices\/new\?.*copyOf=/)
  await expect(page.locator('.doc-banner-party')).toContainText(contact.companyName || contact.lastName || '')
  await expect.poll(() => lineValues(page), { timeout: 10000 }).toEqual(expect.arrayContaining([expect.stringContaining(description)]))

  // ── Void asks first, and a voided invoice offers neither Void nor Delete ──
  await page.goto(`/invoicing/invoices?q=${encodeURIComponent(sent.invoiceNumber)}`)
  await expect(sentRow).toBeVisible({ timeout: 10000 })
  await (await rowAction(sentRow, 'void')).click()
  const confirm = page.getByTestId('void-dialog')
  await expect(confirm).toContainText(sent.invoiceNumber)
  await confirm.getByRole('button', { name: /^void$/i }).click()
  await expect(sentRow.locator('.v-chip').filter({ hasText: /voided/i })).toBeVisible({ timeout: 10000 })
  expect(await rowOffers(sentRow, 'void')).toBe(false)
  expect(await rowOffers(sentRow, 'delete')).toBe(false)
})

test('sales list: Create offers the notes beside the invoice, and a notes list creates its note (D-8)', async ({ page }) => {
  await loginForApp(page)
  await page.goto('/invoicing/invoices')
  await expect(page.getByTestId('create-button').first()).toHaveText(/^new invoice$/i)
  await page.getByTestId('create-more').click()
  const others = page.getByTestId('create-more-list')
  await expect(others.getByText(/^new credit note$/i)).toBeVisible()
  await expect(others.getByText(/^new debit note$/i)).toBeVisible()
  await others.getByText(/^new debit note$/i).click()
  await page.waitForURL(/\/invoicing\/invoices\/new\?.*type=debit_note/)

  await page.goto('/invoicing/debit-notes')
  await expect(page.getByTestId('create-button').first()).toHaveText(/^new debit note$/i)
})
