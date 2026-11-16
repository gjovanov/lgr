import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'
import { rowOf } from './helpers/row-actions'
import { listGeometry } from './helpers/list-geometry'

/**
 * A list's ticked documents by e-mail (2026-11-16): the tick column, the bar and the dialog, as the person at the
 * list meets them.
 *
 * Documents of this spec's own, found by its reference (`E2E-MAIL-<stamp>`): three issued invoices for three
 * customers, of whom one has no address on its card, a draft, an issued proforma and offer, a received bill, and a
 * supplier order with two suppliers.
 *
 * What it pins:
 * - ticking shows the bar; the dialog starts on „To the customer / supplier" with a line per customer and the card's
 *   address in it, which can be typed over; a draft is named as not going; a line without an address stays behind;
 *   an invalid address blocks; what went leaves the selection and the rest stays ticked;
 * - „To one address": one request for everything, the results per recipient when something did not go, and the
 *   address remembered for the next time;
 * - a server with no mail key: the first refusal stops the batch, is shown in the server's words, and nothing leaves
 *   the selection;
 * - a role that only reads ticks and clears, and is offered no mail;
 * - the other lists (proforma, offers, bills, supplier orders) carry the same bar, and an order goes as one sheet per
 *   supplier.
 *
 * ⚠ No mail leaves this spec. The mail request is answered by `page.route` everywhere but in the one case that
 * needs the server's own refusal, and that case first asks the server, with a draft that is never mailed, whether
 * it can mail at all: where it can, the case is skipped.
 *
 * The rules themselves (who is mailed what, the caps, the refusals) are held against the real routes in
 * `integration/doc-email.flow` and `doc-email-engine`, the dialog's planning in `unit/batch-email`.
 *
 * Serial: the cases share the documents and the member user.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

const stamp = Date.now().toString(36)
const ref = `E2E-MAIL-${stamp}`
const PASSWORD = 'e2e-test-pw-12345'
const memberName = `member-mail-${stamp}`
const today = new Date().toISOString().slice(0, 10)

const address = {
  a: `a-${stamp}@buyer.test`,
  b: `b-${stamp}@buyer.test`,
  typedOver: `office-${stamp}@buyer.test`,
  colleague: `colleague-${stamp}@office.test`,
  supplier: `orders-${stamp}@supplier.test`,
  secondSupplier: `second-${stamp}@supplier.test`,
}

let admin: Awaited<ReturnType<typeof apiLogin>>
/** The contacts and documents of this spec, by a short key. */
const who: Record<string, { id: string; name: string }> = {}
const doc: Record<string, { id: string; number: string }> = {}
const made: { issued: string[]; drafts: string[]; orders: string[]; member?: string } = { issued: [], drafts: [], orders: [] }

const numberOf = (id: string) => Object.values(doc).find((d) => d.id === id)?.number ?? ''

