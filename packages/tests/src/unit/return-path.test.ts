import { describe, it, expect } from 'bun:test'
import {
  orgPickerPath,
  rememberReturnPath,
  safeReturnPath,
  signInPath,
  takeReturnPath,
  type ReturnPathStore,
} from 'ui-shared/nav/return-path'

/**
 * FR-22.53 — signing in returns to the page the person was on.
 *
 * The page rides on `/auth/login?next=…`, which anyone can put in a link. Following it off-site
 * after a real sign-in is an open redirect: the genuine LGR sign-in, then a lookalike asking for
 * the password "again". `safeReturnPath` is the only gate, so it is asserted against the shapes
 * that defeat the obvious checks, not just the ones a reviewer thinks of first.
 */

describe('safeReturnPath — what it follows', () => {
  it('keeps a page of an app, with its query and hash', () => {
    expect(safeReturnPath('/invoicing/invoices')).toBe('/invoicing/invoices')
    expect(safeReturnPath('/invoicing/invoices/new?type=credit_note')).toBe('/invoicing/invoices/new?type=credit_note')
    expect(safeReturnPath('/inventory/products/6a1/edit#prices')).toBe('/inventory/products/6a1/edit#prices')
    expect(safeReturnPath('/pos/terminal')).toBe('/pos/terminal')
    expect(safeReturnPath('/invoicing/pos/terminal')).toBe('/invoicing/pos/terminal')
    expect(safeReturnPath('/reports/sales-history?dateFrom=2026-10-01')).toBe('/reports/sales-history?dateFrom=2026-10-01')
  })

  it("keeps the portal's own pages", () => {
    expect(safeReturnPath('/dashboard')).toBe('/dashboard')
    expect(safeReturnPath('/apps')).toBe('/apps')
    expect(safeReturnPath('/settings/users')).toBe('/settings/users')
    expect(safeReturnPath('/account')).toBe('/account')
  })

  it('keeps an encoded Cyrillic search and a literal percent sign', () => {
    const cyr = '/invoicing/contacts?search=%D0%9F%D0%B5%D1%82%D1%8A%D1%80'
    expect(safeReturnPath(cyr)).toBe(cyr)
    expect(safeReturnPath('/inventory/products?search=10%25')).toBe('/inventory/products?search=10%25')
  })

  it('drops the dev handoff parameters a return path has no business carrying', () => {
    expect(safeReturnPath('/invoicing/invoices?token=attacker.jwt&status=draft')).toBe('/invoicing/invoices?status=draft')
    expect(safeReturnPath('/invoicing/?org=%7B%22id%22%3A%22x%22%7D')).toBe('/invoicing/')
  })
})

