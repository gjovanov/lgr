import { test, expect, type Locator, type Page } from '@playwright/test'
import { signInForUx, uxApi } from './helpers/ux-budget'
import { apiLogin, apiPost } from './helpers/api'
import { listGeometry } from './helpers/list-geometry'

/**
 * The movements list's ticked movements by e-mail (2026-11-16), in the Bulgarian UI: the tick column, the shared bar
 * and dialog, as the person at the list meets them. The owner's use is the first test: transfers to another site's
 * warehouse, sent to the colleagues there.
 *
 * An article, an external warehouse, a supplier and movements of this spec's own. The list is opened on that article
 * (`?pq=<its code>`), so its rows are this spec's and no other's: a receipt from the supplier, two booked transfers
 * to the external warehouse, and a transfer left a draft.
 *
 * What it pins:
 * - ticking shows the bar; transfers name no contact, so the dialog opens on „До един адрес"; one request leaves with
 *   both movements; what went leaves the selection, and the address is remembered for the next time;
 * - a tick is the movement, not the row: it holds while the list is sorted and filtered;
 * - a receipt goes to its supplier, at the card's address; a draft is named as not going; the draft and the movement
 *   with no address stay ticked;
 * - a Seller (transfers only, FR-26.7) is offered the mail, and is told which of the ticked movements its role does
 *   not send; a role that only reads ticks and clears, and is offered no mail;
 * - the list still fits: at 1366 px no sideways scroll and a row one line tall, with the tick column and the bar;
 *   at 390 px the page itself does not scroll sideways (its title row wraps, the table scrolls in its own box).
 *
 * ⚠ No mail leaves this spec: the mail request is answered by `page.route` in every test. The preview is the
 * server's own. The rules (who mails which movement, the refusals, the log and the audit) are held against the real
 * routes in `integration/movement-email.flow`, the rule per movement in `unit/movement-email-guards`.
 *
 * ⚠ The article, the external warehouse (switched off at the end) and the booked movements stay in the database:
 * a booked movement is never removed.
 *
 * Serial: the tests share the movements and the two users.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

type Api = Awaited<ReturnType<typeof uxApi>>

const stamp = Date.now().toString(36)
const sku = `E2E-MVM-${stamp}`
const PASSWORD = 'e2e-test-pw-12345'
const readerName = `reader-mvm-${stamp}`
const sellerName = `seller-mvm-${stamp}`
const today = new Date().toISOString().slice(0, 10)

const address = {
  supplier: `orders-${stamp}@supplier.test`,
  colleague: `colleague-${stamp}@othersite.test`,
}

let api: Api
const supplier = { id: '', name: `E2E доставчик с дълго наименование за поща ${stamp}` }
/** The movements of this spec, by a short key. */
const doc: Record<'receipt' | 't1' | 't2' | 'draft', { id: string; number: string }> = {} as any
const made: { users: string[]; warehouse?: string } = { users: [] }
const numberOf = (id: string) => Object.values(doc).find(d => d.id === id)?.number ?? ''

test.beforeAll(async () => {
  api = await uxApi()

  const warehouses = (await api.get('/warehouse/warehouse?size=100')).warehouses
  const own = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  // Named to sort after every other warehouse, as `external-warehouse.spec` explains.
  const { warehouse: external } = await api.post('/warehouse/warehouse', { code: `MVM-${stamp}`, name: `я обект поща ${stamp}`, type: 'warehouse', isExternal: true })
  expect(external?.isExternal, 'the API made an external warehouse').toBe(true)
  made.warehouse = String(external._id || external.id)

  const { product } = await api.post('/warehouse/product', {
    sku, name: `E2E поща ${stamp}`, category: 'General', type: 'goods', unit: 'pcs', purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  })
  const { contact } = await api.post('/invoicing/contact', { type: 'supplier', companyName: supplier.name, email: address.supplier })
  supplier.id = String(contact._id || contact.id)

  /** A movement of the article, booked unless it is left a draft. */
  const movement = async (key: keyof typeof doc, body: Record<string, unknown>, quantity: number, book = true) => {
    const { stockMovement } = await api.post('/warehouse/movement', {
      date: today, ...body,
      lines: [{ productId: product._id, quantity, unitCost: 2.5, totalCost: quantity * 2.5 }], totalAmount: quantity * 2.5,
    })
    const id = String(stockMovement._id || stockMovement.id)
    if (book) expect((await api.post(`/warehouse/movement/${id}/confirm`)).stockMovement?.status, `${key} is booked`).toBe('completed')
    doc[key] = { id, number: stockMovement.movementNumber }
  }
  await movement('receipt', { type: 'receipt', toWarehouseId: own._id, contactId: supplier.id }, 20)
  const toTheOtherSite = { type: 'transfer', fromWarehouseId: own._id, toWarehouseId: made.warehouse }
  await movement('t1', toTheOtherSite, 2)
  await movement('t2', toTheOtherSite, 3)
  await movement('draft', toTheOtherSite, 1, false)

  // A role that only reads the movements, and a Seller, who writes transfers and nothing else.
  for (const [username, role] of [[readerName, 'member'], [sellerName, 'seller']] as const) {
    const { user } = await api.post('/user', { email: `${username}@acme.com`, username, password: PASSWORD, firstName: 'E2E', lastName: role, roleKey: role })
    expect(user?._id || user?.id, `the ${role} was made`).toBeTruthy()
    made.users.push(String(user._id || user.id))
  }
})

