import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-31.14 / .15 (#796): in a Bulgarian session the daily screens show no English, and one date and one amount look
 * the same on a list and in a form.
 *
 * What is read is the screen's own text: headings, column headings, labels, buttons, tabs, hints. The rows are data
 * (the demo organization's names are partly English) and are left out.
 */

/** English words that would only be on a Bulgarian screen by mistake. Whole words, as written. */
const ENGLISH = ['Save', 'Cancel', 'Search', 'Status', 'Total', 'Amount', 'Export', 'Quantity', 'Description', 'Actions',
  'Create', 'Delete', 'Type', 'Date', 'Name', 'Price', 'Apply', 'Available', 'Needed', 'Apps', 'Portal', 'Unsaved']

const SCREENS = [
  '/invoicing/invoices',
  '/invoicing/invoices/new',
  '/invoicing/bills',
  '/invoicing/payment-orders',
  '/invoicing/cash-orders',
  '/inventory/products',
  '/inventory/movements',
  '/inventory/movements/new',
  '/inventory/stock-levels',
  '/inventory/bulk-pricing',
]

const CHROME = 'h1, h2, h3, th, label, .v-label, button, .v-tab, .v-messages__message, .v-card-title, .v-alert, .v-chip__content'

test.describe('a Bulgarian session (FR-31.15)', () => {
  test.use({ locale: 'bg-BG' })

  test('the daily screens show none of the walk’s English words', async ({ page }) => {
    await loginForApp(page)
    const found: string[] = []
    for (const path of SCREENS) {
      await page.goto(path)
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 15000 })
      await page.waitForLoadState('networkidle')
      await expect(page.locator('html')).toHaveAttribute('lang', 'bg')
      const texts = await page.locator(CHROME).evaluateAll(els => els
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .map(el => (el as HTMLElement).innerText || ''))
      expect(texts.filter(Boolean).length, `${path}: the screen's own text was read`).toBeGreaterThan(5)
      // Cyrillic is what is read: the walk is not reading an English screen.
      expect(texts.join(' '), path).toMatch(/[А-Яа-я]{4}/)
      for (const text of texts) {
        for (const word of ENGLISH) {
          if (new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`).test(text)) found.push(`${path}: "${word}" in "${text.trim().slice(0, 60)}"`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
