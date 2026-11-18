import { test, expect, type Page, type Request } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { activeContact, apiLogin, apiPost } from './helpers/api'

/**
 * FR-30 slice B (#795): what a list and a document cost in requests.
 *
 * - FR-30.6: opening a list sends its list request once, by a full load and by a move inside the app. Vuetify's table
 *   asks for its page when it mounts and the view asks again in `onMounted`; 12 of the 14 lists the audit opened sent
 *   the same request twice.
 * - FR-30.10: a saved document of 30 lines opens with as many API requests as one of 3 lines, and at most 15; the
 *   document itself is read once. It took 70 for 30 lines: a whole article per line for its name, and a line's price
 *   options per line, which a loaded line does not need until its price control is opened.
 * - FR-30.9: a remembered or bookmarked "All" (`size=-1`) opens the list at the largest page size, and "All" is
 *   offered only while the list's total is within the ceiling of an answer (1 000 rows).
 */

/** The API requests a page makes while `run` runs, until the network has been quiet a moment. */
async function apiRequests(page: Page, run: () => Promise<unknown>): Promise<Request[]> {
  const seen: Request[] = []
  const on = (r: Request) => { if (new URL(r.url()).pathname.startsWith('/api/')) seen.push(r) }
  page.on('request', on)
  try {
    await run()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')
  } finally {
    page.off('request', on)
  }
  return seen
}

const LISTS: { name: string; path: string; endpoint: RegExp }[] = [
  { name: 'Sales invoices', path: '/invoicing/invoices', endpoint: /\/invoices$/ },
  { name: 'Bills', path: '/invoicing/bills', endpoint: /\/invoices$/ },
  { name: 'Proforma', path: '/invoicing/proforma', endpoint: /\/invoices$/ },
  { name: 'Offers', path: '/invoicing/offer', endpoint: /\/invoices$/ },
  { name: 'Contacts', path: '/invoicing/contacts', endpoint: /\/invoicing\/contact$/ },
  { name: 'Products', path: '/inventory/products', endpoint: /\/warehouse\/product$/ },
  { name: 'Stock levels', path: '/inventory/stock-levels', endpoint: /\/warehouse\/stock-level$/ },
  { name: 'Movements', path: '/inventory/movements', endpoint: /\/warehouse\/movement$/ },
  { name: 'Warehouses', path: '/inventory/warehouses', endpoint: /\/warehouse\/warehouse$/ },
  { name: 'Inventory counts', path: '/inventory/inventory-counts', endpoint: /\/warehouse\/inventory-count$/ },
  { name: 'Orders', path: '/invoicing/orders', endpoint: /\/invoicing\/orders$/ },
  { name: 'Internal orders', path: '/invoicing/internal-orders', endpoint: /\/invoicing\/internal-orders$/ },
  { name: 'Reservations', path: '/invoicing/reservations', endpoint: /\/invoicing\/reservations$/ },
  { name: 'Payment orders', path: '/invoicing/payment-orders', endpoint: /\/invoicing\/payment-order$/ },
  { name: 'Cash orders', path: '/invoicing/cash-orders', endpoint: /\/invoicing\/cash-order$/ },
]

const listCalls = (requests: Request[], endpoint: RegExp) => requests.filter((r) => endpoint.test(new URL(r.url()).pathname))

