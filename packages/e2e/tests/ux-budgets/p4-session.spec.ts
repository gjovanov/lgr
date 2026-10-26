import { test, expect } from '@playwright/test'
import { startWalk, uxApi, closeOpenTillSessions } from '../helpers/ux-budget'

/**
 * P4-open — start of the day at the till: from `/pos/terminal` with no open session, open one
 * (warehouse + opening float) and stop once the catalog is ready to sell.
 *
 * acme-corp has no fiscal device, so opening touches no device at all (`getFiscalContext` finds
 * none and the session opens without a fiscal check).
 */

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

test('P4-open: open the till for the day', async ({ page }, testInfo) => {
  // ── Setup (uncounted). The terminal takes ANY open session of the org as its own, so every
  // open session is closed — with the counted amounts equal to the expected ones.
  const api = await uxApi()
  const open = await api.get('/trade/pos/session?status=open&size=50')
  for (const s of open.sessions || []) {
    const id = s.id || s._id
    const preview = await api.get(`/trade/pos/session/${id}/close-preview`)
    const closed = await api.post(`/trade/pos/session/${id}/close`, { counted: preview.expected })
    expect(closed.session?.status, `setup could not close ${s.sessionNumber}: ${closed.message}`).toBe('closed')
  }

  const walk = await startWalk(page, testInfo, {
    id: 'P4-open',
    title: 'Till — open the day’s session (warehouse + opening float) until the catalog is ready to sell',
    start: '/pos/terminal',
  })
  const openButton = page.getByRole('button', { name: 'Отвори сесия' })
  await expect(openButton).toBeVisible()
  await walk.shot('no-session')

  await walk.click(openButton, 'open session')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  walk.dialog('open session: warehouse + opening balance')

  // What the dialog starts with.
  const warehouseShown = (await dialog.locator('.v-select__selection-text').allInnerTexts()).join(' ').trim()
  if (!warehouseShown) walk.note('Open-session dialog: no warehouse preselected, although the org has a default one (Main Warehouse) and the cashier opens the same till every day — 2 clicks every morning.')
  const balance = dialog.getByLabel('Начално салдо')
  const balanceStart = await balance.inputValue()
  await walk.shot('dialog')

  await walk.choose(dialog, 'Склад', 'Main Warehouse', 'warehouse')
  await walk.fill(balance, '100', 'opening float')
  if (balanceStart === '0' || balanceStart === '') walk.note(`Opening balance starts at ${balanceStart || 'empty'}: nothing carries over from the previous close, so the float is typed every day.`)

  await walk.click(dialog.getByRole('button', { name: 'Отвори сесия' }), 'confirm: open session')
  await expect(dialog).toBeHidden()

  // Ready to sell: the session bar, the search and the catalog cards.
  const search = page.getByRole('textbox', { name: 'Търси продукти...' })
  await expect(search).toBeVisible()
  await expect(page.locator('.v-card.cursor-pointer').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await walk.shot('ready')

  const snack = (await page.locator('.v-snackbar .v-snackbar__content').allInnerTexts()).join(' ').trim()
  if (snack) walk.note(`Confirmation after opening: “${snack}” — a generic save message that names neither the session nor the till.`)
  const sessionLine = (await page.locator('.v-main').getByText(/Сесия:/).first().innerText()).trim()
  walk.note(`Session bar after opening: “${sessionLine}”.`)
  if (!(await search.evaluate(el => el === document.activeElement))) {
    walk.note('After opening, focus is not in the product search: the first article costs a click into it.')
  }

  // No fiscal device in acme-corp: say what the till shows about printing.
  const header = await page.locator('.v-main').innerText()
  if (/Нефискален/.test(header)) {
    walk.note('No fiscal device in acme-corp: the session opened without any fiscal check. The bar still shows the „Нефискален“ switch (on by default), a printer chip „Изключен“, a baud-rate select and „Свържи принтер“ — controls that have nothing to connect to here.')
  }
  const english = englishOnly(await page.evaluate(leafTexts, '.v-main, .v-snackbar'))
  if (english.length) walk.note(`English text on the till: ${english.map(t => `“${t}”`).join(', ')}.`)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)

  // The walk did what it says (uncounted).
  const after = await api.get('/trade/pos/session?status=open&size=50')
  const mine = (after.sessions || []).find((s: any) => s.openingBalance === 100)
  expect(mine, 'no open session with the typed float').toBeTruthy()
})
