import { test, expect } from '@playwright/test'
import { startWalk, uxApi, closeOpenTillSessions } from '../helpers/ux-budget'

/**
 * P4-storno — a customer brings the goods back: the cashier, standing at the till
 * (`/pos/terminal`), reaches the sale in the journal and reverses (STORNO) it in full.
 *
 * The sale is made in setup through the API (uncounted): PRD-0020 ×1, cash, on the open session
 * of Main Warehouse — a storno is refunded from an open session of the sale's own warehouse.
 * It is the newest sale, so it is the journal's top row: the walk is the best case.
 *
 * acme-corp has no fiscal device, so neither the sale nor its storno prints a receipt.
 *
 * Products used: PRD-0020 (the storno walk's share of the acme-corp seed).
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

/** The till's own totals rule for one VAT rate (config/pos-totals → computePosTotals). */
function posTotals(quantity: number, unitPrice: number, taxRate: number) {
  const cents = (n: number) => Math.round(n * 100 * (1 + Number.EPSILON)) / 100
  const total = cents(quantity * unitPrice * (1 + taxRate / 100))
  const taxTotal = cents((total * taxRate) / (100 + taxRate))
  return { subtotal: cents(total - taxTotal), taxTotal, total }
}


// The walk leaves its session open: close it, so later specs find the terminal without one.
test.afterAll(async () => {
  await closeOpenTillSessions(await uxApi())
})

test('P4-storno: reverse a till sale, starting at the terminal', async ({ page }, testInfo) => {
  // ── Setup (uncounted): an open session on Main Warehouse and a sale of PRD-0020 ×1 on it.
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
  const sessionId = session.id || session._id
  const product = async (sku: string) => {
    const r = await api.get(`/trade/pos/catalog?size=5&warehouseId=${whId}&search=${sku}`)
    return (r.products || []).find((p: any) => p.sku === sku)
  }
  const p20 = await product('PRD-0020')
  const stockBeforeSale = p20.stockAvailable
  const totals = posTotals(1, p20.unitPrice, p20.taxRate)
  const made = await api.post(`/trade/pos/session/${sessionId}/transaction`, {
    type: 'sale',
    lines: [{
      productId: p20.productId, name: p20.productName, quantity: 1, unitPrice: p20.unitPrice, discount: 0,
      taxRate: p20.taxRate, taxAmount: totals.taxTotal, lineTotal: p20.unitPrice,
    }],
    subtotal: totals.subtotal, discountTotal: 0, taxTotal: totals.taxTotal, total: totals.total,
    payments: [{ method: 'cash', amount: totals.total }], changeDue: 0, nonFiscal: true,
  })
  const sale = made.transaction
  expect(sale?.transactionNumber, `setup sale failed: ${made.message}`).toBeTruthy()
  expect((await product('PRD-0020')).stockAvailable).toBe(stockBeforeSale - 1)

  // ── The walk: from the till to the journal, the sale, and its storno.
  const walk = await startWalk(page, testInfo, {
    id: 'P4-storno',
    title: 'Till — a customer returns the goods: STORNO a till sale (PRD-0020 ×1) in full, starting at the terminal',
    start: '/pos/terminal',
  })
  await expect(page.getByRole('textbox', { name: 'Търси продукти...' })).toBeVisible()
  await walk.shot('terminal')
  const tillTexts = await page.locator('.v-main').innerText()
  if (!/сторно|рекламац|върн/i.test(tillTexts)) walk.note('The till itself offers no return or storno: the cashier leaves the terminal for the transactions journal.')

  // The top menus open on hover (FR-05): pointing at „Поръчки“ costs no click.
  // FR-21.13: the journal is „Касови продажби“ now, in the POS app as in invoicing.
  await walk.menu('Поръчки', 'Касови продажби')
  await page.waitForURL(/\/pos\/orders(\?|$)/)

  const rows = page.locator('.v-main tbody tr')
  const row = rows.filter({ hasText: sale.transactionNumber })
  await expect(row).toBeVisible()
  await page.waitForLoadState('networkidle')
  await walk.shot('journal')
  if (!(await rows.first().innerText()).includes(sale.transactionNumber)) {
    walk.note(`The sale ${sale.transactionNumber} is not the journal’s top row.`)
  }
  const headers = (await page.locator('.v-main thead th').allTextContents()).map(h => h.trim()).filter(Boolean).join(' · ')
  walk.note(`Best case: the sale is the newest, so it is the top row. Journal columns: ${headers}. No articles, no time of day, no cashier: an older sale is found by opening rows (eye) one by one, or by its number (the search covers only the number and УНП) — and a customer of this non-fiscal till holds no receipt carrying either.`)

  await walk.click(row.getByTestId('storno-button'), 'СТОРНО on the sale’s row')
  const dialog = page.getByTestId('storno-dialog')
  await expect(dialog).toBeVisible()
  walk.dialog('storno: total, session, reason')
  const fromSession = (await dialog.getByText(/Връщане от сесия/).innerText()).trim()
  await expect(page.getByTestId('storno-confirm')).toBeEnabled()
  await page.waitForFunction(() => !document.getAnimations().some(a => a instanceof CSSTransition && a.playState === 'running'))
  const reasonShown = (await dialog.locator('.v-select__selection-text').innerText()).trim()
  if (reasonShown !== 'Връщане / рекламация') walk.note(`The reason starts as „${reasonShown}“, not the customer-return one: 2 more clicks.`)
  walk.note(`The storno dialog shows the total and “${fromSession}”, and asks only the reason (preset „${reasonShown}“ — fits a return, so no click): the whole sale is reversed, with no choice of lines or quantities, so a customer returning part of a purchase cannot be served here; and it does not say how the money goes back (the sale’s own payment method is repeated).`)
  walk.note('СТОРНО is offered only to admin, manager and warehouse_manager (the server enforces the same): a cashier in any other role has to fetch one of them for every return.')
  await walk.shot('storno-dialog')

  await walk.click(page.getByTestId('storno-confirm'), 'confirm: Сторнирай')
  await expect(dialog).toBeHidden()
  const snack = page.locator('.v-snackbar .v-snackbar__content')
  await expect(snack).toBeVisible()
  const snackText = (await snack.innerText()).trim()
  await expect(row.getByTestId('storno-button')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  await walk.shot('reversed')
  const rowAfter = (await row.innerText()).replace(/\s+/g, ' ').trim()
  const topAfter = (await rows.first().innerText()).replace(/\s+/g, ' ').trim()
  walk.note(`After the storno: “${snackText}”; the sale’s row reads “${rowAfter}”, the storno’s “${topAfter}”. Nothing was printed (no fiscal device) and nothing says so. Back to the till is one more click (hover „Каса“ → „Терминал“), not counted.`)

  const english = englishOnly(await page.evaluate(leafTexts, '.v-main, .v-snackbar'))
  if (english.length) walk.note(`English text in the journal: ${english.map(t => `“${t}”`).join(', ')}.`)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)

  // ── The walk did what it says (uncounted).
  // FR-21.27: read through the journal; the sale stays paid, stornoed, with its storno in its chain.
  const original = await api.get(`/cash-register/documents/${sale.id || sale._id}`)
  expect(original.row?.status).toBe('stornoed')
  expect((original.related || []).some((r: any) => r.kind === 'storno' && r.relatedId === String(sale.id || sale._id))).toBe(true)
  expect((await product('PRD-0020')).stockAvailable).toBe(stockBeforeSale)
})
