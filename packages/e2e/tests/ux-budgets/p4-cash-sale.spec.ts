import { test, expect } from '@playwright/test'
import { signInForUx, startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P4-backoffice — the till's counter sale entered in the back office instead: from
 * `/invoicing/cash-sales`, a cash sale with PRD-0018 ×1 and PRD-0019 ×2, paid by card, saved.
 * The walk then starts the NEXT sale and stops at an empty form ready for its first line —
 * what the second customer costs before any article is entered.
 *
 * The cash-sale form is the FR-03 terminal skin (catalog left, cart right) over the invoicing
 * document engine; saving issues the document and dispatches the stock in one go. Each article
 * is entered by its code and Enter (FR-22.55): the SKU typed from the paperwork here; a
 * scanner's barcode works the same way (probed separately).
 *
 * Products used: PRD-0018 and PRD-0019 (the back-office walk's share of the acme-corp seed).
 */

const MAIN_WAREHOUSE = 'Main Warehouse'

/** Visible text nodes under `sel` (runs in the page). */
function leafTexts(sel: string): string[] {
  const out: string[] = []
  for (const scope of Array.from(document.querySelectorAll(sel))) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      const text = (n.textContent || '').trim()
      if (!el || !text || !el.getClientRects().length) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      out.push(text)
    }
  }
  return out
}

/** The English left in the Bulgarian UI: Latin and no Cyrillic, minus data (names, numbers, codes). */
const DATA = /^(Product \d+|PRD-|TXN-|POS-|CSR?-|SM-|Main Warehouse|Retail Store|Production Floor|Acme|Admin User$|EUR$|BGN$|USD$)/
function englishOnly(texts: string[]): string[] {
  return [...new Set(texts.filter(t => /[A-Za-z]/.test(t) && !/[А-Яа-я]/.test(t) && !DATA.test(t)))]
}

