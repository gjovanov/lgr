import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiPost, apiGet, type ApiSession } from './helpers/api'

/**
 * A product's category is stored twice: `categoryId`, which the form's field edits, and the
 * `category` name that lists, reports and imports read. The acme seed's articles carry only the
 * name, as does every article of the `regal` org on prod. The field cannot show such a name, and
 * saving the form used to write `category: ''`, erasing it.
 */

async function createProduct(s: ApiSession, category: string): Promise<{ id: string; name: string }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const name = `Category keep ${stamp}`
  const res = await apiPost(s, '/warehouse/product/', { sku: `E2E-CAT-${stamp}`, name, category, type: 'goods', unit: 'pcs' })
  expect(res.ok, `create product: ${res.status}`).toBe(true)
  const { product } = await res.json()
  return { id: product._id || product.id, name }
}

/** Open the article and wait until the form holds it, so Save sends the loaded article. */
async function openProduct(page: Page, p: { id: string; name: string }) {
  await page.goto(`/inventory/products/${p.id}/edit`)
  await expect(page.getByRole('textbox', { name: /^name$/i })).toHaveValue(p.name, { timeout: 10000 })
}

async function readProduct(s: ApiSession, id: string): Promise<any> {
  const data = await apiGet(s, `/warehouse/product/${id}`)
  return data.product || data
}

async function save(page: Page) {
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page.getByText(/saved successfully/i).first()).toBeVisible({ timeout: 10000 })
}

test.describe('Product form: category', () => {
  test('a name no category carries is shown, and kept on save', async ({ page }) => {
    const s = await apiLogin()
    const name = `E2E bare name ${Date.now()}`
    const p = await createProduct(s, name)

    await loginForApp(page)
    await openProduct(page, p)
    await save(page)
    const after = await readProduct(s, p.id)
    expect(after.category).toBe(name)
    expect(after.categoryId ?? null).toBeNull()
    // …and the field says what the article has.
    await expect(page.getByRole('combobox', { name: /category/i })).toHaveAttribute('placeholder', name)
  })

  test('a name one category carries is linked on save; clearing the field drops it', async ({ page }) => {
    const s = await apiLogin()
    const name = `E2E linked ${Date.now()}`
    const catRes = await apiPost(s, '/warehouse/product-category/', { name })
    expect(catRes.ok, `create category: ${catRes.status}`).toBe(true)
    const { productCategory } = await catRes.json()
    const categoryId = String(productCategory._id || productCategory.id)
    const p = await createProduct(s, name)
    const id = p.id

    await loginForApp(page)
    await openProduct(page, p)
    const field = page.getByRole('combobox', { name: /category/i })
    // Linked on load: the field shows the category itself, not a placeholder.
    await expect(page.locator('.v-autocomplete__selection').filter({ hasText: name })).toBeVisible()

    await save(page)
    const linked = await readProduct(s, id)
    expect(String(linked.categoryId)).toBe(categoryId)
    expect(linked.category).toBe(name)

    // Clearing the field is the one way to drop the name.
    await field.click()
    await page.getByLabel(/clear category/i).click()
    await page.keyboard.press('Escape')
    await save(page)
    const cleared = await readProduct(s, id)
    expect(cleared.category ?? '').toBe('')
    expect(cleared.categoryId ?? null).toBeNull()
  })
})