test.beforeAll(async () => {
  admin = await apiLogin()

  const contact = async (key: string, type: 'customer' | 'supplier', email?: string) => {
    const name = `E2E Mail ${key} ${stamp}`
    const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type, companyName: name, ...(email ? { email } : {}) }))
    who[key] = { id: String(contact._id || contact.id), name }
  }
  await contact('A', 'customer', address.a)
  await contact('B', 'customer', address.b)
  await contact('C', 'customer') // no address on its card
  await contact('S', 'supplier', address.supplier)
  await contact('T', 'supplier') // no address on its card

  /** A one-line service document, issued by `issue` or left a draft. */
  const document = async (key: string, type: string, direction: 'incoming' | 'outgoing', partner: string, issue?: 'send' | 'receive') => {
    const { invoice } = await okJson(await apiPost(admin, '/invoices', {
      type, direction, contactId: who[partner]!.id, issueDate: today, currency: 'EUR', exchangeRate: 1, paymentMethod: 'bank_transfer', reference: ref,
      lines: [{ description: `E2E mail ${key} ${stamp}`, quantity: 1, unit: 'pcs', unitPrice: 100, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120 }],
      subtotal: 100, discountTotal: 0, taxTotal: 20, total: 120,
    }))
    const id = String(invoice.id || invoice._id)
    const issued = issue ? (await okJson(await apiPost(admin, `/invoices/${id}/${issue}`, {}))).invoice : invoice
    ;(issue ? made.issued : made.drafts).push(id)
    doc[key] = { id, number: issued.invoiceNumber }
  }
  await document('a1', 'invoice', 'outgoing', 'A', 'send')
  await document('b1', 'invoice', 'outgoing', 'B', 'send')
  await document('c1', 'invoice', 'outgoing', 'C', 'send')
  await document('draft', 'invoice', 'outgoing', 'A')
  await document('proforma', 'proforma', 'outgoing', 'A', 'send')
  await document('offer', 'offer', 'outgoing', 'B', 'send')
  await document('bill', 'invoice', 'incoming', 'S', 'receive')

  // One supplier order with two suppliers: it is mailed as one sheet per supplier.
  const { order } = await okJson(await apiPost(admin, '/invoicing/orders', {
    issueDate: today, currency: 'EUR', tags: [],
    supplierGroups: [
      { supplierId: who.S!.id, lines: [{ description: `E2E mail bolts ${stamp}`, quantity: 3, unit: 'pcs', expectedUnitPrice: 2 }] },
      { supplierId: who.T!.id, lines: [{ description: `E2E mail nuts ${stamp}`, quantity: 5, unit: 'pcs', expectedUnitPrice: 1 }] },
    ],
  }))
  const sent = (await okJson(await apiPost(admin, `/invoicing/orders/${order._id}/send`, {}))).order
  doc.order = { id: String(order._id), number: sent.orderNumber }
  made.orders.push(doc.order.id)

  // A read-only member: it opens the lists, and mails nothing.
  const { user } = await okJson(await apiPost(admin, '/user', {
    email: `${memberName}@acme.com`, username: memberName, password: PASSWORD, firstName: 'Read', lastName: 'Only', role: 'member',
  }))
  made.member = user?._id || user?.id
})

// Everything this spec made, undone: issued documents are voided, the draft deleted, the order cancelled, and the
// contacts deactivated (a later spec asks for "the newest active contact", `helpers/api.ts#activeContact`).
test.afterAll(async () => {
  for (const id of made.issued) await apiPost(admin, `/invoices/${id}/void`, {}).catch(() => null)
  for (const id of made.drafts) await apiDelete(admin, `/invoices/${id}`).catch(() => null)
  for (const id of made.orders) await apiPost(admin, `/invoicing/orders/${id}/cancel`, {}).catch(() => null)
  for (const c of Object.values(who)) await apiDelete(admin, `/invoicing/contact/${c.id}`).catch(() => null)
  if (made.member) await apiDelete(admin, `/user/${made.member}`).catch(() => null)
})

/** A list searched for `q`, once the row numbered `number` is in. */
async function openList(page: any, path: string, q: string, number: string) {
  await page.goto(`${path}?q=${encodeURIComponent(q)}`)
  await expect(rowOf(page, number)).toBeVisible({ timeout: 15000 })
}
const tick = (page: any, number: string) => rowOf(page, number).locator('.v-selection-control').first().click()
const tickOf = (page: any, number: string) => rowOf(page, number).locator('.v-selection-control input')
const expectSelected = (page: any, n: number) => expect(page.getByTestId('selection-count')).toHaveText(new RegExp(String.raw`^\s*${n} selected\s*$`))

