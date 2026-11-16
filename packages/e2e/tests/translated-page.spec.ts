import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { draftBill } from './helpers/bills'
import { switchLocale } from './helpers/nav'
import { translatePage } from './helpers/translator'

/**
 * 2026-11-15: on a purchase invoice the Back button did nothing. The page had been translated by the browser,
 * which replaces the page's text nodes; the person pressed „Save and receive", the status pipeline's first chip
 * gained its tick (an icon the app places BEFORE the chip's text, a node that was no longer there), the insert
 * was refused and the page stopped half way through the change. From then on it could not be taken down, so no
 * move away from it worked.
 *
 * The browser translated it because the page said `<html lang="en">` under a Bulgarian screen, and the screen was
 * Bulgarian while the app's own setting said English: the language of a person who never chose one was decided
 * twice. The rules are held in `unit/page-language.test.ts`; this is what a person sees.
 */

/** The language menu in the top bar: its label is the language every print and export asks for. */
const languageMenu = (page: any) => page.locator('.v-app-bar button').filter({ has: page.locator('.mdi-translate') })

test('a page something else has rewritten: the status advances, and Back still leaves the form', async ({ page }) => {
  const broken: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') broken.push(m.text()) })
  page.on('pageerror', (e) => broken.push(e.message))

  const bill = await draftBill()
  await loginForApp(page)
  await page.goto(`/invoicing/bills/${bill.id}/edit`)
  const form = page.locator('.entity-form-shell')
  // The pipeline's first step. While the document is a draft it is where the document stands: no tick.
  const draftStep = form.locator('.v-chip').filter({ hasText: /^\s*Draft\s*$/ }).first()
  await expect(draftStep).toBeVisible({ timeout: 15000 })
  await expect(draftStep.locator('.mdi-check')).toHaveCount(0)
  await expect(page.getByTestId('print-stock-receipt')).toHaveCount(0)

  expect(await translatePage(page)).toBeGreaterThan(20)

  const received = page.waitForResponse((r) => /\/invoices\/[0-9a-f]{24}\/receive$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await form.locator('button:has(.mdi-package-down)').first().click()
  expect((await received).ok()).toBe(true)
  // The step is behind the document now: its chip carries the tick, placed beside text the app no longer owns.
  await expect(draftStep.locator('.mdi-check')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('form-back').click()
  await expect(page).toHaveURL(/\/invoicing\/bills(\?|$)/)
  // The form is gone and the list is there: the move happened on the screen, not only in the address bar.
  await expect(page.getByTestId('form-back')).toHaveCount(0)
  await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 15000 })
  expect(broken.filter((line) => /insertBefore|__asyncLoader|NotFoundError/.test(line))).toEqual([])
})

test('the page asks not to be translated', async ({ page }) => {
  await loginForApp(page)
  await expect(page.locator('html')).toHaveAttribute('translate', 'no')
  await expect(page.locator('meta[name="google"]')).toHaveAttribute('content', 'notranslate')
})

test.describe('a person who never chose a language, in a Bulgarian browser', () => {
  test.use({ locale: 'bg-BG' })

  test('reads Bulgarian, and the page and the language menu say so', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    await expect(page.getByRole('heading', { name: 'Нова покупна фактура' })).toBeVisible({ timeout: 15000 })
    expect(await page.evaluate(() => localStorage.getItem('lgr_locale'))).toBeNull()

    // The page says Bulgarian (it said English), and so does the menu (it said EN over a Bulgarian screen, and
    // every print and export asked for what it said).
    await expect(page.locator('html')).toHaveAttribute('lang', 'bg')
    await expect(languageMenu(page)).toContainText('BG')

    // Choosing another language says it on the page as well.
    await switchLocale(page, 'DE')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(languageMenu(page)).toContainText('DE')
  })
})
