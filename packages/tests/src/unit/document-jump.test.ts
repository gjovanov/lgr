import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LOOKUP_FAMILIES, lookupNumber, lookupSpellings, prefixPattern, type LookupMatch } from 'config/document-lookup'
import { documentIcon, documentKindKey, documentRoute, isJumpShortcut, type JumpKeyEvent } from '../../../ui-shell/src/document-route'
import { accessRuleFor } from 'config/access'

/**
 * FR-31.22 (#796, slice B5): the top bar's jump to a document, the parts without a browser and a database. The
 * lookup route itself is `integration/document-lookup.flow.test.ts`.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
const read = (...parts: string[]) => readFileSync(join(PACKAGES, ...parts), 'utf8')

const match = (family: LookupMatch['family'], extra: Partial<LookupMatch> = {}): LookupMatch => ({ family, id: 'abc', number: 'N-1', ...extra })

/** Every family, with each type that changes where it opens or what it is called. */
const CASES: LookupMatch[] = [
  match('sales', { type: 'invoice' }), match('sales', { type: 'credit_note' }), match('sales', { type: 'debit_note' }),
  match('proforma', { type: 'proforma' }), match('proforma', { type: 'offer' }),
  match('bill', { type: 'invoice' }),
  match('cash', { type: 'cash_sale', origin: 'pos' }), match('cash', { type: 'cash_sale', origin: 'backoffice' }),
  match('cash', { type: 'cash_storno' }), match('cash', { type: 'payment_receipt' }), match('cash', { type: 'payment_storno' }),
  match('supplierOrder'), match('customerOrder'), match('reservation'), match('movement', { type: 'transfer' }),
]

describe('where a match opens', () => {
  it('each family on its own page, by a route name the module declares', () => {
    const manifests = read('web', 'src', 'modules', 'invoicing', 'manifest.ts') + read('web', 'src', 'modules', 'inventory', 'manifest.ts')
    for (const m of CASES) {
      for (const readsDocuments of [true, false]) {
        const to = documentRoute(m, readsDocuments)
        expect({ m, name: to.name, declared: manifests.includes(`name: '${to.name}'`) }).toEqual({ m, name: to.name, declared: true })
        expect(to.params).toEqual({ id: 'abc' })
      }
    }
    expect(new Set(LOOKUP_FAMILIES)).toEqual(new Set(CASES.map(c => c.family)))
  })

  it('the pages the lists open them on', () => {
    expect(documentRoute(match('sales', { type: 'credit_note' }), true).name).toBe('invoicing.sales.edit')
    expect(documentRoute(match('proforma', { type: 'offer' }), true).name).toBe('invoicing.offer.edit')
    expect(documentRoute(match('proforma', { type: 'proforma' }), true).name).toBe('invoicing.proforma.edit')
    expect(documentRoute(match('bill'), true).name).toBe('invoicing.purchases.edit')
    expect(documentRoute(match('supplierOrder'), true).name).toBe('invoicing.orders.edit')
    expect(documentRoute(match('customerOrder'), true).name).toBe('invoicing.internalOrders.edit')
    expect(documentRoute(match('reservation'), true).name).toBe('invoicing.reservations.detail')
    expect(documentRoute(match('movement'), true).name).toBe('inventory.movements.view')
  })

  it('a till document as the cash-register journal opens it', () => {
    // A back-office cash sale in its form, for whoever reads the documents; a till sale, a storno or a receipt on its page.
    expect(documentRoute(match('cash', { type: 'cash_sale', origin: 'backoffice' }), true).name).toBe('invoicing.cash-sales.edit')
    expect(documentRoute(match('cash', { type: 'cash_sale', origin: 'backoffice' }), false).name).toBe('invoicing.cash-sales.view')
    expect(documentRoute(match('cash', { type: 'cash_sale', origin: 'pos' }), true).name).toBe('invoicing.cash-sales.view')
    expect(documentRoute(match('cash', { type: 'cash_storno', origin: 'backoffice' }), true).name).toBe('invoicing.cash-sales.view')
  })
})

