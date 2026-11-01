import { test, expect } from '@playwright/test'
import { signInForUx, startWalk, uxApi, closeOpenTillSessions } from '../helpers/ux-budget'

/**
 * P4-till — one counter sale at the till: PRD-0016 ×1 and PRD-0017 ×3, paid by card. The
 * cashier scans each article (the scanner types the barcode and ends with Enter, FR-22.55), then
 * checks what the till leaves behind for the NEXT customer (FR-22.54).
 *
 * acme-corp has no fiscal device, so the sale prints nothing whichever way „Нефискален“ is set,
 * and the till says so.
 *
 * Products used: PRD-0016 and PRD-0017 (the till walks' share of the acme-corp seed).
 */

const MAIN_WAREHOUSE = 'Main Warehouse'
const CARD = '[data-testid="register-card"]'
const NOTHING_PRINTED = 'Нищо не е отпечатано: към касата няма свързано фискално устройство'

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
const DATA = /^(Product \d+|PRD-|TXN-|POS-|CSR?-|SM-|Main Warehouse|Retail Store|Production Floor|Acme|EUR$|BGN$|USD$)/
function englishOnly(texts: string[]): string[] {
  return [...new Set(texts.filter(t => /[A-Za-z]/.test(t) && !/[А-Яа-я]/.test(t) && !DATA.test(t)))]
}


// The walk leaves its session open: close it, so later specs find the terminal without one.
test.afterAll(async () => {
  await closeOpenTillSessions(await uxApi())
})