/** The dialog, once its preview is in. */
async function openDialog(page: any, kind = 'invoice') {
  await page.getByTestId('email-selected').click()
  const dialog = page.getByTestId('batch-email-dialog')
  await expect(dialog).toHaveAttribute('data-phase', 'compose', { timeout: 15000 })
  await expect(dialog).toHaveAttribute('data-kind', kind)
  return dialog
}
/** A partner's line of the dialog. ⚠ A Vuetify field's test id sits on its root: the value is its `input`'s. */
const lineOf = (dialog: any, partner: string) => dialog.locator(`[data-testid="batch-email-recipient"][data-partner="${who[partner]!.id}"]`)
const modeOf = (dialog: any, mode: 'partner' | 'single') => dialog.getByTestId(`batch-email-mode-${mode}`).locator('input')

/**
 * Stands in for the mail request, so that nothing is mailed: remembers each body and answers as `answer` says, or
 * that every document went. ⚠ The pattern ends at `email`: the preview (`…/email/preview`) reaches the server.
 */
async function stubMail(page: any, answer?: (body: any) => any) {
  const bodies: any[] = []
  await page.route('**/invoicing/export/email', async (route: any) => {
    const body = route.request().postDataJSON()
    bodies.push(body)
    const went = {
      to: body.to, mails: 1, queued: false,
      results: body.items.map((i: any) => ({ id: i.id, ...(i.groupId ? { groupId: i.groupId } : {}), number: numberOf(i.id), status: 'sent' })),
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer?.(body) ?? went) })
  })
  return bodies
}

test('sales list: the ticked invoices go each to its customer, at the card\'s address or one typed over it', async ({ page }) => {
  const mailed = await stubMail(page)
  await loginForApp(page)
  await openList(page, '/invoicing/invoices', ref, doc.a1!.number)

  // Nothing ticked, no bar. Four ticked: the bar says so and offers the mail.
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  for (const key of ['a1', 'b1', 'c1', 'draft']) await tick(page, doc[key]!.number)
  await expectSelected(page, 4)
  await expect(page.getByTestId('email-selected')).toHaveText(/send by email/i)

  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('3 documents will be sent')

  // The draft is named, with why it stays.
  const blocked = dialog.getByTestId('batch-email-blocked')
  await expect(blocked).toContainText('Will not be sent: 1')
  await expect(blocked).toContainText(`${doc.draft!.number} — draft: not sent`)

  // „To the customer / supplier" is chosen, with a line per customer and the card's address in it.
  await expect(modeOf(dialog, 'partner')).toBeChecked()
  await expect(modeOf(dialog, 'single')).not.toBeChecked()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(3)
  await expect(lineOf(dialog, 'A')).toContainText(who.A!.name)
  await expect(lineOf(dialog, 'A')).toContainText(`1 document: ${doc.a1!.number}`)
  await expect(lineOf(dialog, 'A').locator('input')).toHaveValue(address.a)
  await expect(lineOf(dialog, 'B').locator('input')).toHaveValue(address.b)
  await expect(lineOf(dialog, 'C').locator('input')).toHaveValue('')
  await expect(dialog.getByTestId('batch-email-subject').locator('input')).toHaveValue(/^Documents — \S/)

  // The customer with no address stays behind, and the button counts what goes.
  const send = dialog.getByTestId('batch-email-send')
  const note = dialog.getByTestId('batch-email-note')
  await expect(note).toHaveText(/Without an address, not sent: 1/)
  await expect(send).toHaveText(/Send 2 documents to 2 recipients/)

  // An address that is none blocks the whole batch, until it is put right.
  await lineOf(dialog, 'C').locator('input').fill('not-an-address')
  await expect(send).toBeDisabled()
  await expect(note).toHaveText(/Invalid email address/)
  await lineOf(dialog, 'C').locator('input').fill('')
  await expect(send).toBeEnabled()

  // An address can be typed over: this mail goes there, the card keeps its own.
  await lineOf(dialog, 'B').locator('input').fill(address.typedOver)
  await send.click()

  // Everything asked went: the dialog closes and says so.
  await expect(dialog).toBeHidden()
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Sent 2 documents to 2 recipients' })).toBeVisible()

  // One request per recipient, each with its own documents.
  expect(mailed.map((m) => ({ kind: m.kind, to: m.to, ids: m.items.map((i: any) => i.id) }))).toEqual([
    { kind: 'invoice', to: address.a, ids: [doc.a1!.id] },
    { kind: 'invoice', to: address.typedOver, ids: [doc.b1!.id] },
  ])
  for (const m of mailed) {
    expect(m.subject).toMatch(/^Documents — \S/)
    expect(m.locale).toBe('en')
    // An invoice goes as its Print prints it: with the person's line columns.
    expect(Array.isArray(m.columns) && m.columns.length > 0).toBe(true)
  }

  // What went left the selection; the draft and the invoice with no address are still ticked.
  await expectSelected(page, 2)
  await expect(tickOf(page, doc.a1!.number)).not.toBeChecked()
  await expect(tickOf(page, doc.b1!.number)).not.toBeChecked()
  await expect(tickOf(page, doc.c1!.number)).toBeChecked()
  await expect(tickOf(page, doc.draft!.number)).toBeChecked()
})