describe('what a match is called, in every language', () => {
  const LOCALES = ['en', 'bg', 'de', 'mk'] as const
  const catalogue = Object.fromEntries(LOCALES.map(l => [l, JSON.parse(read('ui-shared', 'src', 'locales', `${l}.json`))]))
  const at = (obj: any, key: string) => key.split('.').reduce((o, k) => o?.[k], obj)

  it('every kind and every word of the field has a text in en, bg, de and mk', () => {
    const keys = new Set(CASES.map(documentKindKey))
    expect(keys.size).toBe(14)
    for (const k of ['open', 'label', 'hint', 'none', 'several', 'prefix', 'more', 'failed', 'viaDraft']) keys.add(`shell.jump.${k}`)
    for (const l of LOCALES) {
      for (const key of keys) {
        const text = at(catalogue[l], key)
        expect({ l, key, ok: typeof text === 'string' && text.trim().length > 0 }).toEqual({ l, key, ok: true })
      }
    }
  })

  it('an icon the app ships for each family', () => {
    const shipped: string[] = JSON.parse(read('ui-shared', 'src', 'styles', 'icons', 'icons.json'))
    for (const m of CASES) expect({ m: m.family, shipped: shipped.includes(documentIcon(m)) }).toEqual({ m: m.family, shipped: true })
  })
})

describe('Ctrl+K focuses the field (D-7)', () => {
  const key = (k: string, o: Partial<JumpKeyEvent> = {}): JumpKeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o })

  it('Ctrl+K and ⌘K, in a Latin or a Cyrillic layout', () => {
    expect(isJumpShortcut(key('k', { ctrlKey: true, code: 'KeyK' }))).toBe(true)
    expect(isJumpShortcut(key('K', { ctrlKey: true, code: 'KeyK' }))).toBe(true)
    expect(isJumpShortcut(key('k', { metaKey: true, code: 'KeyK' }))).toBe(true)
    expect(isJumpShortcut(key('к', { ctrlKey: true, code: 'KeyK' }))).toBe(true) // phonetic
    expect(isJumpShortcut(key('л', { ctrlKey: true, code: 'KeyK' }))).toBe(true) // БДС
  })

  it('nothing else: no K alone, no AltGr, no Shift, no other key, no composing', () => {
    expect(isJumpShortcut(key('k', { code: 'KeyK' }))).toBe(false)
    expect(isJumpShortcut(key('k', { ctrlKey: true, altKey: true, code: 'KeyK' }))).toBe(false)
    expect(isJumpShortcut(key('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' }))).toBe(false)
    expect(isJumpShortcut(key('s', { ctrlKey: true, code: 'KeyS' }))).toBe(false)
    expect(isJumpShortcut(key('Enter', { ctrlKey: true }))).toBe(false)
    expect(isJumpShortcut(key('k', { ctrlKey: true, code: 'KeyK', isComposing: true }))).toBe(false)
    // A Latin K elsewhere on the keyboard (Dvorak) is the K its user sees.
    expect(isJumpShortcut(key('t', { ctrlKey: true, code: 'KeyK' }))).toBe(false)
  })

  it('no key of the document line table or a form is K', () => {
    const grid = read('ui-shared', 'src', 'composables', 'useGridNavigation.ts')
    const form = read('ui-shared', 'src', 'composables', 'form-shortcuts.ts')
    expect(/['"](k|K|KeyK)['"]/.test(grid + form)).toBe(false)
  })
})

describe('the number as it is looked up', () => {
  it('trimmed, as typed and in capitals, and a prefix that is only characters', () => {
    expect(lookupNumber('  INV-1 ')).toBe('INV-1')
    expect(lookupNumber(undefined)).toBe('')
    expect(lookupNumber('x'.repeat(100))).toHaveLength(64)
    expect(lookupSpellings('INV-1')).toEqual(['INV-1'])
    expect(lookupSpellings('inv-1')).toEqual(['inv-1', 'INV-1'])
    expect(prefixPattern('SM-.*').test('SM-.*1')).toBe(true)
    expect(prefixPattern('SM-.*').test('SM-2026')).toBe(false)
    expect(prefixPattern('INV').test('XINV')).toBe(false)
  })
})

describe('where it lives', () => {
  it('the top bar holds the field, for a session in an org', () => {
    const shell = read('ui-shell', 'src', 'components', 'AppShell.vue')
    expect(shell).toMatch(/<DocumentJump v-if="org" \/>/)
    const jump = read('ui-shell', 'src', 'components', 'DocumentJump.vue')
    expect(jump).toContain('/lookup/documents')
    expect(jump).toContain('isJumpShortcut')
  })

  it('the route has a rule: the service decides what each caller finds', () => {
    expect(accessRuleFor('GET', 'lookup/documents')).toMatchObject({ self: expect.any(String) })
  })
})