describe('safeReturnPath — what it refuses', () => {
  const refused = (raw: unknown) => expect(safeReturnPath(raw)).toBeNull()

  it('anything that is not a string', () => {
    for (const raw of [undefined, null, 42, {}, ['/invoicing/invoices'], true]) refused(raw)
  })

  it('empty, the root, and relative paths', () => {
    for (const raw of ['', '/', 'invoicing/invoices', './invoicing', '../invoicing', ' /invoicing/invoices']) refused(raw)
  })

  it('another origin, however it is spelled', () => {
    for (const raw of [
      '//evil.example',
      '//evil.example/invoicing/invoices',
      '///evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      '\\/evil.example',
      'https://evil.example/invoicing/invoices',
      'HTTPS://evil.example',
      'http:/invoicing/invoices',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) refused(raw)
  })

  it('the same tricks percent-encoded, once or twice', () => {
    for (const raw of [
      '/%2F%2Fevil.example',
      '/%2fevil.example',
      '/%5Cevil.example',
      '/%5cevil.example',
      '/%252F%252Fevil.example',
      '/%25252F%25252Fevil.example',
      '%2F%2Fevil.example',
    ]) refused(raw)
  })

  it('control characters, which the URL parser silently drops', () => {
    // "/\t/evil.example" reaches the browser as "//evil.example".
    for (const raw of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/invoicing/\u0000', '/%09/evil.example', '/invoicing/%0d%0aSet-Cookie:x=1']) refused(raw)
  })

  it('paths outside our apps and portal pages', () => {
    for (const raw of [
      '/evil',
      '/landing',
      '/auth/login',
      '/auth/reset-password#token=x',
      '/api/org/1/invoices',
      '/api/oauth/google',
      '/idp/authorize?client_id=x',
      '/orgs',
      '/invoicingX/invoices',
      '/invoicing@evil.example',
    ]) refused(raw)
  })

  it('dot segments that climb out of an app', () => {
    refused('/invoicing/../../evil.example')
    refused('/invoicing/..//evil.example')
    refused('/invoicing/%2e%2e/%2e%2e/evil')
  })

  it('anything absurdly long', () => {
    refused(`/invoicing/${'a'.repeat(3000)}`)
  })
})

describe('signInPath / orgPickerPath', () => {
  it('carry a path we would follow, encoded, and round-trip it', () => {
    const page = '/invoicing/invoices/new?type=credit_note'
    const href = signInPath(page)
    expect(href).toBe('/auth/login?next=%2Finvoicing%2Finvoices%2Fnew%3Ftype%3Dcredit_note')
    expect(new URLSearchParams(href.split('?')[1]).get('next')).toBe(page)
    expect(orgPickerPath('/dashboard')).toBe('/orgs?next=%2Fdashboard')
  })

  it('carry nothing when there is nothing to follow', () => {
    expect(signInPath()).toBe('/auth/login')
    expect(signInPath(null)).toBe('/auth/login')
    expect(signInPath('//evil.example')).toBe('/auth/login')
    expect(signInPath('/auth/login?next=%2Fdashboard')).toBe('/auth/login')
    expect(orgPickerPath('https://evil.example')).toBe('/orgs')
  })
})

describe('rememberReturnPath / takeReturnPath — across a provider round trip', () => {
  function memoryStore(): ReturnPathStore & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    }
  }
  const T0 = 1_760_000_000_000

  it('gives the kept path back once', () => {
    const store = memoryStore()
    rememberReturnPath('/invoicing/invoices/new', store, () => T0)
    expect(takeReturnPath(store, () => T0 + 5_000)).toBe('/invoicing/invoices/new')
    expect(takeReturnPath(store, () => T0 + 6_000)).toBeNull()
  })

  it('keeps nothing it would not follow, and clears what an abandoned attempt kept', () => {
    const store = memoryStore()
    rememberReturnPath('/dashboard', store, () => T0)
    rememberReturnPath('//evil.example', store, () => T0)
    expect(store.data.size).toBe(0)
    rememberReturnPath('/dashboard', store, () => T0)
    rememberReturnPath(null, store, () => T0)
    expect(takeReturnPath(store, () => T0)).toBeNull()
  })

  it('forgets a path kept too long ago, or stamped in the future', () => {
    const store = memoryStore()
    rememberReturnPath('/dashboard', store, () => T0)
    expect(takeReturnPath(store, () => T0 + 31 * 60_000)).toBeNull()
    rememberReturnPath('/dashboard', store, () => T0 + 60_000)
    expect(takeReturnPath(store, () => T0)).toBeNull()
  })

  it('re-checks what it reads back: the tab storage is writable by any script on the page', () => {
    const store = memoryStore()
    store.setItem('lgr_return_to', JSON.stringify({ path: '//evil.example', at: T0 }))
    expect(takeReturnPath(store, () => T0)).toBeNull()
    store.setItem('lgr_return_to', 'not json')
    expect(takeReturnPath(store, () => T0)).toBeNull()
  })

  it('survives a storage that refuses', () => {
    const broken: ReturnPathStore = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(() => rememberReturnPath('/dashboard', broken)).not.toThrow()
    expect(takeReturnPath(broken)).toBeNull()
    expect(takeReturnPath(null)).toBeNull()
  })
})
