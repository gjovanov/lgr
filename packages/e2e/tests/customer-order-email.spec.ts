import { test, expect, type Locator, type Page } from '@playwright/test'
import { signInForUx, uxApi } from './helpers/ux-budget'
import { apiLogin, apiPost } from './helpers/api'
import { listGeometry } from './helpers/list-geometry'

/**
 * The customer orders list's ticked orders by e-mail (2026-11-16), in the Bulgarian UI: the tick column, the shared
 * bar and dialog, as the person at „Входящи поръчки" meets them.
 *
 * Two clients and five orders of this spec's own. The list is opened on the clients' names (`?q=<stamp>`), so its
 * rows are this spec's and no other's: two confirmed orders and a cancelled one of a client with an address on its
 * card, a confirmed order of a client with none, and a draft.
 *
 * What it pins:
 * - ticking shows the bar; the dialog opens on „До клиента / доставчика" with a line per client, the address of the
 *   card in it and editable; a draft is named as not going, a cancelled order goes; one request leaves per client
 *   addressed; what went leaves the selection, the draft and the order with no address stay ticked;
 * - the same orders to one address;
 * - a role that only reads ticks and clears, and is offered no mail;
 * - the list fits: at 1366 px no sideways scroll and every row one line tall, a draft's four icons side by side, with
 *   the tick column and the bar; at 390 px the page itself does not scroll sideways.
 *
 * ⚠ No mail leaves this spec: the mail request is answered by `page.route` in every test. The preview is the
 * server's own. The rules (who mails which order, the refusals, the log and the audit) are held against the real
 * routes in `integration/customer-order-email.flow`, the rule per order in `unit/doc-email-guards`.
 *
 * ⚠ The confirmed orders stay in the database (only a draft can be deleted); their clients are switched off.
 *
 * Serial: the tests share the orders and the reader.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

type Api = Awaited<ReturnType<typeof uxApi>>
type Key = 'a1' | 'a2' | 'gone' | 'b1' | 'draft'

const stamp = Date.now().toString(36)
const PASSWORD = 'e2e-test-pw-12345'
const readerName = `reader-ordm-${stamp}`
const today = new Date().toISOString().slice(0, 10)

const address = {
  card: `orders-${stamp}@client.test`,
  typed: `office-${stamp}@client.test`,
  colleague: `colleague-${stamp}@example.test`,
}

let api: Api
/** The two clients: one with a long name and an address on its card, one with no address. */
const client = {
  alfa: { id: '', name: `E2E клиент с дълго наименование за поръчки по имейл ${stamp}` },
  beta: { id: '', name: `E2E клиент без адрес ${stamp}` },
}
/** The orders of this spec, by a short key. */
const doc: Record<Key, { id: string; number: string }> = {} as any
const made: { users: string[] } = { users: [] }
const numberOf = (id: string) => Object.values(doc).find(d => d.id === id)?.number ?? ''

test.beforeAll(async () => {
  api = await uxApi()

  const { product } = await api.post('/warehouse/product', {
    sku: `E2E-ORDM-${stamp}`, name: `E2E поръчка по имейл ${stamp}`, category: 'General', type: 'goods', unit: 'pcs', purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  })
  for (const [key, extra] of [['alfa', { email: address.card }], ['beta', {}]] as const) {
    const { contact } = await api.post('/invoicing/contact', { type: 'customer', companyName: client[key].name, ...extra })
    client[key].id = String(contact._id || contact.id)
    expect(client[key].id, `the client ${key} was made`).toBeTruthy()
  }

  /** A client's order of the article: a draft, then confirmed and cancelled as asked. */
  const order = async (key: Key, contactId: string, state: 'draft' | 'confirmed' | 'cancelled', extra: Record<string, unknown> = {}) => {
    let { internalOrder } = await api.post('/invoicing/internal-orders', {
      contactId, issueDate: today, requestedDeliveryDate: '2027-01-20',
      lines: [{ productId: String(product._id || product.id), description: product.name, quantity: 12, unit: 'pcs', expectedUnitPrice: 4 }],
      ...extra,
    })
    const id = String(internalOrder?._id || internalOrder?.id || '')
    expect(id, `the order ${key} was made`).toBeTruthy()
    if (state !== 'draft') internalOrder = (await api.post(`/invoicing/internal-orders/${id}/confirm`)).internalOrder
    if (state === 'cancelled') internalOrder = (await api.post(`/invoicing/internal-orders/${id}/cancel`)).internalOrder
    expect(internalOrder?.status, `the order ${key} is ${state}`).toBe(state)
    doc[key] = { id, number: internalOrder.orderNumber }
  }
  await order('a1', client.alfa.id, 'confirmed')
  await order('a2', client.alfa.id, 'confirmed')
  await order('gone', client.alfa.id, 'cancelled')
  await order('b1', client.beta.id, 'confirmed')
  // The row this list is hardest on: a draft's four icons, an urgent order asked for a day that has passed, the
  // long name.
  await order('draft', client.alfa.id, 'draft', { priority: 'urgent', requestedDeliveryDate: '2026-01-15' })
  expect(doc.draft.number).toMatch(/^DRF-/)
  expect(doc.a1.number).toMatch(/^ORDI-/)

  // A role that reads the orders and prints a sheet, and does not work on orders.
  const { user } = await api.post('/user', { email: `${readerName}@acme.com`, username: readerName, password: PASSWORD, firstName: 'E2E', lastName: 'Reader', role: 'member' })
  expect(user?._id || user?.id, 'the reader was made').toBeTruthy()
  made.users.push(String(user._id || user.id))
})