test('sales list: everything to one address, what did not go is named and stays ticked, the address is remembered', async ({ page }) => {
  // The provider takes the first invoice and refuses the second.
  const mailed = await stubMail(page, (body) => ({
    to: body.to, mails: 1, queued: false,
    results: body.items.map((i: any) => (i.id === doc.b1!.id
      ? { id: i.id, number: doc.b1!.number, status: 'failed', reason: 'provider_error', message: 'The provider answered 400' }
      : { id: i.id, number: numberOf(i.id), status: 'sent' })),
  }))
  await loginForApp(page)
  await openList(page, '/invoicing/invoices', ref, doc.a1!.number)
  await tick(page, doc.a1!.number)
  await tick(page, doc.b1!.number)
  await expectSelected(page, 2)

  const dialog = await openDialog(page)
  await modeOf(dialog, 'single').check()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(0)

  // Nothing to send until there is an address; no address has been used here before.
  const to = dialog.getByTestId('batch-email-single-to').locator('input')
  const send = dialog.getByTestId('batch-email-send')
  await expect(to).toHaveValue('')
  await expect(send).toBeDisabled()
  await expect(dialog.getByTestId('batch-email-note')).toHaveText(/Enter an address: there is nothing to send yet\./)

  await to.fill(address.colleague)
  await expect(send).toHaveText(/Send 2 documents to 1 recipient/)
  await dialog.getByTestId('batch-email-subject').locator('input').fill(`Invoices ${stamp}`)
  await dialog.getByTestId('batch-email-message').locator('textarea').first().fill('For the books.')
  await send.click()

  // Something did not go: the dialog stays, on what became of each recipient's documents.
  const results = dialog.getByTestId('batch-email-results')
  await expect(results).toBeVisible()
  const line = results.locator(`[data-testid="batch-email-result"][data-to="${address.colleague}"]`)
  await expect(line).toHaveAttribute('data-state', 'partial')
  await expect(line).toContainText('sent: 1 · not sent: 1')
  await expect(line).toContainText(`${doc.b1!.number} — the mail provider refused it`)
  await expect(results).toContainText('What did not go stays selected in the list.')
  await expect(dialog.getByTestId('batch-email-send')).toHaveCount(0)

  // One request carried both, with the words typed here.
  expect(mailed).toHaveLength(1)
  expect(mailed[0]).toMatchObject({
    kind: 'invoice', to: address.colleague, items: [{ id: doc.a1!.id }, { id: doc.b1!.id }], subject: `Invoices ${stamp}`, message: 'For the books.',
  })

  // Closed: only what went left the selection.
  await dialog.getByTestId('batch-email-cancel').click()
  await expect(dialog).toBeHidden()
  await expectSelected(page, 1)
  await expect(tickOf(page, doc.a1!.number)).not.toBeChecked()
  await expect(tickOf(page, doc.b1!.number)).toBeChecked()

  // Again, for what stayed: one document is named by its number, and the one address is the one a mail went to.
  const again = await openDialog(page)
  await expect(again.getByTestId('batch-email-intro')).toContainText('1 document will be sent')
  await expect(again.getByTestId('batch-email-subject').locator('input')).toHaveValue(new RegExp(String.raw`^${doc.b1!.number} — \S`))
  await modeOf(again, 'single').check()
  await expect(again.getByTestId('batch-email-single-to').locator('input')).toHaveValue(address.colleague)
  await again.getByTestId('batch-email-cancel').click()
  await expect(again).toBeHidden()
  await expectSelected(page, 1)
})