test('P4-backoffice: the same counter sale entered as a back-office cash sale', async ({ page, browser }, testInfo) => {
  // ── Setup (uncounted): stock for the two articles on Main Warehouse.
  const api = await uxApi()
  const warehouses = await api.get('/warehouse/warehouse?size=0')
  const wh = (warehouses.warehouses || []).find((w: any) => w.name === MAIN_WAREHOUSE)
  const whId = wh.id || wh._id
  const product = async (sku: string) => {
    const r = await api.get(`/trade/pos/catalog?size=5&warehouseId=${whId}&search=${sku}`)
    return (r.products || []).find((p: any) => p.sku === sku)
  }
  const p18 = await product('PRD-0018')
  const p19 = await product('PRD-0019')
  for (const p of [p18, p19]) {
    if ((p.stockAvailable ?? 0) >= 10) continue
    const m = await api.post('/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: whId, notes: 'ux-budget P4-backoffice stock top-up',
      lines: [{ productId: p.productId, quantity: 50, unitCost: 0, totalCost: 0 }], totalAmount: 0,
    })
    await api.post(`/warehouse/movement/${m.stockMovement.id || m.stockMovement._id}/confirm`, {})
  }
  const before = { p18: (await product('PRD-0018')).stockAvailable, p19: (await product('PRD-0019')).stockAvailable }

  // ── Probe (uncounted, own browser context): a barcode scan at scanner speed. Its Enter lands
  // before the 300 ms search debounce has filtered the grid — the moment that used to add nothing.
  {
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport })
    const probe = await ctx.newPage()
    await signInForUx(probe)
    await probe.goto('/invoicing/cash-sales/new', { waitUntil: 'networkidle' })
    const s = probe.locator('.terminal-catalog').getByRole('textbox', { name: 'Търсене' })
    const rows = probe.locator('.terminal-cart-row')
    await expect(probe.locator('.terminal-card').first()).toBeVisible()
    await s.click()
    await s.pressSequentially(p18.barcode, { delay: 5 })
    await s.press('Enter')
    // One Enter adds the article; the search is empty and ready for the next code.
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Product 18 - Office Supplies')
    await expect(s).toHaveValue('')
    await expect(s).toBeFocused()
    // A text that names no single article adds nothing: the grid shows the search instead
    // („Product 18" also matches PRD-0019, whose name carries „19" and barcode „18").
    await s.pressSequentially('Product 18', { delay: 5 })
    await s.press('Enter')
    await expect.poll(() => probe.locator('.terminal-card').count()).toBe(2)
    await expect(rows).toHaveCount(1)
    await expect(s).toHaveValue('Product 18')
    await ctx.close()
  }

  // ── The walk.
  const walk = await startWalk(page, testInfo, {
    id: 'P4-backoffice',
    title: 'Back office — the same counter sale as a cash sale (PRD-0018 ×1, PRD-0019 ×2) paid by card, then the next one',
    start: '/invoicing/cash-sales',
  })
  await expect(page.getByRole('heading', { name: 'Касови продажби' })).toBeVisible()
  await walk.shot('list')
  walk.note('Each article is entered by its code and Enter (FR-22.55): the SKU, typed from the paperwork; a scanner’s barcode works the same way (probed separately at scanner speed, before the search debounce). A code that names no single article adds nothing, and the grid shows the search.')

  const create = page.getByRole('link', { name: 'Създай' }).first()
  await walk.click(create, 'create (Създай)')
  await page.waitForURL(/\/cash-sales\/new$/)
  const catalog = page.locator('.terminal-catalog')
  const search = catalog.getByRole('textbox', { name: 'Търсене' })
  const cards = page.locator('.terminal-card')
  const cartRows = page.locator('.terminal-cart-row')
  await expect(cards.first()).toBeVisible()
  await page.waitForLoadState('networkidle')

  // What the empty form starts with.
  const warehouseField = page.getByRole('combobox', { name: 'Склад', exact: true })
  const warehouseShown = (await warehouseField.locator('xpath=ancestor::div[contains(@class,"v-autocomplete")][1]').locator('.v-autocomplete__selection-text').allInnerTexts()).join(' ').trim()
  const paymentShown = page.locator('.v-select').filter({ has: page.getByRole('combobox', { name: 'Метод на плащане' }) }).locator('.v-select__selection-text')
  const paymentStart = (await paymentShown.innerText()).trim()
  walk.note(`The new form starts on warehouse „${warehouseShown || '(none)'}“, payment „${paymentStart}“, no client (optional) and today’s date: for a walk-in sale only the payment method needs changing (to card here).`)
  await walk.shot('new-form')

  /** An article by its code: typed, then Enter. The search is left empty and focused. */
  const enterCode = async (code: string, focused: boolean) => {
    await walk.type(search, code, `type the code ${code}`, { focused })
    await walk.press(search, 'Enter', `Enter adds ${code}`)
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
  }

  // Article 1 — the search is focused when the new form opens, if the autofocus really holds.
  const autofocused = await search.evaluate(el => el === document.activeElement)
  if (!autofocused) walk.note('The catalog search is not focused when the new form opens: the first article costs a click into it.')
  await enterCode('PRD-0018', autofocused)
  await expect(cartRows).toHaveCount(1)
  await expect(cartRows.nth(0)).toContainText('Product 18 - Office Supplies')

  // Article 2, then its second unit with + on its line (one click; typing the code again would
  // cost a typed field and a key instead).
  await enterCode('PRD-0019', true)
  await expect(cartRows).toHaveCount(2)
  await expect(cartRows.nth(1)).toContainText('Product 19 - Raw Materials')
  await walk.click(cartRows.nth(1).getByRole('button', { name: 'Увеличи количество' }), 'Product 19: + (qty 2)')
  await expect(cartRows.nth(1).locator('input[type="number"]')).toHaveValue('2')
  await walk.shot('cart')
  const line1Total = (await cartRows.nth(0).locator('.font-weight-bold').last().innerText()).trim()
  walk.note(`Cart line totals here are VAT-inclusive and in bg format (1 × ${p18.unitPrice} net → “${line1Total}”), beside a 5-decimal unit price; the till’s line totals are NET and in en-US format (P4-till) — the two screens FR-21 merges disagree on what a line costs.`)

  // Card payment.
  await walk.choose(page, 'Метод на плащане', 'С карта', 'payment method: card')
  await expect(paymentShown).toHaveText('С карта')

  // Save — the big button under the cart (the header carries a second „Запази“).
  const saveButtons = page.getByRole('button', { name: 'Запази' })
  const saveCount = await saveButtons.count()
  const cartSave = saveButtons.filter({ has: page.locator('.mdi-cash-register') })
  await walk.click(cartSave, 'save')
  await page.waitForURL(/\/cash-sales(\?|$)/)
  const snack = page.locator('.v-snackbar .v-snackbar__content')
  await expect(snack).toBeVisible()
  const snackText = (await snack.innerText()).trim()
  await page.waitForLoadState('networkidle')
  await walk.shot('saved-list')
  const firstRow = page.locator('tbody tr').first()
  const firstRowText = (await firstRow.innerText()).replace(/\s+/g, ' ').trim()
  walk.note(`Save (${saveCount} „Запази“ buttons on the form) lands on the LIST, not on the saved document or a fresh form: “${snackText}”; top row “${firstRowText}”. Starting the next sale is one more click on „Създай“ (FR-22.58).`)

  // ── The next customer: back to an empty form, ready for the first line.
  await walk.click(create, 'create the next sale (Създай)')
  await page.waitForURL(/\/cash-sales\/new$/)
  await expect(cards.first()).toBeVisible()
  await expect(page.getByText('Кошницата е празна')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await walk.shot('next-form')
  if (!(await search.evaluate(el => el === document.activeElement))) {
    walk.note('On the next empty form the search is not focused: its first article costs a click into the search.')
  }
  const paymentNext = (await paymentShown.innerText()).trim()
  if (paymentNext !== 'В брой') walk.note(`The next form keeps payment „${paymentNext}“.`)

  const english = englishOnly(await page.evaluate(leafTexts, '.v-main, .v-snackbar'))
  if (english.length) walk.note(`English text on the cash-sale form: ${english.map(t => `“${t}”`).join(', ')}.`)

  const result = walk.finish()
  // FR-22 §3: ≤ 6 clicks and ≤ 2 typed fields (today 6 · 2; FR-22.58's „Запази и нова" would save the last click).
  expect(result.clicks).toBeLessThanOrEqual(6)
  expect(result.typed).toBeLessThanOrEqual(2)

  // ── The walk did what it says (uncounted).
  const docs = await api.get('/invoices?type=cash_sale&size=1&sortBy=createdAt&sortOrder=desc')
  const sale = docs.invoices?.[0]
  expect(sale?.paymentMethod).toBe('card')
  expect(sale?.lines?.filter((l: any) => l.productId).map((l: any) => l.quantity)).toEqual([1, 2])
  const after = { p18: (await product('PRD-0018')).stockAvailable, p19: (await product('PRD-0019')).stockAvailable }
  expect(after.p18).toBe(before.p18 - 1)
  expect(after.p19).toBe(before.p19 - 2)
})