test.describe('FR-30.6: one request per list open', () => {
  test('each list asks for its rows once on a full load, and once on a move inside the app', async ({ page }) => {
    test.setTimeout(240_000)
    await loginForApp(page)
    const counts: Record<string, { load: number; move: number }> = {}
    for (const list of LISTS) {
      const load = await apiRequests(page, () => page.goto(list.path))
      // A move inside the app: the router, from a page of another module.
      await page.goto('/accounting/')
      await page.waitForLoadState('networkidle')
      const move = await apiRequests(page, () => page.evaluate((to) => {
        const a = document.createElement('a')
        a.href = to
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, list.path))
      counts[list.name] = { load: listCalls(load, list.endpoint).length, move: listCalls(move, list.endpoint).length }
    }
    expect(counts).toEqual(Object.fromEntries(LISTS.map((l) => [l.name, { load: 1, move: 1 }])))
  })

  test('the grids ask for rows (`fields=list`), and the rows carry no lines', async ({ page }) => {
    await loginForApp(page)
    const answer = page.waitForResponse((r) => /\/invoices\?/.test(r.url()) && r.request().method() === 'GET')
    await page.goto('/invoicing/invoices')
    const res = await answer
    expect(new URL(res.url()).searchParams.get('fields')).toBe('list')
    const body = await res.json()
    expect(body.invoices.length).toBeGreaterThan(0)
    expect(body.invoices.some((i: any) => 'lines' in i)).toBe(false)
  })
})

test.describe('FR-30.10: a document opens with a fixed number of requests', () => {
  async function savedInvoice(lines: number): Promise<string> {
    const session = await apiLogin()
    const contact = await activeContact(session, 'customer')
    const ts = `${Date.now().toString(36)}-${lines}`
    const products: { _id: string; name: string }[] = []
    for (let i = 0; i < lines; i++) {
      const res = await apiPost(session, '/warehouse/product', {
        sku: `E2E-REQ-${ts}-${i}`, name: `Req${ts} article ${i}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 10 + i, taxRate: 20,
      })
      expect(res.ok).toBe(true)
      const { product } = await res.json()
      products.push({ _id: String(product._id || product.id), name: product.name })
    }
    const docLines = products.map((p, i) => ({
      productId: p._id, description: p.name, quantity: 1, unit: 'pcs', unitPrice: 10 + i, discount: 0, taxRate: 20,
      taxAmount: +((10 + i) * 0.2).toFixed(2), lineTotal: +((10 + i) * 1.2).toFixed(2),
    }))
    const subtotal = docLines.reduce((s, l) => s + l.unitPrice, 0)
    const taxTotal = +docLines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
    const res = await apiPost(session, '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: contact._id, issueDate: new Date().toISOString().split('T')[0],
      currency: 'EUR', exchangeRate: 1, paymentMethod: 'bank_transfer', lines: docLines,
      subtotal, discountTotal: 0, taxTotal, total: +(subtotal + taxTotal).toFixed(2),
    })
    expect(res.status).toBeLessThan(300)
    const { invoice } = await res.json()
    return String(invoice.id || invoice._id)
  }

  test('a saved invoice of 30 lines opens with as many requests as one of 3, at most 15, and is read once', async ({ page }) => {
    test.setTimeout(120_000)
    const three = await savedInvoice(3)
    const thirty = await savedInvoice(30)
    await loginForApp(page)
    // The shell's own first requests are paid once, before either document opens.
    await page.goto('/invoicing/invoices')
    await page.waitForLoadState('networkidle')

    const open = async (id: string) => apiRequests(page, async () => {
      await page.evaluate((to) => {
        const a = document.createElement('a')
        a.href = to
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, `/invoicing/invoices/${id}/edit`)
      await expect(page.locator('.v-table tbody tr').nth(2)).toBeVisible({ timeout: 15000 })
    })
    const docReads = (rs: Request[], id: string) => rs.filter((r) => new URL(r.url()).pathname.endsWith(`/invoices/${id}`) && r.method() === 'GET').length
    const describe = (rs: Request[]) => rs.map((r) => `${r.method()} ${new URL(r.url()).pathname}`).sort()

    const small = await open(three)
    await page.goto('/invoicing/invoices')
    await page.waitForLoadState('networkidle')
    const large = await open(thirty)

    test.info().annotations.push({ type: 'requests', description: `3 lines: ${small.length}, 30 lines: ${large.length}` })
    console.log(`FR-30.10 requests: 3 lines ${small.length}, 30 lines ${large.length}`)
    expect({ three: docReads(small, three), thirty: docReads(large, thirty) }).toEqual({ three: 1, thirty: 1 })
    expect(large.length, describe(large).join('\n')).toBe(small.length)
    expect(large.length, describe(large).join('\n')).toBeLessThanOrEqual(15)
    // No article is read one by one, and no line's price options until its price control is opened.
    expect(large.filter((r) => /\/warehouse\/product\/[0-9a-f]{24}$/.test(new URL(r.url()).pathname))).toHaveLength(0)
    expect(large.filter((r) => /\/pricing\/options/.test(new URL(r.url()).pathname))).toHaveLength(0)

    // Each line shows its article, and opening a line's price asks for that line's options.
    await expect(page.locator('.v-table tbody tr').first()).toContainText('article 0')
    const options = page.waitForRequest((r) => /\/pricing\/options/.test(r.url()))
    await page.locator('[data-testid="price-combobox"]').first().click()
    await options
  })
})

test.describe('FR-30.9: "All" in the browser', () => {
  test('a bookmarked size=-1 opens the list at the largest page size', async ({ page }) => {
    await loginForApp(page)
    const answer = page.waitForRequest((r) => /\/invoicing\/contact\?/.test(r.url()))
    await page.goto('/invoicing/contacts?size=-1')
    const req = await answer
    expect(new URL(req.url()).searchParams.get('size')).toBe('100')
  })

  test('"All" is offered while the total is within the ceiling, and not above it', async ({ page }) => {
    await loginForApp(page)
    let total: number | null = null
    await page.route('**/invoicing/contact?*', async (route) => {
      if (total === null) return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, total, totalPages: Math.ceil(total / 10) } })
    })
    const sizeMenu = async () => {
      await page.locator('.v-data-table-footer__items-per-page .v-select').click()
      const items = await page.locator('.v-overlay--active .v-list-item').allTextContents()
      await page.keyboard.press('Escape')
      return items.map((s) => s.trim())
    }

    total = 900
    await page.goto('/invoicing/contacts')
    await expect(page.locator('.v-data-table-footer')).toBeVisible()
    expect(await sizeMenu()).toContain('All')

    total = 1001
    await page.goto('/accounting/')
    await page.goto('/invoicing/contacts')
    await expect(page.locator('.v-data-table-footer')).toBeVisible()
    expect(await sizeMenu()).not.toContain('All')
  })
})
