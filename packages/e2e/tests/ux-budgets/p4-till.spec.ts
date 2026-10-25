import { test, expect } from '@playwright/test'
import { signInForUx, startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P4-till — one counter sale at the till: PRD-0016 ×1 and PRD-0017 ×3, paid by card. The
 * cashier finds each article by typing its name into the search and clicking its card, then
 * checks what the till leaves behind for the NEXT customer.
 *
 * acme-corp has no fiscal device, so the sale prints nothing whichever way „Нефискален“ is set.
 *
 * Products used: PRD-0016 and PRD-0017 (the till walks' share of the acme-corp seed).
 */

const MAIN_WAREHOUSE = 'Main Warehouse'
const CARD = '.v-card.cursor-pointer'

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
const DATA = /^(Product \d+|PRD-|TXN-|POS-|CSR-|SM-|Main Warehouse|Retail Store|Production Floor|Acme|EUR$|BGN$|USD$)/
function englishOnly(texts: string[]): string[] {
  return [...new Set(texts.filter(t => /[A-Za-z]/.test(t) && !/[А-Яа-я]/.test(t) && !DATA.test(t)))]
}

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

  // ── Probe (uncounted, in its own browser context): what a barcode scan does at this till.
  // A scanner types the code fast and ends with Enter.
  let scanNote = ''
  {
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport })
    const probe = await ctx.newPage()
    await signInForUx(probe)
    await probe.goto('/pos/terminal', { waitUntil: 'networkidle' })
    const s = probe.getByRole('textbox', { name: 'Търси продукти...' })
    const cartTitle = probe.locator('.v-card-title').filter({ hasText: /^Кошница/ })
    await s.click()
    await s.pressSequentially(p16.barcode, { delay: 5 })
    await s.press('Enter')
    await probe.waitForTimeout(1500)
    const afterScan = (await cartTitle.innerText()).trim()
    const shown = await probe.locator(CARD).count()
    await s.press('Enter')
    await probe.waitForTimeout(800)
    const afterSecondEnter = (await cartTitle.innerText()).trim()
    scanNote = afterScan === 'Кошница (0)' && afterSecondEnter === 'Кошница (0)'
      ? `Barcode scan (code + Enter at scanner speed, probed separately): the grid filters to ${shown === 1 ? 'the one card' : `${shown} cards`} but Enter adds nothing — not even a second Enter once that card is shown. The till has no Enter-to-add: every scanned article still costs a click on its card, and the code stays in the search.`
      : `Barcode scan probe: after scan+Enter the cart read “${afterScan}”, after a second Enter “${afterSecondEnter}”.`
    await ctx.close()
  }

  // ── The walk.
  const walk = await startWalk(page, testInfo, {
    id: 'P4-till',
    title: 'Till — one counter sale (PRD-0016 ×1, PRD-0017 ×3) paid by card',
    start: '/pos/terminal',
  })
  const search = page.getByRole('textbox', { name: 'Търси продукти...' })
  const cards = page.locator(CARD)
  const cartTitle = page.locator('.v-card-title').filter({ hasText: /^Кошница/ })
  await expect(search).toBeVisible()
  await expect(cards.first()).toBeVisible()
  await walk.shot('ready')
  walk.note(scanNote)

  const catalogFor = (text: string) => page.waitForResponse(r => {
    if (!r.url().includes('/trade/pos/catalog')) return false
    return new URL(r.url()).searchParams.get('search') === text
  })

  // Article 1 — typed into the search, which the till focuses on load.
  const autofocused = await search.evaluate(el => el === document.activeElement)
  if (!autofocused) walk.note('The search is not focused when the till loads: the first article costs a click into it.')
  let response = catalogFor('Product 16')
  await walk.type(search, 'Product 16', 'search „Product 16“', { focused: autofocused })
  await response
  await expect.poll(() => cards.count()).toBeLessThan(24)
  const hits16 = await cards.count()
  if (hits16 > 1) {
    const all20 = await api.get(`/trade/pos/catalog?size=1&warehouseId=${whId}&search=${encodeURIComponent('Product 20')}`)
    walk.note(`Typing „Product 16“ leaves ${hits16} cards: the search also matches inside barcodes (PRD-0017’s barcode ${p17.barcode} contains “16”); „Product 20“ matches ${all20.total} articles, because every seeded barcode starts 978020…. Here that happens to put Product 17 on screen too — the walk still searches each article, as a cashier must with real data.`)
  }
  await walk.shot('search-16')
  await walk.click(cards.filter({ hasText: 'Product 16 - Electronics' }), 'add Product 16 (card)')
  await expect(cartTitle).toHaveText('Кошница (1)')

  // Article 2 — the search still holds „Product 16“: clear it with × (that also focuses it).
  await walk.click(page.getByRole('button', { name: 'Изчисти Търси продукти...' }), 'clear the search (×)')
  await expect(search).toHaveValue('')
  const focusedAfterClear = await search.evaluate(el => el === document.activeElement)
  if (!focusedAfterClear) walk.note('Clearing the search (×) does not leave the cursor in it.')
  response = catalogFor('Product 17')
  await walk.type(search, 'Product 17', 'search „Product 17“', { focused: focusedAfterClear })
  await response
  await expect.poll(() => cards.count()).toBeLessThan(24)
  const card17 = cards.filter({ hasText: 'Product 17 - Hardware' })
  await walk.click(card17, 'add Product 17 (card)')
  await expect(cartTitle).toHaveText('Кошница (2)')
  // Quantity 3: each further click on the card adds one (the same as + on the line; typing
  // the quantity is a click into the field plus the typing — no shorter).
  await walk.click(card17, 'Product 17 again (qty 2)')
  await walk.click(card17, 'Product 17 again (qty 3)')
  await expect(page.getByTestId('cart-line-1').getByTestId('cart-qty').locator('input')).toHaveValue('3')
  await walk.shot('cart')

  // Card payment.
  await walk.choose(page, 'Метод на плащане', 'С карта', 'payment method: card')
  const paymentShown = page.locator('.v-select').filter({ has: page.getByRole('combobox', { name: 'Метод на плащане' }) }).locator('.v-select__selection-text')
  await expect(paymentShown).toHaveText('С карта')

  const shownTotal = (await page.locator('.v-card-text .text-h6').innerText()).replace(/\s+/g, ' ').trim()
  const lineText = (await page.getByTestId('cart-line-0').innerText()).replace(/\s+/g, ' ').trim()
  walk.note(`Cards and cart lines show NET prices to 4 decimals (line: “${lineText.slice(0, 60)}…”); the customer pays the VAT-inclusive total (“${shownTotal}”), which no line shows.`)

  await walk.click(page.getByRole('button', { name: 'Завърши продажба' }), 'complete sale')
  await expect(cartTitle).toHaveText('Кошница (0)')
  const snack = page.locator('.v-snackbar .v-snackbar__content')
  await expect(snack).toBeVisible()
  const snackText = (await snack.innerText()).trim()
  await page.waitForLoadState('networkidle')
  await walk.shot('after-sale')

  // ── What the till leaves for the NEXT customer.
  const leftInSearch = await search.inputValue()
  const focusAfter = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return 'the page body'
    return `${el.tagName.toLowerCase()}${el.textContent?.trim() ? ` “${el.textContent.trim().slice(0, 30)}”` : ''}`
  })
  const searchFocused = await search.evaluate(el => el === document.activeElement)
  if (leftInSearch || !searchFocused) {
    const why = [
      leftInSearch && `the search still reads „${leftInSearch}“ (the grid stays filtered to it)`,
      !searchFocused && `focus is on ${focusAfter}, not in the search`,
    ].filter(Boolean).join(' and ')
    walk.note(`After the sale ${why}: the next customer’s first article costs one click — ${leftInSearch ? 'on × (which also puts the cursor back)' : 'into the search'} — before typing.`)
  }
  const paymentAfter = (await paymentShown.innerText()).trim()
  if (paymentAfter !== 'В брой') {
    walk.note(`The payment method stays „${paymentAfter}“ for the next customer: a cash customer is booked as card unless the cashier notices and switches it back (2 clicks).`)
  }
  walk.note(`Confirmation: “${snackText}” (snackbar).`)
  if (/Продажбата е завършена/.test(snackText)) {
    walk.note('No fiscal device in acme-corp: the sale ends in plain success although nothing was printed — no receipt, no УНП (checked after the walk) — and nothing on screen says so. „Нефискален“ (on by default) changes nothing without a device.')
  }

  const english = englishOnly(await page.evaluate(leafTexts, '.v-main, .v-snackbar'))
  if (english.length) walk.note(`English text on the till: ${english.map(t => `“${t}”`).join(', ')}.`)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)

  // ── The walk did what it says (uncounted).
  const txns = await api.get(`/trade/pos/transactions?size=1&sessionId=${session.id || session._id}`)
  const sale = txns.transactions?.[0]
  expect(sale?.type).toBe('sale')
  expect(sale?.payments?.[0]?.method).toBe('card')
  expect(sale?.lines?.map((l: any) => l.quantity)).toEqual([1, 3])
  expect(sale?.isFiscal).toBe(false)
  expect(sale?.fiscalReceiptNumber || null).toBeNull()
  expect(sale?.unpNumber || null).toBeNull()
  const after = { p16: (await product('PRD-0016')).stockAvailable, p17: (await product('PRD-0017')).stockAvailable }
  expect(after.p16).toBe(before.p16 - 1)
  expect(after.p17).toBe(before.p17 - 3)
})
