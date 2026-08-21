import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openImportDialog, uploadAndExtract } from './helpers/doc-import'

/**
 * Document import — the Import button on a list page, and single-document import onto an
 * open form.
 *
 * These specs need the OCR sidecar to be deterministic, so they run against the stub:
 *
 *   bun packages/e2e/scripts/ocr-stub.ts &
 *   cd packages/portal-api && OCR_SERVER_URL=http://localhost:8199 bun src/unified.ts
 *   cd packages/e2e && bunx playwright test --project=doc-import
 *
 * (The API must be started from `packages/portal-api` — it resolves the built UI dists
 * relative to its own directory.)
 *
 * ⚠ Playwright needs **Node** on PATH: its workers are spawned with `process.execPath`, so
 * running the CLI under `bunx` on a machine without Node kills every worker with
 * `code=143` before the browser launches. That affects every spec in this package, not
 * just this one.
 *
 * Without a reachable sidecar the analyze step reports a per-file error rather than
 * hanging, so a misconfigured run fails fast and legibly instead of timing out.
 */

test.describe('Document import — batch', () => {
  test('imports a supplier invoice from the Bills list into a document', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 15000 })

    const dialog = await openImportDialog(page)
    await uploadAndExtract(dialog, 'e2e-bill.pdf')

    await dialog.getByRole('button', { name: /analyze/i }).click()

    // Analysis is a background job; the review table appears when it completes.
    const row = dialog.locator('tr', { hasText: 'e2e-bill.pdf' })
    await expect(row).toBeVisible({ timeout: 120000 })
    await expect(row).toContainText('2000122757')

    await dialog.getByRole('button', { name: /^import 1$/i }).click()
    await expect(dialog.getByText(/document\(s\) created/i)).toBeVisible({ timeout: 120000 })
  })

  test('shows the Import button on every surface that accepts documents', async ({ page }) => {
    await loginForApp(page)
    for (const path of ['/invoicing/invoices', '/invoicing/bills', '/invoicing/cash-sales', '/inventory/movements']) {
      await page.goto(path)
      await expect(page.getByRole('button', { name: /^import$/i }).first()).toBeVisible({ timeout: 15000 })
    }
  })

  test('the retired standalone import page redirects to the Bills list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/import')
    await page.waitForURL('**/invoicing/bills')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 15000 })
  })
})

test.describe('Document import — single document onto an open form', () => {
  test('applies only the checked fields and leaves the rest of the form alone', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 15000 })

    // A value the user typed themselves, which an unchecked field must not overwrite.
    const notes = page.getByLabel(/notes/i).first()
    await notes.fill('KEEP THIS NOTE')

    const dialog = await openImportDialog(page)
    await uploadAndExtract(dialog, 'e2e-bill.pdf')
    await dialog.getByRole('button', { name: /analyze/i }).click()

    // The field diff lists what would change.
    const diffRow = dialog.locator('tr', { hasText: /supplier invoice/i })
    await expect(diffRow).toBeVisible({ timeout: 120000 })
    await expect(diffRow).toContainText('2000122757')

    // Uncheck Notes so the typed value survives.
    const notesRow = dialog.locator('tr').filter({ hasText: /^\s*Notes/ }).first()
    await notesRow.locator('input[type="checkbox"]').uncheck()

    await dialog.getByRole('button', { name: /apply to form/i }).click()
    await expect(dialog).toBeHidden({ timeout: 10000 })

    // Applied: the supplier's document number. Not applied: the note we unchecked.
    await expect(page.getByLabel(/supplier invoice/i)).toHaveValue('2000122757')
    await expect(notes).toHaveValue('KEEP THIS NOTE')
    // Nothing was persisted — the form is still unsaved and Save is still offered.
    await expect(page.getByRole('button', { name: /^save$/i }).first()).toBeVisible()
  })
})