test('a server with no mail key: the first refusal stops the batch, in the server\'s words, and nothing leaves the selection', async ({ page }) => {
  // Whether this server can mail, asked with a draft: a draft is never mailed, whatever the answer.
  const probe = await apiPost(admin, '/invoicing/export/email', { kind: 'invoice', to: address.colleague, items: [{ id: doc.draft!.id }] })
  test.skip(probe.status !== 503, 'this server can mail: its refusal cannot be shown, and nothing is mailed to find out')
  expect(await probe.json()).toMatchObject({ code: 'not_configured' })

  const asked: string[] = []
  page.on('request', (request: any) => {
    if (request.method() === 'POST' && /\/invoicing\/export\/email$/.test(request.url())) asked.push(request.postDataJSON().to)
  })
  await loginForApp(page)
  await openList(page, '/invoicing/invoices', ref, doc.a1!.number)
  await tick(page, doc.a1!.number)
  await tick(page, doc.b1!.number)

  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-send')).toHaveText(/Send 2 documents to 2 recipients/)
  await dialog.getByTestId('batch-email-send').click()

  const results = dialog.getByTestId('batch-email-results')
  await expect(results).toBeVisible({ timeout: 15000 })
  const stopped = dialog.getByTestId('batch-email-stopped')
  await expect(stopped).toContainText('Stopped: the rest was not sent.')
  await expect(stopped).toContainText('Email is not configured on this server')

  // The first recipient was refused; the second was never asked.
  expect(asked).toEqual([address.a])
  const first = results.locator(`[data-testid="batch-email-result"][data-to="${address.a}"]`)
  await expect(first).toHaveAttribute('data-state', 'failed')
  await expect(first).toContainText(`${doc.a1!.number} — email is not configured on this server`)
  const second = results.locator(`[data-testid="batch-email-result"][data-to="${address.b}"]`)
  await expect(second).toHaveAttribute('data-state', 'failed')
  await expect(second).toContainText(`${doc.b1!.number} — not sent`)

  await dialog.getByTestId('batch-email-cancel').click()
  await expect(dialog).toBeHidden()
  await expectSelected(page, 2)
  await expect(tickOf(page, doc.a1!.number)).toBeChecked()
  await expect(tickOf(page, doc.b1!.number)).toBeChecked()
})

test('a role that only reads ticks and clears, and is offered no mail', async ({ page }) => {
  await loginForApp(page, 'acme-corp', memberName, PASSWORD)
  await openList(page, '/invoicing/invoices', ref, doc.a1!.number)
  await tick(page, doc.a1!.number)

  await expect(page.getByTestId('selection-bar')).toBeVisible()
  await expectSelected(page, 1)
  await expect(page.getByTestId('email-selected')).toHaveCount(0)
  await expect(page.getByTestId('batch-email-dialog')).toHaveCount(0)

  await page.getByTestId('selection-clear').click()
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  await expect(tickOf(page, doc.a1!.number)).not.toBeChecked()

  // The button is not all that stands in the way: the server refuses this role before it looks at the request.
  const member = await apiLogin('acme-corp', memberName, PASSWORD)
  const refused = await apiPost(member, '/invoicing/export/email', { kind: 'invoice', to: address.colleague, items: [{ id: doc.draft!.id }] })
  expect(refused.status).toBe(403)
})

