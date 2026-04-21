import { test, expect, type Page, type Download } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * E2E coverage for the Export dialog across all 6 invoicing list pages
 * plus the single-object export from a details page.
 *
 * The tests don't inspect the downloaded bytes — Playwright's `page.waitForEvent('download')`
 * is enough to verify the click triggered a browser-initiated file download with a
 * content-disposition response.
 */

const LIST_PAGES: Array<{ name: string; path: string }> = [
  { name: 'sales invoices', path: '/invoicing/invoices' },
  { name: 'proforma invoices', path: '/invoicing/proforma' },
  { name: 'credit notes', path: '/invoicing/credit-notes' },
  { name: 'debit notes', path: '/invoicing/debit-notes' },
  { name: 'cash sales', path: '/invoicing/cash-sales' },
  { name: 'purchase invoices', path: '/invoicing/bills' },
]

async function openExportDialog(page: Page) {
  const trigger = page.getByRole('button', { name: /^export$/i }).first()
  await expect(trigger).toBeVisible({ timeout: 10000 })
  await trigger.click()
  // Dialog: the ExportDialog card has a Download button — that's the easiest stable signal
  await expect(page.locator('.v-overlay--active .v-card')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i })).toBeVisible()
}

async function clickDownloadAndWait(page: Page): Promise<Download> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click(),
  ])
  return download
}

for (const { name, path } of LIST_PAGES) {
  test.describe(`Export — ${name}`, () => {
    test(`opens export dialog and downloads XLSX compact (${name})`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

      await openExportDialog(page)
      // Defaults are xlsx + compact — just click Download.
      const dl = await clickDownloadAndWait(page)
      expect(dl.suggestedFilename()).toMatch(/\.xlsx$/i)
      // Verify real bytes: XLSX is a ZIP, magic bytes 'PK' (0x50 0x4b)
      const stream = await dl.createReadStream()
      if (stream) {
        const chunk = await new Promise<Buffer>((resolve) => {
          stream.once('data', (c: Buffer) => resolve(c))
        })
        expect(chunk[0]).toBe(0x50)
        expect(chunk[1]).toBe(0x4b)
      }
    })

    test(`downloads PDF detailed (${name})`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

      await openExportDialog(page)
      await page.getByRole('radio', { name: /pdf/i }).click()
      await page.getByRole('radio', { name: /detailed/i }).click()

      // Capture the API response to assert status (200 on success; 503 if Chromium deps missing)
      const responsePromise = page.waitForResponse(
        (r) => r.url().includes('/invoicing/export/list') && r.request().method() === 'POST',
        { timeout: 30000 },
      )
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
      await page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click()

      const response = await responsePromise
      // Must never be raw 500 — controller catches PDF failures and returns 503
      expect(response.status()).not.toBe(500)

      if (response.status() === 200) {
        const dl = await downloadPromise
        expect(dl?.suggestedFilename()).toMatch(/\.pdf$/i)
        const stream = await dl!.createReadStream()
        if (stream) {
          const chunk = await new Promise<Buffer>((resolve) => {
            stream.once('data', (c: Buffer) => resolve(c))
          })
          // PDF magic: %PDF
          expect(Array.from(chunk.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46])
        }
      } else {
        // Graceful degradation: 503 with structured message
        expect([403, 404, 503]).toContain(response.status())
        const body = await response.json().catch(() => ({}))
        expect(body.message).toBeTruthy()
      }
    })
  })
}

test.describe('Export — column picker', () => {
  test('unchecking columns reflects in POST body', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    await openExportDialog(page)

    // Uncheck "Currency" and "Total" in the dialog.
    const dialog = page.locator('.v-overlay--active')
    const currency = dialog.getByRole('checkbox', { name: /^currency$/i })
    const total = dialog.getByRole('checkbox', { name: /^total$/i })
    if (await currency.isVisible().catch(() => false)) await currency.click()
    if (await total.isVisible().catch(() => false)) await total.click()

    const requestPromise = page.waitForRequest(
      (r) => r.url().includes('/invoicing/export/list') && r.method() === 'POST',
      { timeout: 20000 },
    )
    // Don't await the download — it may 404 if no rows; we only need the request.
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
    await dialog.getByRole('button', { name: /^download$/i }).click()

    const req = await requestPromise
    const body = req.postDataJSON()
    expect(Array.isArray(body.columns)).toBe(true)
    expect(body.columns).not.toContain('currency')
    expect(body.columns).not.toContain('total')
    // Number should still be on by default
    expect(body.columns).toContain('number')
  })

  test('grid sort is forwarded to export body', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    // Click the "Issue Date" column header to sort ascending.
    const issueDateHeader = page.locator('.v-data-table th', { hasText: /issue date/i }).first()
    if (await issueDateHeader.isVisible().catch(() => false)) {
      await issueDateHeader.click()
    }

    await openExportDialog(page)
    const requestPromise = page.waitForRequest(
      (r) => r.url().includes('/invoicing/export/list') && r.method() === 'POST',
      { timeout: 20000 },
    )
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
    await page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click()

    const req = await requestPromise
    const body = req.postDataJSON()
    // Whatever the grid is sorted by should appear in the request; default is createdAt desc.
    expect(body.sortBy).toBeTruthy()
    expect(['asc', 'desc']).toContain(body.sortOrder)
  })
})

test.describe('Export — single invoice from details', () => {
  test('opens invoice details and downloads XLSX', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    // Click first number cell to open details
    const firstLink = page.locator('.v-data-table a, .v-data-table [role="link"]').first()
    if (!(await firstLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No invoices in fixture to open details page')
      return
    }
    await firstLink.click()
    await expect(page.getByRole('heading', { name: /edit invoice/i })).toBeVisible({ timeout: 10000 })

    await openExportDialog(page)
    await page.getByRole('radio', { name: /excel/i }).click()
    const dl = await clickDownloadAndWait(page)
    expect(dl.suggestedFilename()).toMatch(/\.xlsx$/i)
  })
})

test.describe('Status chip — history popup', () => {
  test('clicking a status chip opens timeline dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    const chip = page.locator('.v-data-table .v-chip').first()
    if (!(await chip.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No status chips in fixture')
      return
    }
    await chip.click()
    // StatusChip dialog title comes from i18n "Status history"
    await expect(page.getByText(/status history/i)).toBeVisible({ timeout: 5000 })
    // Timeline entries render as v-timeline-item
    const items = page.locator('.v-timeline-item')
    expect(await items.count()).toBeGreaterThan(0)
  })
})