// What can be undone is: the draft deleted, the users removed, the supplier and the external warehouse switched off
// (a later spec asks for "the newest active contact", `helpers/api.ts#activeContact`).
test.afterAll(async () => {
  if (doc.draft) await api.del(`/warehouse/movement/${doc.draft.id}`).catch(() => null)
  for (const id of made.users) await api.del(`/user/${id}`).catch(() => null)
  if (supplier.id) await api.del(`/invoicing/contact/${supplier.id}`).catch(() => null)
  if (made.warehouse) await api.del(`/warehouse/warehouse/${made.warehouse}`).catch(() => null)
})

const rows = (page: Page) => page.locator('.v-data-table tbody tr')
const rowOf = (page: Page, key: keyof typeof doc) => rows(page).filter({ hasText: doc[key].number })
const tick = (page: Page, key: keyof typeof doc) => rowOf(page, key).locator('.v-selection-control').first().click()
const tickOf = (page: Page, key: keyof typeof doc) => rowOf(page, key).locator('.v-selection-control input')
const bar = (page: Page) => page.getByTestId('selection-bar')
const expectSelected = (page: Page, n: number) => expect(page.getByTestId('selection-count')).toHaveText(new RegExp(String.raw`^\s*${n} избрани\s*$`))
const snackbar = (page: Page, text: string) => page.locator('.v-snackbar').filter({ hasText: text })

/** The movements list on this spec's article, once its four rows are in. */
async function openList(page: Page) {
  await page.goto(`/inventory/movements?pq=${encodeURIComponent(sku)}`)
  await expect(rows(page)).toHaveCount(4, { timeout: 15000 })
  await expect(rowOf(page, 'receipt')).toBeVisible()
}

/** The dialog, once the server's preview is in. */
async function openDialog(page: Page): Promise<Locator> {
  await page.getByTestId('email-selected').click()
  const dialog = page.getByTestId('batch-email-dialog')
  await expect(dialog).toHaveAttribute('data-phase', 'compose', { timeout: 15000 })
  await expect(dialog).toHaveAttribute('data-kind', 'movement')
  return dialog
}
/** ⚠ A Vuetify field's test id sits on its root: the value is its `input`'s. */
const modeOf = (dialog: Locator, mode: 'partner' | 'single') => dialog.getByTestId(`batch-email-mode-${mode}`).locator('input')
const singleTo = (dialog: Locator) => dialog.getByTestId('batch-email-single-to').locator('input')

/**
 * Stands in for the mail request, so that nothing is mailed: remembers each body and answers that every movement
 * asked went. ⚠ The pattern ends at `email`: the preview (`…/email/preview`) reaches the server.
 */
async function stubMail(page: Page) {
  const bodies: any[] = []
  await page.route('**/warehouse/movement/email', async (route) => {
    const body = route.request().postDataJSON()
    bodies.push(body)
    const went = { to: body.to, mails: 1, queued: false, results: body.items.map((i: any) => ({ id: i.id, number: numberOf(i.id), status: 'sent' })) }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(went) })
  })
  return bodies
}

