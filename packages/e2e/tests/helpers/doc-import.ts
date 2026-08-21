import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Helpers for the document-import specs.
 *
 * These live here rather than in the spec because `import type` from `@playwright/test`
 * builds in a helper module but not in a spec file under this Playwright/Bun setup — which
 * is why no spec in this repo type-imports either.
 */

/** A minimal but structurally valid PDF — the OCR stub keys off the filename, not the bytes. */
export const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
)

/** Click the list/form Import button and wait for the dialog's first step. */
export async function openImportDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^import$/i }).first().click()
  const dialog = page.locator('.v-dialog').filter({ hasText: /upload/i })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  return dialog
}

/** Attach a fixture and run the extraction step, waiting for its per-file panel. */
export async function uploadAndExtract(dialog: Locator, filename: string): Promise<void> {
  await dialog.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: TINY_PDF,
  })
  await dialog.getByRole('button', { name: /extract text/i }).click()
  // The extracted-text panel appears once the file has been read.
  await expect(dialog.locator('.v-expansion-panel-title').filter({ hasText: filename }))
    .toBeVisible({ timeout: 30000 })
}