test('P4-till: one counter sale paid by card', async ({ page, browser }, testInfo) => {
  // ── Setup (uncounted): an open session on Main Warehouse, and stock for the two articles.
  const api = await uxApi()
  const warehouses = await api.get('/warehouse/warehouse?size=0')
  const wh = (warehouses.warehouses || []).find((w: any) => w.name === MAIN_WAREHOUSE)
  const whId = wh.id || wh._id
  const open = await api.get('/trade/pos/session?status=open&size=50')
  let session = (open.sessions || []).find((s: any) => String(s.warehouseId) === String(whId))
  if (!session) {
    const opened = await api.post('/trade/pos/session', { warehouseId: whId, openingBalance: 100, currency: 'EUR' })
    expect(opened.session, `setup could not open a session: ${opened.message}`).toBeTruthy()
    session = opened.session
  }
  const product = async (sku: string) => {
    const r = await api.get(`/trade/pos/catalog?size=5&warehouseId=${whId}&search=${sku}`)
    return (r.products || []).find((p: any) => p.sku === sku)
  }
  const p16 = await product('PRD-0016')
  const p17 = await product('PRD-0017')
  for (const p of [p16, p17]) {
    if ((p.stockAvailable ?? 0) >= 10) continue
    const m = await api.post('/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: whId, notes: 'ux-budget P4-till stock top-up',
      lines: [{ productId: p.productId, quantity: 50, unitCost: 0, totalCost: 0 }], totalAmount: 0,
    })
    await api.post(`/warehouse/movement/${m.stockMovement.id || m.stockMovement._id}/confirm`, {})
  }
  const before = { p16: (await product('PRD-0016')).stockAvailable, p17: (await product('PRD-0017')).stockAvailable }

  // ── Probe (uncounted, in its own browser context): a scan at scanner speed — the code typed
  // in a few milliseconds and Enter at once, long before the search's 300 ms debounce (FR-22.55).
  {
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport })
    const probe = await ctx.newPage()
    await signInForUx(probe)
    await probe.goto('/invoicing/cash-sales/new', { waitUntil: 'networkidle' })
    const s = probe.getByRole('textbox', { name: 'Търси продукти...' })
    const cartTitle = probe.locator('.v-card-title').filter({ hasText: /^Кошница/ })
    await s.click()
    await s.pressSequentially(p16.barcode, { delay: 5 })
    await s.press('Enter')
    // One Enter adds the article, and the search is empty and ready for the next scan.
    await expect(cartTitle).toHaveText('Кошница (1)')
    await expect(probe.getByTestId('cart-line-0')).toContainText('Product 16 - Electronics')
    await expect(s).toHaveValue('')
    await expect(s).toBeFocused()
    // A text that names no single article adds nothing: the grid shows the search instead
    // („Electronics" is a category of ten seeded articles).
    const filtered = probe.waitForResponse(r => r.url().includes('/trade/pos/catalog?') && new URL(r.url()).searchParams.get('search') === 'Electronics')
    await s.pressSequentially('Electronics', { delay: 5 })
    await s.press('Enter')
    await filtered
    await expect.poll(() => probe.locator(CARD).count()).toBe(10)
    await expect(cartTitle).toHaveText('Кошница (1)')
    await expect(s).toHaveValue('Electronics')
    await ctx.close()
  }

  // ── The walk.
  const walk = await startWalk(page, testInfo, {
    id: 'P4-till',
    title: 'Till — one counter sale (PRD-0016 ×1, PRD-0017 ×3) paid by card',
    start: '/invoicing/cash-sales/new',
  })
  const search = page.getByRole('textbox', { name: 'Търси продукти...' })
  const cards = page.locator(CARD)
  const cartTitle = page.locator('.v-card-title').filter({ hasText: /^Кошница/ })
  const lastSale = page.getByTestId('last-sale')
  await expect(search).toBeVisible()
  await expect(cards.first()).toBeVisible()
  await walk.shot('ready')
  walk.note('Each article is scanned: the scanner types its barcode and ends with Enter, which adds it (FR-22.55; probed separately at scanner speed, before the search debounce). A further unit of the same article is another scan. A code that names no single article adds nothing, and the grid shows the search.')

  /** One pass of the scanner: the barcode, then Enter. The search is left empty and focused. */
  const scan = async (barcode: string, what: string, focused: boolean) => {
    await walk.type(search, barcode, `scan ${what} (barcode)`, { focused })
    await walk.press(search, 'Enter', `scan ${what} — the scanner’s Enter adds it`)
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
  }

  // The till focuses its search on load, so the first scan lands there.
  const autofocused = await search.evaluate(el => el === document.activeElement)
  if (!autofocused) walk.note('The search is not focused when the till loads: the first scan costs a click into it.')
  await scan(p16.barcode, 'PRD-0016', autofocused)
  await expect(cartTitle).toHaveText('Кошница (1)')
  await expect(page.getByTestId('cart-line-0')).toContainText('Product 16 - Electronics')
  await walk.shot('scanned-16')

  for (let qty = 1; qty <= 3; qty++) {
    await scan(p17.barcode, `PRD-0017 (${qty} of 3)`, true)
    await expect(page.getByTestId('cart-line-1').getByTestId('cart-qty').locator('input')).toHaveValue(String(qty))
  }
  await expect(cartTitle).toHaveText('Кошница (2)')
  await expect(page.getByTestId('cart-line-1')).toContainText('Product 17 - Hardware')
  await walk.shot('cart')

  // Card payment.
  await walk.choose(page, 'Метод на плащане', 'С карта', 'payment method: card')
  const paymentShown = page.locator('.v-select').filter({ has: page.getByRole('combobox', { name: 'Метод на плащане' }) }).locator('.v-select__selection-text')
  await expect(paymentShown).toHaveText('С карта')

  const shownTotal = (await page.locator('.v-card-text .text-h6').innerText()).replace(/\s+/g, ' ').trim()
  const totalAmount = shownTotal.replace(/^\D+/, '').trim()
  const lineText = (await page.getByTestId('cart-line-0').innerText()).replace(/\s+/g, ' ').trim()
  walk.note(`Cards and cart lines show NET prices to 4 decimals (line: “${lineText.slice(0, 60)}…”); the customer pays the VAT-inclusive total (“${shownTotal}”), which no line shows.`)

  await walk.click(page.getByRole('button', { name: 'Завърши продажба' }), 'complete sale')
  await expect(cartTitle).toHaveText('Кошница (0)')
  await expect(lastSale).toBeVisible()
  await page.waitForLoadState('networkidle')
  await walk.shot('after-sale')

  // ── What the till leaves for the NEXT customer (FR-22.54).
  // The sale's result stays in the cart area: number, total, method, and what printed.
  // FR-21 (D-5): a till sale is a cash-register document, numbered in the cash-sale series.
  await expect(page.getByTestId('last-sale-number')).toHaveText(/^Продажба CSR?-\d{4}-\d{5}$/)
  await expect(page.getByTestId('last-sale-total')).toContainText(totalAmount)
  await expect(lastSale).toContainText('С карта')
  await expect(page.getByTestId('last-sale-receipt')).toHaveText(NOTHING_PRINTED)
  // Cash again, and the cursor in an empty search: the next scan just works.
  await expect(paymentShown).toHaveText('В брой')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  const resultText = (await lastSale.innerText()).replace(/\s+/g, ' ').trim()
  walk.note(`After the sale the cart area keeps its result until the next article goes in: “${resultText}”. The payment method is back on „В брой“ and the cursor is in the empty search, so the next customer starts with a scan.`)

  const english = englishOnly(await page.evaluate(leafTexts, '.v-main, .v-snackbar'))
  if (english.length) walk.note(`English text on the till: ${english.map(t => `“${t}”`).join(', ')}.`)

  const result = walk.finish()
  // FR-22 §3: ≤ 4 clicks, the articles by scans (today 3: card payment 2, complete 1).
  expect(result.clicks).toBeLessThanOrEqual(4)

  // ── The walk did what it says (uncounted).
  // FR-21.27: the session's own list (the global `/trade/pos/transactions` is gone).
  const txns = await api.get(`/trade/pos/session/${session.id || session._id}/transaction?size=1`)
  const sale = txns.transactions?.[0]
  expect(sale?.type).toBe('sale')
  expect(sale?.payments?.[0]?.method).toBe('card')
  expect(sale?.lines?.map((l: any) => l.quantity)).toEqual([1, 3])
  expect(sale?.isFiscal).toBe(false)
  expect(sale?.fiscalReceiptNumber || null).toBeNull()
  expect(sale?.unpNumber || null).toBeNull()
  await expect(page.getByTestId('last-sale-number')).toHaveText(`Продажба ${sale.transactionNumber}`)
  const after = { p16: (await product('PRD-0016')).stockAvailable, p17: (await product('PRD-0017')).stockAvailable }
  expect(after.p16).toBe(before.p16 - 1)
  expect(after.p17).toBe(before.p17 - 3)

  // The result gives way to the next customer's first scan (uncounted).
  await search.pressSequentially(p16.barcode, { delay: 5 })
  await search.press('Enter')
  await expect(cartTitle).toHaveText('Кошница (1)')
  await expect(lastSale).toBeHidden()
})