test('transfers to another site go to one address: the colleagues there', async ({ page }) => {
  const mailed = await stubMail(page)
  await signInForUx(page)
  await openList(page)

  // Nothing ticked, no bar. Two transfers ticked: the bar counts them and offers the mail.
  await expect(bar(page)).toHaveCount(0)
  await tick(page, 't1')
  await tick(page, 't2')
  await expectSelected(page, 2)
  await expect(page.getByTestId('email-selected')).toHaveText(/Изпрати по имейл/i)

  // A tick is the movement, not the row: sorted, and filtered away and back, both are still ticked.
  await page.locator('.v-data-table thead th').filter({ hasText: 'Дата' }).click()
  await expect(page).toHaveURL(/sortBy=date/)
  await expect(tickOf(page, 't1')).toBeChecked()
  await expect(tickOf(page, 't2')).toBeChecked()
  // ⚠ By role: the field's clear icon carries the same label.
  const articles = page.getByRole('textbox', { name: 'Търсене на продукти' })
  await articles.fill(`${sku}-никой`)
  await expect(rows(page).filter({ hasText: doc.t1.number })).toHaveCount(0)
  await expectSelected(page, 2)
  await articles.fill(sku)
  await expect(rowOf(page, 't1')).toBeVisible()
  await expect(tickOf(page, 't1')).toBeChecked()
  await expect(tickOf(page, 't2')).toBeChecked()
  await expect(tickOf(page, 'receipt')).not.toBeChecked()

  // A transfer names no customer or supplier: the dialog opens on „До един адрес", with nobody else to choose.
  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('Ще се изпратят 2 документа')
  await expect(dialog.getByTestId('batch-email-blocked')).toHaveCount(0)
  await expect(modeOf(dialog, 'single')).toBeChecked()
  await expect(modeOf(dialog, 'partner')).toBeDisabled()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(0)
  await expect(dialog.getByTestId('batch-email-subject').locator('input')).toHaveValue(/^Документи — \S/)

  // No address yet, nothing to send. An address that is none blocks. The colleague's address goes.
  const send = dialog.getByTestId('batch-email-send')
  await expect(singleTo(dialog)).toHaveValue('')
  await expect(send).toBeDisabled()
  await singleTo(dialog).fill('не-е-адрес')
  await expect(send).toBeDisabled()
  await expect(dialog.getByTestId('batch-email-note')).toHaveText(/Невалиден имейл адрес/)
  await singleTo(dialog).fill(address.colleague)
  await expect(send).toHaveText(/Изпрати 2 документа до 1 получател/)
  await send.click()

  // Both went: the dialog closes and says so.
  await expect(dialog).toBeHidden()
  await expect(snackbar(page, 'Изпратени: 2 документа до 1 получател')).toBeVisible()

  // One request, with both movements, in the page's language. A movement's sheet has no columns to choose.
  expect(mailed).toHaveLength(1)
  expect(mailed[0].kind).toBe('movement')
  expect(mailed[0].to).toBe(address.colleague)
  expect(mailed[0].items.map((i: any) => i.id).sort()).toEqual([doc.t1.id, doc.t2.id].sort())
  expect(mailed[0].subject).toMatch(/^Документи — \S/)
  expect(mailed[0].locale).toBe('bg')
  expect(mailed[0].columns).toBeUndefined()

  // What went left the selection: nothing is ticked, the bar is gone.
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 't1')).not.toBeChecked()
  await expect(tickOf(page, 't2')).not.toBeChecked()

  // The address is remembered for the next movements, for this person and organization.
  await tick(page, 't1')
  const again = await openDialog(page)
  await expect(singleTo(again)).toHaveValue(address.colleague)
  await again.getByTestId('batch-email-cancel').click()
  await expect(again).toBeHidden()
  // Closing the dialog sends nothing and unticks nothing.
  expect(mailed).toHaveLength(1)
  await expectSelected(page, 1)
})

