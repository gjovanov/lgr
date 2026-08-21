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

/**
 * Click the Import button and wait for the dialog's first step.
 *
 * A list page's button says "Import" (`docImport.importBtn`); a form's says "Import from
 * file" (`docImport.importFile`) so it doesn't read as "import this document somewhere".
 */
export async function openImportDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^import( from file)?$/i }).first().click()
  const dialog = page.locator('.v-dialog').filter({ hasText: /upload/i })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  return dialog
}

/**
 * Delete any document the stub's fixed number left behind.
 *
 * The OCR stub always reports document 2000122757, and duplicate detection is doing its job
 * when it refuses the second import — so a repeatable spec has to start from a clean slate.
 * Only drafts can be deleted; an issued one is reported so the failure is legible.
 */
export async function cleanupImportedDoc(page: Page, reference = '2000122757'): Promise<void> {
  // The app authenticates with a Bearer token held in localStorage, not a cookie — so
  // `page.request` is anonymous unless the header is set explicitly.
  const token = await page.evaluate(() => localStorage.getItem('lgr_token'))
  if (!token) throw new Error('cleanupImportedDoc: no lgr_token — call loginForApp first')
  const headers = { authorization: `Bearer ${token}` }

  const me = await page.request.get('/api/auth/me', { headers })
  if (!me.ok()) throw new Error(`cleanupImportedDoc: /auth/me → ${me.status()}`)
  const orgId = (await me.json())?.org?.id
  if (!orgId) throw new Error('cleanupImportedDoc: no orgId on /auth/me')

  const res = await page.request.get(`/api/org/${orgId}/invoices?size=50&search=${reference}`, { headers })
  if (!res.ok()) throw new Error(`cleanupImportedDoc: invoice list → ${res.status()}`)
  for (const inv of (await res.json())?.invoices || []) {
    if (String(inv.reference) !== reference) continue
    if (inv.status !== 'draft') {
      // eslint-disable-next-line no-console
      console.warn(`[doc-import] ${inv.invoiceNumber} is ${inv.status}, not a draft — cannot clean up`)
      continue
    }
    await page.request.delete(`/api/org/${orgId}/invoices/${inv._id}`, { headers })
  }
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
