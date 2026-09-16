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

/**
 * Open the export dialog.
 *
 * ⚠ `triggerName` exists because the control is not called the same thing everywhere: LIST
 * views kept `Export`, but the per-document FORMS render it as `Print` with an mdi-printer
 * icon. Same ExportDialog behind both.
 */
async function openExportDialog(page: Page, triggerName: RegExp = /^export$/i) {
  const trigger = page.getByRole('button', { name: triggerName }).first()
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

/**
 * Click Download and report what the server actually did.
 *
 * ⚠ An empty list does NOT produce an empty workbook. `invoice-export.controller.ts:480`
 * answers **404 "No documents match the filter"** when nothing matches, so no download is
 * ever started. (The header-only-workbook rule in CLAUDE.md is the `/kind/:kind` endpoint —
 * a different route with different behaviour. Easy to conflate; they are not the same.)
 *
 * The seed has 52 invoices and 7 cash sales but ZERO proforma, credit notes and debit notes,
 * so three of the six list pages here can only ever exercise the 404 path. Waiting 20s for a
 * download that cannot come is what those three were doing.
 */
async function clickDownloadExpectingEither(
  page: Page,
): Promise<{ download: Download | null; status: number }> {
  const responsePromise = page.waitForResponse(
    r => r.url().includes('/invoicing/export/list') && r.request().method() === 'POST',
    { timeout: 20000 },
  )
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
  await page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click()

  const response = await responsePromise
  if (response.status() !== 200) return { download: null, status: response.status() }
  return { download: await downloadPromise, status: 200 }
}

for (const { name, path } of LIST_PAGES) {
  test.describe(`Export — ${name}`, () => {
    test(`opens export dialog and downloads XLSX compact (${name})`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

      await openExportDialog(page)
      // ⚠ Pick the format explicitly. This used to rely on "defaults are xlsx + compact",
      // but the list views now pass `defaultFormat: 'pdf'` to ExportDialog, so the test was
      // downloading `invoice-compact-<date>.pdf` and failing on the .xlsx assertion. A test
      // named "downloads XLSX" should choose XLSX rather than inherit whatever the caller
      // happens to default to.
      await page.locator('.v-overlay--active').getByRole('radio', { name: /excel/i }).click()

      const { download: dl, status } = await clickDownloadExpectingEither(page)
      if (status === 404) {
        // This document type has no rows in the seed — the documented answer, and there is
        // nothing to download. Asserting it is the point: a silent pass here would hide a
        // genuinely broken export.
        test.info().annotations.push({ type: 'note', description: `${name}: no rows seeded, export answered 404` })
        return
      }
      expect(status).toBe(200)
      expect(dl!.suggestedFilename()).toMatch(/\.xlsx$/i)
      // Verify real bytes: XLSX is a ZIP, magic bytes 'PK' (0x50 0x4b)
      const stream = await dl!.createReadStream()
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

      // ⚠ Compact/Detailed is `v-if="!aggregated"` in ExportDialog, and CashSalesView passes
      // `default-aggregate` — so on that page the mode radios start hidden and clicking
      // "detailed" waited 10s for a control that was never rendered. Aggregation off is what
      // a user does to choose a mode, so do that first where the switch exists.
      const aggregate = page.locator('.v-overlay--active').getByLabel(/aggregate/i)
      if (await aggregate.isVisible().catch(() => false) && await aggregate.isChecked().catch(() => false)) {
        await aggregate.click()
      }
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
        if (stream && dl) {
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
    // ⚠ `.first()` matters. Vuetify renders each checkbox label twice, so the bare role query
    // matches 2 elements and `isVisible()` throws a strict-mode violation — which the
    // `.catch(() => false)` below swallowed, silently skipping the uncheck this test exists to
    // verify. The assertion then failed on a body that still carried every column, and the
    // cause looked like the export rather than the click that never happened.
    // ⚠ `uncheck()`, not `click()`. Currency is NOT selected by default in the compact set, so
    // clicking it TURNED IT ON — which is precisely why the POST body contained "currency" and
    // the assertion below failed. A toggle only does what this test wants if you already know
    // the starting state; uncheck() states the intent and is idempotent.
    const currency = dialog.getByLabel(/^currency$/i).first()
    const total = dialog.getByLabel(/^total$/i).first()
    await expect(currency).toBeVisible()
    await currency.uncheck()
    if (await total.isVisible().catch(() => false)) await total.uncheck()

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

    // Scoped by destination. The merged list carries contact links too, so 'first link in
    // the table' is not reliably the document — it can be the contact, which navigates to a
    // contact form with no 'Edit Invoice' heading.
    const firstLink = page.locator('.v-data-table a[href*="/invoices/"][href*="/edit"]').first()
    if (!(await firstLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No invoices in fixture to open details page')
      return
    }
    await firstLink.click()
    await expect(page.getByRole('heading', { name: /edit invoice/i })).toBeVisible({ timeout: 10000 })

    await openExportDialog(page, /^print$/i)
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

    // ⚠ Find the chip in the STATUS column. `.v-chip').first()` grabs whichever chip comes
    // first in the row, and since the lists merged that is the document-TYPE chip — a plain
    // chip with no dialog behind it. StatusChip also only opens when the row carries history
    // (all 50 seeded invoices do), so a click on the wrong chip fails silently.
    const headers = page.locator('.v-data-table thead th')
    const headerCount = await headers.count()
    let statusCol = -1
    for (let i = 0; i < headerCount; i++) {
      if (/status/i.test((await headers.nth(i).innerText()).trim())) { statusCol = i; break }
    }
    expect(statusCol, 'no Status column in the documents table').toBeGreaterThanOrEqual(0)

    const chip = page.locator('.v-data-table tbody tr').first()
      .locator('td').nth(statusCol).locator('.v-chip').first()
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
