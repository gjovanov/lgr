import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { activeContact, apiLogin, apiPost } from './helpers/api'
import { lineQuantity } from './helpers/document-form'
import { expectOneLine, expectSteadyUnder, expectUnmoved, leaveField, linkArticle, rowLines, showEveryLineColumn } from './helpers/line-baseline'

/**
 * Owner, 2026-11-15: the fields of a line-items row are underlined, and those underlines are ONE
 * line, on every invoicing document, in every state of the row.
 *
 * Two things broke it, and both are held here by where the underlines are drawn, not by a class:
 *
 * - the chip of the linked article hangs under the description, and the cells were centred, so
 *   that field sat 12 px above the row's other fields;
 * - Unit, Unit price and Tax rate draw their value through a `#selection` slot, and on focus
 *   Vuetify wrapped their search input to a second line: the field grew from 32 to 60 px, its
 *   underline dropped 28 px, the row grew 4 px and every other field of it moved 2 px.
 *
 * So every step below looks at the row twice: all underlines within 1 px of each other, and none
 * of them (nor the row's height) moved from where the row had them before the step.
 * The rule itself is `ui-shared/src/styles/line-grid.css`.
 */

// Tall: the article search's results are `position: fixed` under the field (see
// invoicing-product-autocomplete.spec.ts), and a row low on a short screen puts them under the fold.
test.use({ viewport: { width: 1366, height: 1200 } })

