import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'
import { draftDocument } from './helpers/draft-document'
import { receivedBill } from './helpers/bills'
import { answerIssuePayment } from './helpers/document-form'
import { actionKeys, bottomBar, collectDownloads, expectBars, headerBar, iconOnlyKeys, isOneLine, printDialog } from './helpers/form-action-bars'

/**
 * A document form's actions (owner, 2026-11-15).
 *
 * One list feeds the bar under the title and the bar at the foot of the form: the same actions, in
 * the same order, whatever the document's state. Send by e-mail and Print are in those bars and
 * nowhere in the body. An issued invoice keeps its Save under the title too.
 *
 * „Issue and print" asks HOW to print first: the Print dialog, its columns folded away. Its
 * confirmation is what saves, issues and prints; closing it does nothing at all.
 *
 * Each test makes its own document through the API (one service line, so nothing moves stock).
 */

const NUMBER = '.doc-banner-meta .text-h6'

/** An issued sales invoice, made and issued through the API. */
async function issuedInvoice(): Promise<{ id: string; number: string }> {
  const draft = await draftDocument('invoice', 'outgoing', `E2E actions ${Date.now().toString(36)}`)
  const session = await apiLogin()
  const sent = await apiPost(session, `/invoices/${draft.id}/send`, {})
  expect(sent.status, 'issue the fixture invoice').toBe(200)
  return { id: draft.id, number: (await sent.json()).invoice.invoiceNumber }
}

