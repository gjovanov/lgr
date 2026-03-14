import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

async function getAuthToken(org = 'acme-corp', username = 'admin', password = 'test123') {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await res.json()
  return { token: data.token, orgId: data.org?.id || data.org?._id }
}

async function apiCall(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

test.describe('Tag-Based Pricing — API Tests', () => {
  let token: string
  let orgId: string

  test.beforeAll(async () => {
    const auth = await getAuthToken()
    token = auth.token
    orgId = auth.orgId
  })

  test('full scenario: product with tag prices, contact with matching tag', async () => {
    const ts = Date.now()

    // 1. Create product "Rozi Test" with two tag prices
    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `ROZI-${ts}`,
      name: `Rozi Test ${ts}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 100,
      taxRate: 18,
      tagPrices: [
        { name: 'Price1', tag: 'loyal', price: 80 },
        { name: 'Price2', tag: 'high volume', price: 70 },
      ],
    })
    const productId = productData.product?.id || productData.product?._id
    expect(productId).toBeTruthy()

    // 2. Verify product was saved with tagPrices
    const fetchedProduct = await apiCall('GET', `/org/${orgId}/warehouse/product/${productId}`, token)
    const product = fetchedProduct.product
    expect(product.tagPrices).toHaveLength(2)
    expect(product.tagPrices[0].name).toBe('Price1')
    expect(product.tagPrices[0].tag).toBe('loyal')
    expect(product.tagPrices[1].name).toBe('Price2')
    expect(product.tagPrices[1].tag).toBe('high volume')

    // 3. Create contact "Venusart e.U." with tag 'high volume'
    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `Venusart-${ts}`,
      email: `venusart-${ts}@test.com`,
      tags: ['high volume'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '1 Main', city: 'Vienna', postalCode: '1010', country: 'AT', isDefault: true }],
    })
    const contactId = contactData.contact?.id || contactData.contact?._id
    expect(contactId).toBeTruthy()

    // 4. Resolve price — should match 'high volume' tag
    const resolution = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}&contactId=${contactId}`,
      token,
    )

    expect(resolution.finalPrice).toBe(70)
    expect(resolution.steps).toHaveLength(2)
    expect(resolution.steps[0]).toEqual({ type: 'base', label: 'Selling price', price: 100 })
    expect(resolution.steps[1]).toEqual({ type: 'tag', label: 'Price2', price: 70 })
  })

  test('resolve returns base price for contact without matching tags', async () => {
    const ts = Date.now()

    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `NOTAG-${ts}`,
      name: `NoTag Product ${ts}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 50,
      taxRate: 18,
      tagPrices: [{ name: 'VIP', tag: 'vip', price: 40 }],
    })
    const productId = productData.product?.id || productData.product?._id

    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `Regular-${ts}`,
      email: `regular-${ts}@test.com`,
      tags: ['normal'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '1 St', city: 'X', postalCode: '0000', country: 'AT', isDefault: true }],
    })
    const contactId = contactData.contact?.id || contactData.contact?._id

    const resolution = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}&contactId=${contactId}`,
      token,
    )

    expect(resolution.finalPrice).toBe(50)
    expect(resolution.steps).toHaveLength(1)
  })

  test('resolve picks lowest when contact has multiple matching tags', async () => {
    const ts = Date.now()

    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `MULTI-${ts}`,
      name: `Multi Tag ${ts}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 100,
      taxRate: 18,
      tagPrices: [
        { name: 'Loyal Rate', tag: 'loyal', price: 80 },
        { name: 'Volume Rate', tag: 'high volume', price: 70 },
      ],
    })
    const productId = productData.product?.id || productData.product?._id

    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `BothTags-${ts}`,
      email: `both-${ts}@test.com`,
      tags: ['loyal', 'high volume'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '1 St', city: 'X', postalCode: '0000', country: 'AT', isDefault: true }],
    })
    const contactId = contactData.contact?.id || contactData.contact?._id

    const resolution = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}&contactId=${contactId}`,
      token,
    )

    expect(resolution.finalPrice).toBe(70)
    expect(resolution.steps[1].label).toBe('Volume Rate')
  })

  test('contact-specific price overrides tag price', async () => {
    const ts = Date.now()

    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `Special-${ts}`,
      email: `special-${ts}@test.com`,
      tags: ['high volume'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '1 St', city: 'X', postalCode: '0000', country: 'AT', isDefault: true }],
    })
    const contactId = contactData.contact?.id || contactData.contact?._id

    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `OVERRIDE-${ts}`,
      name: `Override Test ${ts}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 100,
      taxRate: 18,
      tagPrices: [{ name: 'Volume', tag: 'high volume', price: 70 }],
      customPrices: [{ name: 'VIP Deal', contactId, price: 60 }],
    })
    const productId = productData.product?.id || productData.product?._id

    const resolution = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}&contactId=${contactId}`,
      token,
    )

    expect(resolution.finalPrice).toBe(60)
    expect(resolution.steps).toHaveLength(3)
    expect(resolution.steps.map((s: any) => s.type)).toEqual(['base', 'tag', 'contact'])
    expect(resolution.steps.map((s: any) => s.price)).toEqual([100, 70, 60])
  })

  test('invoice with tag-priced line persists priceExplanation', async () => {
    const ts = Date.now()

    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `PERSIST-${ts}`,
      name: `Persist Test ${ts}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 100,
      taxRate: 18,
      tagPrices: [{ name: 'Bulk Rate', tag: 'bulk', price: 75 }],
    })
    const productId = productData.product?.id || productData.product?._id

    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `BulkBuyer-${ts}`,
      email: `bulk-${ts}@test.com`,
      tags: ['bulk'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '1 St', city: 'X', postalCode: '0000', country: 'AT', isDefault: true }],
    })
    const contactId = contactData.contact?.id || contactData.contact?._id

    // Create invoice with priceExplanation on line
    const invoiceData = await apiCall('POST', `/org/${orgId}/invoices`, token, {
      type: 'invoice',
      direction: 'outgoing',
      contactId,
      issueDate: new Date().toISOString().split('T')[0],
      currency: 'EUR',
      lines: [{
        productId,
        description: `Persist Test ${ts}`,
        quantity: 1,
        unit: 'pcs',
        unitPrice: 75,
        discount: 0,
        taxRate: 18,
        taxAmount: 13.5,
        lineTotal: 88.5,
        priceExplanation: [
          { type: 'base', label: 'Selling price', price: 100 },
          { type: 'tag', label: 'Bulk Rate', price: 75 },
        ],
      }],
      subtotal: 75,
      taxTotal: 13.5,
      total: 88.5,
    })
    const invoiceId = invoiceData.invoice?.id || invoiceData.invoice?._id
    expect(invoiceId).toBeTruthy()

    // Fetch invoice and verify priceExplanation is persisted
    const fetched = await apiCall('GET', `/org/${orgId}/invoices/${invoiceId}`, token)
    const line = fetched.invoice?.lines?.[0]
    expect(line).toBeTruthy()
    expect(line.priceExplanation).toHaveLength(2)
    expect(line.priceExplanation[0].type).toBe('base')
    expect(line.priceExplanation[0].price).toBe(100)
    expect(line.priceExplanation[1].type).toBe('tag')
    expect(line.priceExplanation[1].label).toBe('Bulk Rate')
    expect(line.priceExplanation[1].price).toBe(75)
  })
})