// What can be undone is: the draft deleted, the reader removed, the clients switched off (a later spec asks for "the
// newest active contact", `helpers/api.ts#activeContact`).
test.afterAll(async () => {
  if (doc.draft) await api.del(`/invoicing/internal-orders/${doc.draft.id}`).catch(() => null)
  for (const id of made.users) await api.del(`/user/${id}`).catch(() => null)
  for (const c of Object.values(client)) if (c.id) await api.del(`/invoicing/contact/${c.id}`).catch(() => null)
})

const rows = (page: Page) => page.locator('.v-data-table tbody tr')
const rowOf = (page: Page, key: Key) => rows(page).filter({ hasText: doc[key].number })
const tick = (page: Page, key: Key) => rowOf(page, key).locator('.v-selection-control').first().click()
const tickOf = (page: Page, key: Key) => rowOf(page, key).locator('.v-selection-control input')
const bar = (page: Page) => page.getByTestId('selection-bar')
const expectSelected = (page: Page, n: number) => expect(page.getByTestId('selection-count')).toHaveText(new RegExp(String.raw`^\s*${n} избрани\s*$`))
const snackbar = (page: Page, text: string) => page.locator('.v-snackbar').filter({ hasText: text })

/** The customer orders list on this spec's clients, once its five rows are in. */
async function openList(page: Page) {
  await page.goto(`/invoicing/internal-orders?q=${encodeURIComponent(stamp)}`)
  await expect(rows(page)).toHaveCount(5, { timeout: 15000 })
  await expect(rowOf(page, 'a1')).toBeVisible()
}

/** The dialog, once the server's preview is in. */
async function openDialog(page: Page): Promise<Locator> {
  await page.getByTestId('email-selected').click()
  const dialog = page.getByTestId('batch-email-dialog')
  await expect(dialog).toHaveAttribute('data-phase', 'compose', { timeout: 15000 })
  await expect(dialog).toHaveAttribute('data-kind', 'internal-order')
  return dialog
}
/** A client's line of the dialog. ⚠ A Vuetify field's test id sits on its root: the value is its `input`'s. */
const lineOf = (dialog: Locator, key: keyof typeof client) => dialog.locator(`[data-testid="batch-email-recipient"][data-partner="${client[key].id}"]`)
const modeOf = (dialog: Locator, mode: 'partner' | 'single') => dialog.getByTestId(`batch-email-mode-${mode}`).locator('input')
const singleTo = (dialog: Locator) => dialog.getByTestId('batch-email-single-to').locator('input')

/**
 * Stands in for the mail request, so that nothing is mailed: remembers each body and answers that every order asked
 * went. ⚠ The pattern ends at `email`: the preview (`…/email/preview`) reaches the server.
 */
async function stubMail(page: Page) {
  const bodies: any[] = []
  await page.route('**/invoicing/export/email', async (route) => {
    const body = route.request().postDataJSON()
    bodies.push(body)
    const went = { to: body.to, mails: 1, queued: false, results: body.items.map((i: any) => ({ id: i.id, number: numberOf(i.id), status: 'sent' })) }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(went) })
  })
  return bodies
}

