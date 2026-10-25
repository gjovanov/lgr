import { test, expect } from '@playwright/test'
import { signInForUx, startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P4-backoffice — the till's counter sale entered in the back office instead: from
 * `/invoicing/cash-sales`, a cash sale with PRD-0018 ×1 and PRD-0019 ×2, paid by card, saved.
 * The walk then starts the NEXT sale and stops at an empty form ready for its first line —
 * what the second customer costs before any article is entered.
 *
 * The cash-sale form is the FR-03 terminal skin (catalog left, cart right) over the invoicing
 * document engine; saving issues the document and dispatches the stock in one go.
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

  // ── Probe (uncounted, own browser context): what a barcode scan does on this form, which —
  // unlike the till — adds the article on Enter when exactly one card matches.
  let scanNote = ''
  {
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport })
    const probe = await ctx.newPage()
    await signInForUx(probe)
    await probe.goto('/invoicing/cash-sales/new', { waitUntil: 'networkidle' })
    const s = probe.locator('.terminal-catalog').getByRole('textbox', { name: 'Търсене' })
    await expect(probe.locator('.terminal-card').first()).toBeVisible()
    await s.click()
    await s.pressSequentially(p18.barcode, { delay: 5 })
    await s.press('Enter')
    await probe.waitForTimeout(1500)
    const rowsAfterScan = await probe.locator('.terminal-cart-row').count()
    const leftAfterScan = await s.inputValue()
    const shown = await probe.locator('.terminal-card').count()
    await s.press('Enter')
    await probe.waitForTimeout(1000)
    const rowsAfterSecond = await probe.locator('.terminal-cart-row').count()
    const leftAfterSecond = await s.inputValue()
    scanNote = rowsAfterScan === 0 && rowsAfterSecond === 1 && !leftAfterSecond
      ? `Barcode scan (code + Enter at scanner speed, probed separately): the scanner’s Enter lands before the 300 ms search debounce has filtered the grid, so it is ignored — nothing is added${leftAfterScan ? ' and the code stays in the search' : ''}. Once the grid shows ${shown === 1 ? 'the one card' : `${shown} cards`}, a second Enter adds it and clears the search, so a scan costs an extra Enter (or a click on the card). Enter-to-add needs exactly one match: a typed name such as „Product 18“ never qualifies here (2 matches).`
      : `Barcode scan probe: cart rows after scan+Enter ${rowsAfterScan} (search “${leftAfterScan}”), after a second Enter ${rowsAfterSecond} (search “${leftAfterSecond}”).`
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
  walk.note(scanNote)

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

  const catalogFor = (text: string) => page.waitForResponse(r => {
    if (!r.url().includes('/trade/pos/catalog')) return false
    return new URL(r.url()).searchParams.get('search') === text
  })

  // Article 1 — typed into the search (autofocused on the new form, if the focus is really there).
  const autofocused = await search.evaluate(el => el === document.activeElement)
  if (!autofocused) walk.note('The catalog search is not focused when the new form opens: the first article costs a click into it.')
  let response = catalogFor('Product 18')
  await walk.type(search, 'Product 18', 'search „Product 18“', { focused: autofocused })
  await response
  await expect.poll(() => cards.count()).toBeLessThan(24)
  const hits18 = await cards.count()
  await walk.shot('search-18')
  await walk.click(cards.filter({ hasText: 'Product 18 - Office Supplies' }), 'add Product 18 (card)')
  await expect(cartRows).toHaveCount(1)
  if (hits18 > 1) walk.note(`„Product 18“ leaves ${hits18} cards (the search matches inside barcodes too), so Enter cannot add it — the card is clicked. That it puts Product 19 on screen too is a seed-data accident; the walk still searches each article.`)

  // Article 2 — the search still holds „Product 18“.
  await walk.click(page.getByRole('button', { name: 'Изчисти Търсене' }), 'clear the search (×)')
  await expect(search).toHaveValue('')
  const focusedAfterClear = await search.evaluate(el => el === document.activeElement)
  if (!focusedAfterClear) walk.note('Clearing the search (×) does not leave the cursor in it.')
  response = catalogFor('Product 19')
  await walk.type(search, 'Product 19', 'search „Product 19“', { focused: focusedAfterClear })
  await response
  await expect.poll(() => cards.count()).toBeLessThan(24)
  const card19 = cards.filter({ hasText: 'Product 19 - Raw Materials' })
  await walk.click(card19, 'add Product 19 (card)')
  await expect(cartRows).toHaveCount(2)
  // Quantity 2: one more click on the card (the same as + on the line).
  await walk.click(card19, 'Product 19 again (qty 2)')
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
  walk.note(`Save (${saveCount} „Запази“ buttons on the form) lands on the LIST, not on the saved document or a fresh form: “${snackText}”; top row “${firstRowText}”. Starting the next sale is one more click on „Създай“.`)

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
  expect(result.clicks).toBeGreaterThan(0)

  // ── The walk did what it says (uncounted).
  const docs = await api.get('/invoices?type=cash_sale&size=1&sortBy=createdAt&sortOrder=desc')
  const sale = docs.invoices?.[0]
  expect(sale?.paymentMethod).toBe('card')
  expect(sale?.lines?.filter((l: any) => l.productId).map((l: any) => l.quantity)).toEqual([1, 2])
  const after = { p18: (await product('PRD-0018')).stockAvailable, p19: (await product('PRD-0019')).stockAvailable }
  expect(after.p18).toBe(before.p18 - 1)
  expect(after.p19).toBe(before.p19 - 2)
})
