import { test, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { loginForApp } from './helpers/login'
import { apiLogin } from './helpers/api'
import { openImportDialog, uploadAndExtract, cleanupImportedDoc } from './helpers/doc-import'

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
    // The stub reports a fixed document number, and importing it twice is correctly
    // refused — so clear any document a previous run created.
    await cleanupImportedDoc(page)

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

    // Leave the tenant as we found it, so the next run starts clean too.
    await cleanupImportedDoc(page)
  })

  // #324: from the cash-sales list the dialog sent no warehouse and dropped the spreadsheet's parse,
  // so a till day never imported through it. A spreadsheet needs no OCR stub.
  test('imports a till day (salesAnalysis XLSX) from the Cash Sales list, from the chosen warehouse', async ({ page }) => {
    const API = process.env.BASE_URL || 'http://localhost:4001'
    const admin = await apiLogin()
    const get = async (path: string) => {
      const res = await fetch(`${API}/api/org/${admin.orgId}${path}`, { headers: { Authorization: `Bearer ${admin.token}` } })
      expect(res.ok, `GET ${path} → ${res.status}`).toBe(true)
      return res.json()
    }
    // The warehouse the dialog preselects (the default one), and an article with stock there.
    const { warehouses } = await get('/warehouse/warehouse?size=1000')
    const wh = warehouses.find((w: any) => w.isDefault) || warehouses[0]
    const whId = String(wh._id || wh.id)
    const { products } = await get(`/trade/pos/catalog?warehouseId=${whId}&type=goods&size=100`)
    const product = products.find((p: any) => (p.stockAvailable ?? 0) >= 1 && p.unitPrice > 0)
    expect(product, 'no article with stock in the default warehouse — is the DB seeded?').toBeTruthy()

    // A day of its own each run: the day is the cash sale's identity (`salesAnalysis:<date>`).
    const d = new Date(Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 365) * 86400_000)
    const iso = d.toISOString().slice(0, 10)
    const [y, m, dd] = iso.split('-')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.getRow(1).getCell(1).value = 'АРТИКУЛИ'
    ws.getRow(3).getCell(1).value = `Период: ${dd}.${m}.${y} - ${dd}.${m}.${y}`
    ws.getRow(9).values = ['Артикул', 'Количество', 'Стойност']
    ws.getRow(10).values = [product.productName, 1, product.unitPrice]
    ws.getRow(11).values = ['Общо', 1, product.unitPrice]
    const filename = `salesAnalysis_${y}${m}${dd}_180000.xlsx`

    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    const dialog = await openImportDialog(page)
    // The dialog asks where the day's goods leave from, and starts on the default warehouse.
    await expect(dialog.getByText(/the day's sales leave this warehouse/i)).toBeVisible()
    await dialog.locator('input[type="file"]').setInputFiles({
      name: filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    })
    await dialog.getByRole('button', { name: /extract text/i }).click()
    await expect(dialog.locator('.v-expansion-panel-title').filter({ hasText: filename })).toBeVisible({ timeout: 30000 })

    await dialog.getByRole('button', { name: /analyze/i }).click()
    const row = dialog.locator('tr', { hasText: filename })
    await expect(row).toBeVisible({ timeout: 60000 })
    await expect(row).toContainText(`salesAnalysis:${iso}`)
    await dialog.getByRole('button', { name: /^import 1$/i }).click()
    await expect(dialog.getByText(/document\(s\) created/i)).toBeVisible({ timeout: 60000 })

    // One cash sale for that day, its line in the chosen warehouse.
    const { invoices } = await get('/invoices?type=cash_sale&size=500')
    const day = invoices.filter((i: any) => i.reference === `salesAnalysis:${iso}`)
    expect(day).toHaveLength(1)
    expect(day[0].lines.map((l: any) => String(l.warehouseId))).toEqual([whId])
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
    // A bill labels its notes textarea "Reason" (config.notesFieldLabelKey), even though it
    // still binds `form.notes` — and the diff panel now uses that same label.
    const notes = page.getByLabel(/reason/i).first()
    await notes.fill('KEEP THIS NOTE')

    const dialog = await openImportDialog(page)
    await uploadAndExtract(dialog, 'e2e-bill.pdf')
    await dialog.getByRole('button', { name: /analyze/i }).click()

    // The field diff lists what would change.
    const diffRow = dialog.locator('tr', { hasText: /supplier invoice/i })
    await expect(diffRow).toBeVisible({ timeout: 120000 })
    await expect(diffRow).toContainText('2000122757')

    // Uncheck it so the typed value survives.
    const notesRow = dialog.locator('tr').filter({ hasText: /Reason/ }).first()
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
