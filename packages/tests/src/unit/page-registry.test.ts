import { describe, it, expect } from 'bun:test'
import { matchPage, pageById, PAGE_REGISTRY } from 'ui-shared/nav/page-registry'

describe('page-registry matchPage', () => {
  it('matches an exact registry path', () => {
    expect(matchPage('/invoicing/invoices')?.id).toBe('/invoicing/invoices')
    expect(matchPage('/inventory/products')?.labelKey).toBe('nav.products')
  })

  it('resolves detail / sub routes to their list page', () => {
    expect(matchPage('/invoicing/invoices/123/edit')?.id).toBe('/invoicing/invoices')
    expect(matchPage('/inventory/products/abc/stock')?.id).toBe('/inventory/products')
  })

  it('longest prefix wins (bills vs bills/import)', () => {
    expect(matchPage('/invoicing/bills')?.id).toBe('/invoicing/bills')
    expect(matchPage('/invoicing/bills/import')?.id).toBe('/invoicing/bills/import')
    expect(matchPage('/invoicing/bills/9/edit')?.id).toBe('/invoicing/bills')
  })

  it('does not match across a partial segment boundary', () => {
    expect(matchPage('/invoicing/invoices-archive')).toBeNull()
    expect(matchPage('/invoicing/invoicesX')).toBeNull()
  })

  it('returns null for unknown / empty paths', () => {
    expect(matchPage('/portal/dashboard')).toBeNull()
    expect(matchPage('')).toBeNull()
  })

  it('keeps page ids globally unique across apps', () => {
    const ids = PAGE_REGISTRY.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('pageById round-trips', () => {
    expect(pageById('/pos/terminal')?.appId).toBe('pos')
    expect(pageById('/nope')).toBeNull()
  })
})