test('ticked orders go to their clients: a line per client, a draft named, a cancelled order sent', async ({ page }) => {
  const mailed = await stubMail(page)
  await signInForUx(page)
  await openList(page)

  // Nothing ticked, no bar. Every row can be ticked, a draft's and a cancelled order's too.
  await expect(bar(page)).toHaveCount(0)
  for (const key of ['a1', 'a2', 'gone', 'b1', 'draft'] as const) await tick(page, key)
  await expectSelected(page, 5)
  await expect(page.getByTestId('email-selected')).toHaveText(/Изпрати по имейл/i)

  // The dialog asks the server what will go: four orders do, the draft is named with why it stays.
  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('Ще се изпратят 4 документа')
  const blocked = dialog.getByTestId('batch-email-blocked')
  await expect(blocked).toContainText('Няма да се изпратят: 1')
  await expect(blocked.locator('[data-reason="draft"]')).toHaveText(`${doc.draft.number} — чернова: не се изпраща`)
  // ⚠ The cancelled order is not there: it goes, with a sheet that says it is cancelled.
  await expect(blocked).not.toContainText(doc.gone.number)
  await expect(blocked.locator('[data-reason]')).toHaveCount(1)

  // An order has a client: „До клиента / доставчика" is chosen, a line per client, with the address of its card.
  await expect(modeOf(dialog, 'partner')).toBeChecked()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(2)
  const toAlfa = lineOf(dialog, 'alfa')
  await expect(toAlfa).toContainText(client.alfa.name)
  await expect(toAlfa).toContainText(`3 документа: ${doc.a1.number}, ${doc.a2.number}, ${doc.gone.number}`)
  await expect(toAlfa.locator('input')).toHaveValue(address.card)
  // The other client's card has no address: its line starts empty, and its order stays behind unless one is typed.
  const toBeta = lineOf(dialog, 'beta')
  await expect(toBeta).toContainText(client.beta.name)
  await expect(toBeta).toContainText(`1 документ: ${doc.b1.number}`)
  await expect(toBeta.locator('input')).toHaveValue('')
  await expect(dialog.getByTestId('batch-email-note')).toHaveText(/Без адрес, няма да се изпратят: 1/)

  // The card's address is where the line starts, not where it must go: this mail is typed another.
  await toAlfa.locator('input').fill(address.typed)
  const send = dialog.getByTestId('batch-email-send')
  await expect(send).toHaveText(/Изпрати 3 документа до 1 получател/)
  await send.click()
  await expect(dialog).toBeHidden()
  await expect(snackbar(page, 'Изпратени: 3 документа до 1 получател')).toBeVisible()

  // One request left: the client's three orders, to the address typed, in the page's language. A sheet has no
  // columns to choose, and an order no group.
  expect(mailed).toHaveLength(1)
  expect(mailed[0].kind).toBe('internal-order')
  expect(mailed[0].to).toBe(address.typed)
  expect(mailed[0].items).toEqual([doc.a1, doc.a2, doc.gone].map(d => ({ id: d.id })))
  expect(mailed[0].locale).toBe('bg')
  expect(mailed[0].columns).toBeUndefined()
  expect(mailed[0].subject).toMatch(/^Документи — \S/)

  // What went left the selection; the draft and the order with no address are still ticked.
  await expectSelected(page, 2)
  for (const key of ['a1', 'a2', 'gone'] as const) await expect(tickOf(page, key)).not.toBeChecked()
  await expect(tickOf(page, 'b1')).toBeChecked()
  await expect(tickOf(page, 'draft')).toBeChecked()

  // „Изчисти" unticks the rest.
  await page.getByTestId('selection-clear').click()
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 'draft')).not.toBeChecked()
})

test('the same orders to one address: a colleague', async ({ page }) => {
  const mailed = await stubMail(page)
  await signInForUx(page)
  await openList(page)
  await tick(page, 'a1')
  await tick(page, 'b1')
  await expectSelected(page, 2)

  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-blocked')).toHaveCount(0)
  await modeOf(dialog, 'single').check()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(0)
  // No address yet, nothing to send. The colleague's address takes both orders, whoever their client is.
  const send = dialog.getByTestId('batch-email-send')
  await expect(send).toBeDisabled()
  await singleTo(dialog).fill(address.colleague)
  await expect(send).toHaveText(/Изпрати 2 документа до 1 получател/)
  await send.click()
  await expect(dialog).toBeHidden()
  await expect(snackbar(page, 'Изпратени: 2 документа до 1 получател')).toBeVisible()

  expect(mailed.map(m => ({ kind: m.kind, to: m.to, ids: m.items.map((i: any) => i.id) }))).toEqual([
    { kind: 'internal-order', to: address.colleague, ids: [doc.a1.id, doc.b1.id] },
  ])
  // Both went: nothing is ticked, the bar is gone.
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 'a1')).not.toBeChecked()
  await expect(tickOf(page, 'b1')).not.toBeChecked()
})