test('a receipt goes to its supplier; a draft is named and, with the movement that has no address, stays ticked', async ({ page }) => {
  const mailed = await stubMail(page)
  await signInForUx(page)
  await openList(page)
  for (const key of ['receipt', 't1', 'draft'] as const) await tick(page, key)
  await expectSelected(page, 3)

  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('Ще се изпратят 2 документа')

  // The draft is named, with why it stays.
  const blocked = dialog.getByTestId('batch-email-blocked')
  await expect(blocked).toContainText('Няма да се изпратят: 1')
  await expect(blocked.locator('[data-reason="draft"]')).toHaveText(`${doc.draft.number} — чернова: не се изпраща`)

  // The receipt has a supplier: „До клиента / доставчика" is chosen, with the address of the supplier's card.
  await expect(modeOf(dialog, 'partner')).toBeChecked()
  await expect(dialog.getByTestId('batch-email-recipient')).toHaveCount(2)
  const toSupplier = dialog.locator(`[data-testid="batch-email-recipient"][data-partner="${supplier.id}"]`)
  await expect(toSupplier).toContainText(supplier.name)
  await expect(toSupplier).toContainText(`1 документ: ${doc.receipt.number}`)
  await expect(toSupplier.locator('input')).toHaveValue(address.supplier)
  // The transfer has nobody: a line of its own, with no address, which stays behind unless one is typed.
  const toNobody = dialog.locator('[data-testid="batch-email-recipient"][data-partner="none"]')
  await expect(toNobody).toContainText('Документи без клиент или доставчик')
  await expect(toNobody).toContainText(`1 документ: ${doc.t1.number}`)
  await expect(toNobody.locator('input')).toHaveValue('')
  await expect(dialog.getByTestId('batch-email-note')).toHaveText(/Без адрес, няма да се изпратят: 1/)

  const send = dialog.getByTestId('batch-email-send')
  await expect(send).toHaveText(/Изпрати 1 документ до 1 получател/)
  await send.click()
  await expect(dialog).toBeHidden()
  await expect(snackbar(page, 'Изпратени: 1 документ до 1 получател')).toBeVisible()

  // The supplier is mailed its receipt, and nothing else left.
  expect(mailed.map(m => ({ kind: m.kind, to: m.to, ids: m.items.map((i: any) => i.id) }))).toEqual([
    { kind: 'movement', to: address.supplier, ids: [doc.receipt.id] },
  ])

  // The receipt left the selection; the draft and the transfer with no address are still ticked.
  await expectSelected(page, 2)
  await expect(tickOf(page, 'receipt')).not.toBeChecked()
  await expect(tickOf(page, 't1')).toBeChecked()
  await expect(tickOf(page, 'draft')).toBeChecked()

  // „Изчисти" unticks the rest.
  await page.getByTestId('selection-clear').click()
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 'draft')).not.toBeChecked()
})

test('a Seller is offered the mail, and told which movement its role does not send', async ({ page }) => {
  const mailed = await stubMail(page)
  await signInForUx(page, 'acme-corp', sellerName, PASSWORD)
  await openList(page)
  await tick(page, 'receipt')
  await tick(page, 't2')
  await expectSelected(page, 2)

  // The transfer goes, to one address; the receipt is not a Seller's to send, and the dialog says so before it asks.
  const dialog = await openDialog(page)
  await expect(dialog.getByTestId('batch-email-intro')).toContainText('Ще се изпрати 1 документ')
  await expect(dialog.getByTestId('batch-email-blocked').locator('[data-reason="forbidden"]'))
    .toHaveText(`${doc.receipt.number} — ролята ви не изпраща такива документи`)
  await expect(modeOf(dialog, 'single')).toBeChecked()
  await singleTo(dialog).fill(address.colleague)
  await dialog.getByTestId('batch-email-send').click()
  await expect(dialog).toBeHidden()

  expect(mailed.map(m => ({ to: m.to, ids: m.items.map((i: any) => i.id) }))).toEqual([{ to: address.colleague, ids: [doc.t2.id] }])
  // The transfer left the selection, the receipt is still ticked.
  await expectSelected(page, 1)
  await expect(tickOf(page, 'receipt')).toBeChecked()
  await expect(tickOf(page, 't2')).not.toBeChecked()

  // The dialog only repeats the server: asked for the receipt outright, it answers the same, per movement.
  const seller = await apiLogin('acme-corp', sellerName, PASSWORD)
  const preview = await apiPost(seller, '/warehouse/movement/email/preview', { kind: 'movement', ids: [doc.receipt.id, doc.t2.id] })
  expect(preview.status).toBe(200)
  expect(((await preview.json()).documents as any[]).map(d => [d.number, d.blocked ?? null])).toEqual([
    [doc.receipt.number, 'forbidden'],
    [doc.t2.number, null],
  ])
})