for (const list of [
  { path: '/invoicing/proforma', key: 'proforma', partner: 'A', to: address.a },
  { path: '/invoicing/offer', key: 'offer', partner: 'B', to: address.b },
  { path: '/invoicing/bills', key: 'bill', partner: 'S', to: address.supplier },
]) {
  test(`${list.path}: the same bar and dialog, addressed to the document's customer or supplier`, async ({ page }) => {
    await loginForApp(page)
    await openList(page, list.path, ref, doc[list.key]!.number)

    // The tick column costs the list nothing at 1366 px: no sideways scroll, a row is one line (FR-22.23).
    await page.waitForLoadState('networkidle')
    const geo = await listGeometry(page)
    expect(geo.hidden, 'no sideways scroll at 1366 px').toBeLessThanOrEqual(1)
    expect(geo.tallest, 'every row is one line tall').toBeLessThan(2 * geo.lineHeight)

    await tick(page, doc[list.key]!.number)
    await expectSelected(page, 1)

    const dialog = await openDialog(page)
    await expect(modeOf(dialog, 'partner')).toBeChecked()
    await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(1)
    await expect(lineOf(dialog, list.partner)).toContainText(who[list.partner]!.name)
    await expect(lineOf(dialog, list.partner)).toContainText(doc[list.key]!.number)
    await expect(lineOf(dialog, list.partner).locator('input')).toHaveValue(list.to)
    await expect(dialog.getByTestId('batch-email-send')).toHaveText(/Send 1 document to 1 recipient/)

    // Cancelled: nothing was asked, and the tick is where it was.
    await dialog.getByTestId('batch-email-cancel').click()
    await expect(dialog).toBeHidden()
    await expectSelected(page, 1)
    await page.getByTestId('selection-clear').click()
    await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  })
}

test('supplier orders: one sheet per supplier, each to its supplier', async ({ page }) => {
  const mailed = await stubMail(page)
  await loginForApp(page)
  await openList(page, '/invoicing/orders', doc.order!.number, doc.order!.number)
  await tick(page, doc.order!.number)
  await expectSelected(page, 1)

  // One ticked order is two documents: a sheet for each of its suppliers.
  const dialog = await openDialog(page, 'order')
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('2 documents will be sent')
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(2)
  await expect(lineOf(dialog, 'S')).toContainText(`1 document: ${doc.order!.number}`)
  await expect(lineOf(dialog, 'S').locator('input')).toHaveValue(address.supplier)
  await expect(lineOf(dialog, 'T').locator('input')).toHaveValue('')
  const send = dialog.getByTestId('batch-email-send')
  await expect(send).toHaveText(/Send 1 document to 1 recipient/)

  // The supplier with no address on its card gets one here.
  await lineOf(dialog, 'T').locator('input').fill(address.secondSupplier)
  await expect(send).toHaveText(/Send 2 documents to 2 recipients/)
  await send.click()

  await expect(dialog).toBeHidden()
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Sent 2 documents to 2 recipients' })).toBeVisible()

  // Each request names the order AND the supplier's part of it; a sheet has no line columns to choose.
  expect(mailed.map((m) => ({ kind: m.kind, to: m.to, orders: m.items.map((i: any) => i.id) }))).toEqual([
    { kind: 'order', to: address.supplier, orders: [doc.order!.id] },
    { kind: 'order', to: address.secondSupplier, orders: [doc.order!.id] },
  ])
  const groups = mailed.map((m) => m.items[0].groupId)
  expect(groups.every((g: unknown) => typeof g === 'string' && g.length > 0)).toBe(true)
  expect(new Set(groups).size).toBe(2)
  for (const m of mailed) expect(m.columns).toBeUndefined()

  // Both sheets went, so the order left the selection, and the bar with it.
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  await expect(tickOf(page, doc.order!.number)).not.toBeChecked()
})
