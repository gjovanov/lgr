import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { setSession } from 'ui-shared/session/session'
import { ALL, NOTHING, type CapabilityId, type Grant } from 'config/access'
import { PRICE_TIER_NAMES } from 'config/constants'
import { priceLevelItems, rememberPriceLevel, startingPriceLevel } from '../../../web/src/modules/invoicing/composables/stock-receipt-price'
import en from '../../../ui-shared/src/locales/en.json'
import bg from '../../../ui-shared/src/locales/bg.json'
import de from '../../../ui-shared/src/locales/de.json'
import mk from '../../../ui-shared/src/locales/mk.json'

/**
 * Owner, 2026-11-15: a bill's „Складова разписка" opens a dialog with the price to print, „Цена на едро" until the
 * person chooses another, and the choice remembered per user. This holds what the dialog lists and what it opens on.
 */

// A tab: the session lives in the window's sessionStorage; a remembered setting in localStorage, under the user and org.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
  keys() { return [...this.map.keys()] }
}
const g = globalThis as any
const real = { window: g.window, document: g.document, localStorage: g.localStorage }
const remembered = new MemoryStorage()
if (typeof g.window === 'undefined') {
  g.window = { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage(), addEventListener() {}, location: { pathname: '/' } }
  g.document ??= { addEventListener() {}, visibilityState: 'visible' }
}
g.localStorage = remembered

// Every unit file shares one process: leave no session, storage or window behind.
afterAll(() => {
  setSession('', null)
  g.window = real.window
  g.document = real.document
  g.localStorage = real.localStorage
})

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const signIn = (userId: string, orgId: string) =>
  setSession(token({ id: userId, orgId, role: 'member', permissions: [], exp: 4102444800 }), { id: orgId, slug: orgId, name: orgId } as any)

const grant = (...caps: string[]): Grant => ({ caps: new Set(caps as CapabilityId[]) })
const words = (cat: any) => (key: string) => String(key.split('.').reduce((o, k) => o?.[k], cat))

beforeEach(() => {
  remembered.clear()
  signIn('u1', 'o1')
})

describe('what the dialog lists', () => {
  it('the selling price, every slot, and the booked price last: each under the name a person reads', () => {
    const items = priceLevelItems(ALL, words(bg), 'bg')
    expect(items.map((i) => i.value)).toEqual(['selling', ...PRICE_TIER_NAMES, 'booked'])
    expect(items.map((i) => i.title)).toEqual([
      'Продажна цена', 'Цена с ТО', 'Цена на едро',
      ...Array.from({ length: 11 }, (_, n) => `Цена ${n}`),
      'Цена на заприходяване (по документа)',
    ])
  })

  it('the slot stored as „Доставна цена" is sent by that name and never shown by it', () => {
    for (const [locale, cat, label] of [['bg', bg, 'Цена с ТО'], ['en', en, 'Trade-discount price'], ['de', de, 'Preis mit Handelsrabatt'], ['mk', mk, 'Цена со ТП']] as const) {
      const items = priceLevelItems(ALL, words(cat), locale)
      expect({ locale, item: items.find((i) => i.value === 'Доставна цена') }).toEqual({ locale, item: { value: 'Доставна цена', title: label } })
      expect({ locale, shown: items.some((i) => i.title === 'Доставна цена') }).toEqual({ locale, shown: false })
    }
  })

  it('no title is a key: every word it needs is in the four catalogues', () => {
    for (const [locale, cat] of Object.entries({ en, bg, de, mk })) {
      for (const item of priceLevelItems(ALL, words(cat), locale)) {
        expect({ locale, value: item.value, named: !!item.title && item.title !== 'undefined' && !item.title.includes('.stockReceipt.') })
          .toEqual({ locale, value: item.value, named: true })
      }
    }
  })

  it('only the levels the role sees; the booked price needs nothing more than the print does', () => {
    const counter = grant('products.price:selling', 'products.price:1')
    expect(priceLevelItems(counter, words(bg), 'bg').map((i) => i.value)).toEqual(['selling', 'Цена 1', 'booked'])
    expect(priceLevelItems(NOTHING, words(bg), 'bg').map((i) => i.value)).toEqual(['booked'])
  })
})

describe('what the dialog opens on', () => {
  it('„Цена на едро" until the person has chosen', () => {
    expect(startingPriceLevel(ALL)).toBe('Цена на едро')
  })

  it('the first level the role sees when it does not see „Цена на едро"', () => {
    expect(startingPriceLevel(grant('products.price:selling', 'products.price:1'))).toBe('selling')
    expect(startingPriceLevel(NOTHING)).toBe('booked')
  })

  it('the last choice, kept per user and org', () => {
    rememberPriceLevel('Цена 2')
    expect(startingPriceLevel(ALL)).toBe('Цена 2')
    expect(remembered.keys()).toEqual(['lgr:stock-receipt-price:u1:o1'])

    // Another person on the same PC, and the same person in another org, start from the default.
    signIn('u2', 'o1')
    expect(startingPriceLevel(ALL)).toBe('Цена на едро')
    signIn('u1', 'o2')
    expect(startingPriceLevel(ALL)).toBe('Цена на едро')
    rememberPriceLevel('booked')
    expect(startingPriceLevel(ALL)).toBe('booked')

    signIn('u1', 'o1')
    expect(startingPriceLevel(ALL)).toBe('Цена 2')
  })

  it('the default again once the remembered level is one the role no longer sees', () => {
    rememberPriceLevel('Цена 2')
    const narrowed = grant('products.price:selling', 'products.price:wholesale', 'products.price:1')
    expect(startingPriceLevel(narrowed)).toBe('Цена на едро')
    expect(startingPriceLevel(grant('products.price:selling', 'products.price:1'))).toBe('selling')
    // What was remembered is left alone: the role may get the level back.
    expect(startingPriceLevel(ALL)).toBe('Цена 2')
  })

  it('the default when what is stored is no level at all', () => {
    for (const stored of ['"Цена 99"', '{"key":"selling"}', 'not json', '""', 'null', '42']) {
      remembered.setItem('lgr:stock-receipt-price:u1:o1', stored)
      expect({ stored, opensOn: startingPriceLevel(ALL) }).toEqual({ stored, opensOn: 'Цена на едро' })
    }
  })
})