test('a role that only reads ticks and clears, and is offered no mail', async ({ page }) => {
  await signInForUx(page, 'acme-corp', readerName, PASSWORD)
  await openList(page)
  await tick(page, 't1')

  await expect(bar(page)).toBeVisible()
  await expectSelected(page, 1)
  await expect(page.getByTestId('email-selected')).toHaveCount(0)
  await expect(page.getByTestId('batch-email-dialog')).toHaveCount(0)

  await page.getByTestId('selection-clear').click()
  await expect(bar(page)).toHaveCount(0)
  await expect(tickOf(page, 't1')).not.toBeChecked()

  // The button is not all that stands in the way: the server refuses this role on both routes, before it looks at
  // what was asked.
  const reader = await apiLogin('acme-corp', readerName, PASSWORD)
  expect((await apiPost(reader, '/warehouse/movement/email/preview', { kind: 'movement', ids: [doc.t1.id] })).status).toBe(403)
  expect((await apiPost(reader, '/warehouse/movement/email', { kind: 'movement', to: address.colleague, items: [{ id: doc.t1.id }] })).status).toBe(403)
})

test('the list still fits: one line per row and no sideways scroll at 1366 px, and at 390 px the page does not scroll sideways', async ({ page }) => {
  await signInForUx(page)
  await openList(page)
  await page.waitForLoadState('networkidle')
  /** How far the PAGE scrolls sideways: 0 when it does not. The table scrolls in its own box, which is not this. */
  const pageHidden = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const header = page.getByTestId('movements-header')
  const title = header.locator('h1')
  const create = header.getByTestId('create-button')

  // 1366 px, the rows this list is hardest on: a draft with its four icons, an external warehouse with its mark, a
  // supplier with a long name. With the tick column, and with the bar over the table.
  for (const ticked of [false, true]) {
    if (ticked) {
      await tick(page, 'draft')
      await tick(page, 'receipt')
      await expect(bar(page)).toBeVisible()
    }
    const geo = await listGeometry(page)
    expect(geo.rows, 'rows to measure').toBe(4)
    expect(geo.hidden, `no sideways scroll at 1366 px${ticked ? ', rows ticked' : ''}`).toBeLessThanOrEqual(1)
    expect(geo.tallest, `every row is one line tall${ticked ? ', rows ticked' : ''}`).toBeLessThan(2 * geo.lineHeight)
    expect(await pageHidden(), 'the page does not scroll sideways at 1366 px').toBeLessThanOrEqual(0)
  }
  // The long name is cut short in its cell, and whole in the cell's title.
  const name = rowOf(page, 'receipt').locator('.movement-contact')
  await expect(name).toHaveAttribute('title', supplier.name)
  expect(await name.evaluate(el => el.scrollWidth > el.clientWidth), 'the long name is clipped').toBe(true)
  // On a laptop the title and its buttons are one row.
  const [t, c] = [await title.boundingBox(), await create.boundingBox()]
  expect(c!.y, 'the buttons sit beside the title').toBeLessThan(t!.y + t!.height)

  // 390 px: the title row wraps instead of pushing the page wide, with the bar over the table too.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(bar(page)).toBeVisible()
  await expect.poll(pageHidden, { message: 'the page does not scroll sideways at 390 px' }).toBeLessThanOrEqual(0)
  const [t2, c2] = [await title.boundingBox(), await create.boundingBox()]
  expect(c2!.y, 'the buttons are under the title').toBeGreaterThanOrEqual(t2!.y + t2!.height - 1)
  // A row is still one line: the table scrolls sideways inside its own box.
  const phone = await listGeometry(page)
  expect(phone.tallest, 'every row is one line tall at 390 px').toBeLessThan(2 * phone.lineHeight)
  expect(phone.hidden, 'the table scrolls in its own box').toBeGreaterThan(0)

  // Loaded at that width, the same: nothing depends on having been wider first.
  await openList(page)
  await page.waitForLoadState('networkidle')
  expect(await pageHidden(), 'the page does not scroll sideways at 390 px, loaded there').toBeLessThanOrEqual(0)
})