test.describe('Document form: one list of actions, under the title and at the foot', () => {
  test('a new sales invoice offers the same actions in both bars, and none in its body', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 15000 })

    // Not saved yet: nothing to e-mail. Print is offered (it saves first), Import comes last.
    await expectBars(page, ['issue-print', 'issue', 'save', 'print', 'import'])

    // Each action once per bar: the title's keeps its test id, the foot's says `-bottom`.
    for (const id of ['issue-and-print', 'print-now', 'print-options']) {
      await expect(page.getByTestId(id)).toHaveCount(1)
      await expect(page.getByTestId(`${id}-bottom`)).toHaveCount(1)
      await expect(headerBar(page).getByTestId(id)).toBeVisible()
      await expect(bottomBar(page).getByTestId(`${id}-bottom`)).toBeVisible()
    }
    // Two Prints on the page and no third: the row that used to sit above „Due date" is gone.
    await expect(page.locator('[data-action="print"]')).toHaveCount(2)
    await expect(page.locator('[data-action="email"]')).toHaveCount(0)
  })

  test('a draft offers „Send by email" disabled, and says why, in both bars', async ({ page }) => {
    const draft = await draftDocument('invoice', 'outgoing')
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${draft.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(draft.invoiceNumber, { timeout: 15000 })

    await expectBars(page, ['issue-print', 'issue', 'save', 'email', 'print', 'import'])

    for (const bar of [headerBar(page), bottomBar(page)]) {
      const email = bar.locator('[data-action="email"]')
      await expect(email.getByRole('button', { name: /send by email/i })).toBeDisabled()
      await email.hover()
      await expect(page.locator('.v-overlay--active').filter({ hasText: /issue the document before emailing it/i })).toBeVisible()
      await page.mouse.move(0, 0)
    }
  })

  test('an issued sales invoice keeps Save under its title; the bars stay the same list', async ({ page }) => {
    const invoice = await issuedInvoice()
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${invoice.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(invoice.number, { timeout: 15000 })

    // What it can still change, what follows from it, then how it goes out. No Import once issued.
    await expectBars(page, ['save', 'payment', 'credit-note', 'debit-note', 'attach', 'email', 'print'])

    for (const bar of [headerBar(page), bottomBar(page)]) {
      await expect(bar.locator('[data-action="save"]').getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      await expect(bar.locator('[data-action="email"]').getByRole('button', { name: /send by email/i })).toBeEnabled()
    }

    // The Save under the title saves: the document is stored again, and the user stays on it.
    const saved = page.waitForResponse((r) => r.url().includes(`/invoices/${invoice.id}`) && r.request().method() === 'PUT')
    await headerBar(page).locator('[data-action="save"]').getByRole('button', { name: 'Save', exact: true }).click()
    expect((await saved).status()).toBe(200)
    await expect(page).toHaveURL(new RegExp(`/invoicing/invoices/${invoice.id}/edit`))
    await expect(page.locator(NUMBER)).toHaveText(invoice.number)
    await expectBars(page, ['save', 'payment', 'credit-note', 'debit-note', 'attach', 'email', 'print'])
  })

  test('a supplier bill: new, then received with its goods booked', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    await expect(page.getByRole('heading', { name: /new/i }).first()).toBeVisible({ timeout: 15000 })
    // A bill is nothing we send: no e-mail, in either bar.
    await expectBars(page, ['receive', 'save', 'print', 'import'])

    const bill = await receivedBill()
    await page.goto(`/invoicing/bills/${bill.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(bill.number, { timeout: 15000 })
    await expectBars(page, ['save', 'credit-note', 'debit-note', 'print', 'stock-receipt', 'import'])

    // The stock receipt is the same action at the foot: it asks which price to print, as the one
    // under the title does, and prints the same document.
    await expect(page.getByTestId('print-stock-receipt')).toHaveCount(1)
    const foot = page.getByTestId('print-stock-receipt-bottom')
    await expect(foot).toHaveCount(1)
    await foot.click()
    await expect(page.getByTestId('stock-receipt-dialog')).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('stock-receipt-confirm').click()])
    expect(download.suggestedFilename()).toBe(`${bill.number}-stock-receipt.pdf`)
    await expect(page.getByTestId('stock-receipt-dialog')).toBeHidden()
  })

  test('where a bar is too narrow for every label, the rarest give theirs up and keep their name', async ({ page }) => {
    const invoice = await issuedInvoice()
    await loginForApp(page)
    // Wide first: every action says what it is.
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto(`/invoicing/invoices/${invoice.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(invoice.number, { timeout: 15000 })
    await expectBars(page, ['save', 'payment', 'credit-note', 'debit-note', 'attach', 'email', 'print'])
    await expect.poll(() => iconOnlyKeys(headerBar(page))).toEqual([])
    await expect.poll(() => iconOnlyKeys(bottomBar(page))).toEqual([])

    // Narrow: the bars stay one line, and labels go in the order of how rarely the action is used.
    // Save and the payment never give theirs up.
    await page.setViewportSize({ width: 1000, height: 900 })
    const givesUp = ['attach', 'debit-note', 'credit-note', 'email', 'print']
    for (const bar of [headerBar(page), bottomBar(page)]) {
      await expect.poll(async () => (await iconOnlyKeys(bar)).length, { timeout: 10000 }).toBeGreaterThan(0)
      await expect.poll(() => isOneLine(bar)).toBe(true)
      const icons = await iconOnlyKeys(bar)
      // The first so-many of the order, whatever the fonts made of the widths.
      expect([...icons].sort()).toEqual(givesUp.slice(0, icons.length).sort())
      // An icon keeps its name for a screen reader, and shows it on hover.
      const attach = bar.locator('[data-action="attach"]').getByRole('button', { name: /attach to cash sale/i })
      await expect(attach).toBeVisible()
      await expect(attach).not.toContainText(/attach/i)
      await attach.hover()
      await expect(page.locator('.v-overlay--active').filter({ hasText: /attach to cash sale/i })).toBeVisible()
      await page.mouse.move(0, 0)
    }
    expect(await actionKeys(headerBar(page))).toEqual(await actionKeys(bottomBar(page)))

    // And wide again: every label is back.
    await page.setViewportSize({ width: 1920, height: 900 })
    await expect.poll(() => iconOnlyKeys(headerBar(page)), { timeout: 10000 }).toEqual([])
    await expect.poll(() => iconOnlyKeys(bottomBar(page))).toEqual([])
  })
})

test.describe('„Issue and print" asks how to print first', () => {
  test('a form that cannot be saved says so before it asks anything', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(page.getByTestId('issue-and-print')).toBeVisible({ timeout: 15000 })

    // A document with no date is one the form refuses to save.
    const date = page.getByTestId('issue-date').locator('input')
    const today = await date.inputValue()
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await date.fill('')
    await page.getByTestId('issue-and-print').click()

    // The form says what is missing, and no dialog was opened over it.
    await expect(page.locator('[data-testid="issue-date"].v-input--error')).toBeVisible()
    await expect(page.getByTestId('export-confirm')).toHaveCount(0)

    // With its date back, it asks how to print. Closing that leaves a new document new: nothing was saved.
    await date.fill(today)
    await page.getByTestId('issue-and-print').click()
    const dialog = printDialog(page)
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-cancel').click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/invoicing\/invoices\/new/)
  })

  test('the Print dialog opens with its columns folded; Cancel issues nothing and prints nothing', async ({ page }) => {
    const draft = await draftDocument('invoice', 'outgoing')
    const session = await apiLogin()
    const before = (await apiGet(session, `/invoices/${draft.id}`)).invoice
    await loginForApp(page)
    const downloads = collectDownloads(page)
    await page.goto(`/invoicing/invoices/${draft.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(draft.invoiceNumber, { timeout: 15000 })

    await page.getByTestId('issue-and-print').click()

    const dialog = printDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.v-card-title')).toHaveText(/^\s*Print\s*$/)
    await expect(dialog.getByTestId('export-format').getByRole('radio', { name: 'PDF' })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /excel/i })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /compact/i })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /detailed/i })).toBeVisible()
    await expect(dialog).toContainText('Additional documents')
    await expect(dialog).toContainText('Each selected document is downloaded as a separate file, in the chosen format.')
    await expect(dialog.getByRole('checkbox', { name: /declaration of conformity/i })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: /handover/i })).toBeVisible()
    // The button that finishes the job says what it will do.
    await expect(dialog.getByTestId('export-confirm')).toHaveText(/issue and print/i)

    // Columns: there, folded, and counted.
    const toggle = dialog.getByTestId('export-columns-toggle')
    const columns = dialog.getByTestId('export-columns')
    const count = dialog.getByTestId('export-columns-count')
    await expect(toggle).toContainText('Columns')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(columns).toBeHidden()
    await expect(count).toHaveText(/^\s*\d+ selected\s*$/)
    const chosen = Number((await count.textContent())!.trim().split(' ')[0])
    expect(chosen).toBeGreaterThan(0)

    // Opened, they are the checkboxes they always were, and the count follows them.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(columns).toBeVisible()
    await expect(columns.getByRole('checkbox', { checked: true })).toHaveCount(chosen)
    await columns.getByRole('checkbox', { checked: true }).first().uncheck()
    await expect(count).toHaveText(new RegExp(`^\\s*${chosen - 1} selected\\s*$`))
    // And folded again by the same header.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(columns).toBeHidden()

    await dialog.getByTestId('export-cancel').click()
    await expect(dialog).toBeHidden()

    // Nothing happened to the document: still the draft it was, not saved again, nothing printed.
    await expect(page.getByTestId('issue-payment-confirm')).toHaveCount(0)
    await expect(page.locator(NUMBER)).toHaveText(draft.invoiceNumber)
    const after = (await apiGet(session, `/invoices/${draft.id}`)).invoice
    expect(after.status).toBe('draft')
    expect(after.invoiceNumber).toBe(draft.invoiceNumber)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(downloads).toHaveLength(0)

    // Asked again, it starts folded again, with the columns it had: the unticked one was never printed with.
    await page.getByTestId('issue-and-print').click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(count).toHaveText(new RegExp(`^\\s*${chosen} selected\\s*$`))
    await dialog.getByTestId('export-cancel').click()
    await expect(dialog).toBeHidden()
  })

  test('confirming it issues the invoice and prints what was chosen, a file per document; the next Print starts there', async ({ page }) => {
    const draft = await draftDocument('invoice', 'outgoing')
    await loginForApp(page)
    const downloads = collectDownloads(page)
    await page.goto(`/invoicing/invoices/${draft.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(draft.invoiceNumber, { timeout: 15000 })

    // From the foot of the form this time: the same action.
    await page.getByTestId('issue-and-print-bottom').click()
    const dialog = printDialog(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: /excel/i }).check()
    await dialog.getByRole('checkbox', { name: /declaration of conformity/i }).check()
    await dialog.getByTestId('export-confirm').click()

    // The dialog has said its part; what issuing asks is asked over the form.
    await expect(dialog).toBeHidden()
    await answerIssuePayment(page)

    // Issued: a number of the issued series, and no longer a draft.
    await expect(page.locator(NUMBER)).not.toHaveText(draft.invoiceNumber, { timeout: 20000 })
    const number = (await page.locator(NUMBER).textContent())!.trim()
    expect(number).not.toMatch(/^DRF-/)
    const session = await apiLogin()
    const issued = (await apiGet(session, `/invoices/${draft.id}`)).invoice
    expect(issued.status).not.toBe('draft')
    expect(issued.invoiceNumber).toBe(number)

    // Printed as the dialog said: the invoice and the document ticked with it, each a file, in Excel.
    await expect.poll(() => downloads.length, { timeout: 60000 }).toBe(2)
    expect(downloads.map((d) => d.suggestedFilename())).toEqual([`${number}.xlsx`, `${number}-certificate.xlsx`])

    // Issued, it offers what an issued invoice offers, in both bars.
    await expectBars(page, ['save', 'payment', 'credit-note', 'debit-note', 'attach', 'email', 'print'])

    // Plain Print is still one click, and starts from what was just chosen: Excel, and no companion.
    await page.getByTestId('print-now').click()
    await expect.poll(() => downloads.length, { timeout: 30000 }).toBe(3)
    expect(downloads[2].suggestedFilename()).toBe(`${number}.xlsx`)

    // „Print with options…" is the same dialog, for a print alone: it downloads, and issues nothing.
    await page.getByTestId('print-options').click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('export-confirm')).toHaveText(/^\s*download\s*$/i)
    await expect(dialog.getByRole('radio', { name: /excel/i })).toBeChecked()
    await expect(dialog.getByTestId('export-columns-toggle')).toHaveAttribute('aria-expanded', 'false')
    // A companion is asked for each time, never carried over.
    await expect(dialog.getByRole('checkbox', { name: /declaration of conformity/i })).not.toBeChecked()
    await dialog.getByTestId('export-cancel').click()
    await expect(dialog).toBeHidden()
    expect(downloads).toHaveLength(3)
  })

  test('a proforma is issued and printed the same way, with no payment question', async ({ page }) => {
    const draft = await draftDocument('proforma', 'outgoing')
    await loginForApp(page)
    const downloads = collectDownloads(page)
    await page.goto(`/invoicing/proforma/${draft.id}/edit`)
    await expect(page.locator(NUMBER)).toHaveText(draft.invoiceNumber, { timeout: 15000 })

    await page.getByTestId('issue-and-print').click()
    const dialog = printDialog(page)
    await expect(dialog.getByTestId('export-columns-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog.getByTestId('export-confirm')).toHaveText(/issue and print/i)
    await dialog.getByTestId('export-confirm').click()

    await expect(page.locator(NUMBER)).not.toHaveText(draft.invoiceNumber, { timeout: 20000 })
    const number = (await page.locator(NUMBER).textContent())!.trim()
    expect(number).not.toMatch(/^DRF-/)
    await expect.poll(() => downloads.length, { timeout: 60000 }).toBe(1)
    expect(downloads[0].suggestedFilename()).toBe(`${number}.pdf`)
    await expect(page.getByTestId('issue-payment-confirm')).toHaveCount(0)
  })
})