test('a role that only reads ticks and clears, and is offered no mail', async ({ page }) => {
  await signInForUx(page, 'acme-corp', readerName, PASSWORD)
  await openList(page)
  await tick(page, 'a1')

  await expect(bar(page)).toBeVisible()
  await expectSelected(page, 1)
  await expect(page.getByTestId('email-selected')).toHaveCount(0)
  await expect(page.getByTestId('batch-email-dialog')).toHaveCount(0)
  // It still prints the sheet: the row's Print is there.
  await expect(rowOf(page, 'a1').getByTestId('print-order-row')).toBeVisible()

  await page.getByTestId('selection-clear').click()
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 'a1')).not.toBeChecked()

  // The button is not all that stands in the way: the server refuses this role on both routes, before it looks at
  // what was asked.
  const reader = await apiLogin('acme-corp', readerName, PASSWORD)
  expect((await apiPost(reader, '/invoicing/export/email/preview', { kind: 'internal-order', ids: [doc.a1.id] })).status).toBe(403)
  expect((await apiPost(reader, '/invoicing/export/email', { kind: 'internal-order', to: address.colleague, items: [{ id: doc.a1.id }] })).status).toBe(403)
})

test('the list fits: one line per row at 1366 px, a draft\'s too, and at 390 px the page does not scroll sideways', async ({ page }) => {
  await signInForUx(page)
  await openList(page)
  await page.waitForLoadState('networkidle')
  /** How far the PAGE scrolls sideways: 0 when it does not. The table scrolls in its own box, which is not this. */
  const pageHidden = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

  // 1366 px, with the tick column, and then with the bar over the table too.
  for (const ticked of [false, true]) {
    if (ticked) {
      await tick(page, 'draft')
      await tick(page, 'a1')
      await expect(bar(page)).toBeVisible()
    }
    const geo = await listGeometry(page)
    expect(geo.rows, 'rows to measure').toBe(5)
    expect(geo.hidden, `no sideways scroll at 1366 px${ticked ? ', rows ticked' : ''}`).toBeLessThanOrEqual(1)
    expect(geo.tallest, `every row is one line tall${ticked ? ', rows ticked' : ''}`).toBeLessThan(2 * geo.lineHeight)
    expect(await pageHidden(), 'the page does not scroll sideways at 1366 px').toBeLessThanOrEqual(0)
  }

  // The draft's row is the one that did not fit: its four icons stand side by side, and it is as tall as any other.
  const draftRow = rowOf(page, 'draft')
  const icons = draftRow.locator('td').last().locator('button, a')
  await expect(icons).toHaveCount(4)
  const tops = await icons.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size, `the draft's four icons are on one line (tops ${tops.join(', ')})`).toBe(1)
  const heights = await rows(page).evaluateAll(trs => trs.map(tr => (tr as HTMLElement).offsetHeight))
  expect(new Set(heights).size, `every row is the same height (${heights.join(', ')})`).toBe(1)
  // The row's Print is still there, for every order.
  await expect(rows(page).getByTestId('print-order-row')).toHaveCount(5)
  // The long name is cut short in its cell, and whole in the cell's title.
  const name = draftRow.locator('.cell-clip')
  await expect(name).toHaveAttribute('title', client.alfa.name)
  expect(await name.evaluate(el => el.scrollWidth > el.clientWidth), 'the long name is clipped').toBe(true)

  // 390 px: the page does not scroll sideways, with the bar over the table too.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(bar(page)).toBeVisible()
  await expect.poll(pageHidden, { message: 'the page does not scroll sideways at 390 px' }).toBeLessThanOrEqual(0)
  // A row is still one line: the table scrolls sideways inside its own box.
  const phone = await listGeometry(page)
  expect(phone.tallest, 'every row is one line tall at 390 px').toBeLessThan(2 * phone.lineHeight)
  expect(phone.hidden, 'the table scrolls in its own box').toBeGreaterThan(0)

  // Loaded at that width, the same: nothing depends on having been wider first.
  await openList(page)
  await page.waitForLoadState('networkidle')
  expect(await pageHidden(), 'the page does not scroll sideways at 390 px, loaded there').toBeLessThanOrEqual(0)
})