async function article() {
  const sku = `E2E-LINE-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const name = `Baseline article ${sku}`
  const res = await apiPost(await apiLogin(), '/warehouse/product', {
    sku, name, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 10, purchasePrice: 4, taxRate: 20,
  })
  expect(res.ok, `setup article: ${res.status}`).toBe(true)
  const { product } = await res.json()
  return { sku, name, id: String(product.id || product._id) }
}

const DOCUMENTS = [
  // What a line's own columns hold with every one of them switched on: description, quantity, unit,
  // price, (discount,) tax rate, warehouse.
  { name: 'a sales invoice', path: '/invoicing/invoices/new', docType: 'invoice', price: 'price-combobox', ownFields: 7, productUpdate: false },
  { name: 'a bill with product update on', path: '/invoicing/bills/new', docType: 'purchase_invoice', price: 'price-plain', ownFields: 6, productUpdate: true },
]

test.describe('Line items: the underlines of a row are one line', () => {
  for (const doc of DOCUMENTS) {
    test(`${doc.name}: empty, with its article, and under focus`, async ({ page }) => {
      const item = await article()
      await showEveryLineColumn(page, [doc.docType])
      await loginForApp(page)
      await page.goto(doc.path)
      const row = page.locator('.line-table tbody tr').first()

      const empty = await rowLines(row)
      expectOneLine(empty, 'an empty line')
      const names = empty.fields.map((f) => f.name)
      for (const name of ['product-field', 'line-unit', doc.price, 'tax-rate-combobox']) {
        expect(names, `the row has its ${name}`).toContain(name)
      }
      if (doc.productUpdate) {
        // The columns that update the article are fields of the same row: they line up with it.
        await expect(page.getByTestId('bill-product-update')).toBeVisible()
        expect(names.length, 'the product-update columns are in the row').toBeGreaterThan(doc.ownFields)
      } else {
        expect(names).toHaveLength(doc.ownFields)
      }

      // The unit is the line's own until the line has an article.
      const unit = row.getByTestId('line-unit')
      await expectSteadyUnder(row, empty, 'an empty line, its unit focused', () => unit.locator('input').first().focus(), 'line-unit')
      await leaveField(page)

      await linkArticle(page, row, item.sku)
      const linked = await rowLines(row)
      expectOneLine(linked, 'a line with its article')
      expect(linked.height, 'the chip hangs under its field: the row is taller for it, nothing else').toBeGreaterThan(empty.height)

      await expectSteadyUnder(row, linked, 'the quantity focused', () => lineQuantity(row).focus())
      await leaveField(page)

      const price = row.getByTestId(doc.price)
      await expectSteadyUnder(row, linked, 'the unit price focused', () => price.locator('input').first().focus(), doc.price)
      await expectSteadyUnder(row, linked, 'the unit price, a figure typed', () => page.keyboard.type('7'), doc.price)
      await leaveField(page)
      if (doc.price === 'price-combobox') {
        await expectSteadyUnder(row, linked, 'the unit price clicked, its menu open', async () => {
          await price.locator('.v-field__input').click()
          await expect(page.getByRole('option').first()).toBeVisible()
        }, doc.price)
        await leaveField(page)
      }

      const tax = row.getByTestId('tax-rate-combobox')
      await expectSteadyUnder(row, linked, 'the tax rate focused', () => tax.locator('input').first().focus(), 'tax-rate-combobox')
      await expectSteadyUnder(row, linked, 'the tax rate, a figure typed', () => page.keyboard.type('9'), 'tax-rate-combobox')
      await leaveField(page)
      await expectSteadyUnder(row, linked, 'the tax rate clicked, its menu open', async () => {
        await tax.locator('.v-field__input').click()
        await expect(page.getByRole('option').first()).toBeVisible()
      }, 'tax-rate-combobox')
      await leaveField(page)

      await expectSteadyUnder(row, linked, 'the unit focused', () => unit.locator('input').first().focus(), 'line-unit')
      await leaveField(page)

      expectUnmoved(linked, await rowLines(row), 'the line left alone again')
    })
  }

  const ORDERS = [
    { name: 'a supplier order', path: '/invoicing/orders/new', addsRows: true },
    { name: 'a customer order', path: '/invoicing/internal-orders/new', addsRows: false },
  ]

  for (const order of ORDERS) {
    test(`${order.name}: the tree's line row${order.addsRows ? ', and the row being added with its messages' : ''}`, async ({ page }) => {
      const item = await article()
      await loginForApp(page)
      await page.goto(order.path)
      const line = page.locator('[data-testid="tree-row"][data-kind="line"]').first()
      const unit = line.locator('td[data-col="unit"] input').first()

      const empty = await rowLines(line)
      expectOneLine(empty, 'an empty line')
      expect(empty.fields.map((f) => f.name), 'article, quantity, unit and price').toHaveLength(4)
      await expectSteadyUnder(line, empty, 'an empty line, its unit focused', () => unit.focus(), 'unit')
      await leaveField(page)

      await linkArticle(page, line, item.sku)
      const linked = await rowLines(line)
      expectOneLine(linked, 'a line with its article')
      expect(linked.height, 'the chip hangs under its field: the row is taller for it, nothing else').toBeGreaterThan(empty.height)

      await expectSteadyUnder(line, linked, 'the quantity focused', () => line.locator('td[data-col="qty"] input').first().focus(), 'qty')
      await leaveField(page)
      await expectSteadyUnder(line, linked, 'the price focused', () => line.locator('td[data-col="price"] input').first().focus())
      await leaveField(page)
      await expectSteadyUnder(line, linked, 'the unit focused', () => unit.focus(), 'unit')
      await expectSteadyUnder(line, linked, 'the unit, a letter typed', () => page.keyboard.type('k'), 'unit')
      await leaveField(page)
      expectUnmoved(linked, await rowLines(line), 'the line left alone again')

      if (!order.addsRows) return
      // The row being added is the one row whose fields carry messages: what hangs under one
      // field (a short message, a long one that wraps) leaves the other field where it was.
      await line.getByTestId('tree-addWarehouse').click()
      const adding = page.locator('tr:has([data-tree-editor])')
      const clean = await rowLines(adding)
      expectOneLine(clean, 'the row being added')
      await page.locator('[data-tree-editor-qty] input').fill('0')
      await page.getByTestId('tree-add').click()
      await expect(adding.locator('.v-messages__message')).toHaveCount(2)
      const refused = await rowLines(adding)
      expectOneLine(refused, 'the row being added, refused with a message under each field')
      expect(refused.height, 'the messages make the row taller').toBeGreaterThan(clean.height)
    })
  }

  test('a saved invoice, reopened: the same line under the same focus', async ({ page }) => {
    const item = await article()
    const session = await apiLogin()
    const contact = await activeContact(session, 'customer')
    expect(contact, 'a seeded, active customer').toBeTruthy()
    const res = await apiPost(session, '/invoices', {
      type: 'invoice',
      direction: 'outgoing',
      contactId: contact._id,
      issueDate: new Date().toISOString().split('T')[0],
      currency: 'EUR',
      exchangeRate: 1,
      paymentMethod: 'bank_transfer',
      lines: [{ productId: item.id, description: item.name, quantity: 2, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 24 }],
      subtotal: 20,
      discountTotal: 0,
      taxTotal: 4,
      total: 24,
    })
    expect(res.status, `setup invoice: ${res.status}`).toBeLessThan(300)
    const { invoice } = await res.json()

    await showEveryLineColumn(page, ['invoice'])
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${invoice.id || invoice._id}/edit`)
    const row = page.locator('.line-table tbody tr').first()
    await expect(row.getByTestId('product-field').locator('.v-chip')).toBeVisible({ timeout: 15000 })
    await page.waitForLoadState('networkidle')

    const saved = await rowLines(row)
    expectOneLine(saved, 'a saved line with its article')
    await expectSteadyUnder(row, saved, 'the unit price focused', () => row.getByTestId('price-combobox').locator('input').first().focus(), 'price-combobox')
    await leaveField(page)
    await expectSteadyUnder(row, saved, 'the tax rate focused', () => row.getByTestId('tax-rate-combobox').locator('input').first().focus(), 'tax-rate-combobox')
    await leaveField(page)
    // On an outgoing document the unit is the article's (read-only), and still takes the focus.
    await expectSteadyUnder(row, saved, 'the unit focused', () => row.getByTestId('line-unit').locator('input').first().focus(), 'line-unit')
    await leaveField(page)
    expectUnmoved(saved, await rowLines(row), 'the line left alone again')
  })

  // The headings follow the column picker (what is on, and the order they were dragged into). A line's
  // cells kept an order of their own: subtotal BEFORE tax rate and warehouse, where the catalog has it
  // after them. With one of those two columns on, "Tax Rate" stood over the subtotals.
  const ORDERS_OF_COLUMNS = [
    { name: "the catalog's order", order: [] as string[] },
    { name: 'an order dragged in the picker', order: ['description', 'taxRate', 'lineTotal', 'qty', 'warehouse', 'unit', 'unitPrice', 'discount', 'lineSubtotal'] },
  ]
  for (const columns of ORDERS_OF_COLUMNS) {
    test(`a sales invoice with every column on, ${columns.name}: each heading stands over its own cells`, async ({ page }) => {
      await showEveryLineColumn(page, ['invoice'], columns.order)
      await loginForApp(page)
      await page.goto('/invoicing/invoices/new')
      const row = page.locator('.line-table tbody tr').first()
      await expect(row).toBeVisible()
      const headings = (await page.locator('.line-table thead th').allInnerTexts()).map((h) => h.trim().toLowerCase())
      const under = (heading: string) => {
        expect(headings, `a "${heading}" heading`).toContain(heading)
        return row.locator('td').nth(headings.indexOf(heading))
      }

      // A cell is known by the control it holds…
      await expect(under('unit').getByTestId('line-unit')).toBeVisible()
      await expect(under('unit price').getByTestId('price-combobox')).toBeVisible()
      await expect(under('tax rate').getByTestId('tax-rate-combobox')).toBeVisible()
      await expect(under('description').getByTestId('product-field')).toBeVisible()
      // …or by holding none: the two amounts are text, every other column is a field.
      for (const amount of ['subtotal', 'total']) await expect(under(amount).locator('.v-field')).toHaveCount(0)
      for (const field of ['qty', 'discount', 'warehouse']) await expect(under(field).locator('.v-field')).toHaveCount(1)

      if (columns.order.length) {
        expect(headings.slice(1, 1 + columns.order.length), 'the headings are in the dragged order')
          .toEqual(['description', 'tax rate', 'total', 'qty', 'warehouse', 'unit', 'unit price', 'discount', 'subtotal'])
      }
    })
  }
})
