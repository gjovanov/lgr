import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STOCK_REFUSAL_CODES, stockRefusalMessage } from 'ui-shared/composables/stock-refusals'

/**
 * #168: a refusal the staff can meet on a movement or a bill made from receipts reads in their
 * language. `warehouse.notBillable.*` and `warehouse.refusals.*` are built at run time from a code,
 * which `web-catalogue-i18n.test.ts` cannot see, so this test holds both against the catalogues and
 * against what the server sends: a code renamed on one side would otherwise show the raw key.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const read = (path: string) => readFileSync(join(PACKAGES, path), 'utf8')
const SERVER = read('services/src/biz/receipt-bill.service.ts') + read('services/src/biz/invoicing.service.ts') + read('config/src/movement-warehouses.ts')
const CATALOGS = ['en', 'bg', 'de', 'mk'].map(locale => [locale, JSON.parse(read(`ui-shared/src/locales/${locale}.json`))] as const)

/** What can reach the movement page's „why not" (`receiptBillingFor`): the page words each. */
const PAGE_REASONS = ['receipt_not_completed', 'receipt_not_billable', 'orphan', 'receipt_is_reversal', 'receipt_not_a_delivery', 'receipt_rolled_back']

describe('the refusals of a movement and of a bill made from receipts', () => {
  it('names only codes the server sends', () => {
    for (const code of STOCK_REFUSAL_CODES) expect(SERVER).toContain(`'${code}'`)
  })

  it('has every code in every catalogue, and no sentence left in English outside it', () => {
    const english = CATALOGS[0][1].warehouse.refusals
    for (const [locale, catalog] of CATALOGS) {
      expect([locale, Object.keys(catalog.warehouse.refusals).sort()]).toEqual([locale, [...STOCK_REFUSAL_CODES].sort()])
      if (locale === 'en') continue
      for (const code of STOCK_REFUSAL_CODES) expect(catalog.warehouse.refusals[code]).not.toBe(english[code])
    }
  })

  it('the movement page words every reason it can be given', () => {
    for (const [, catalog] of CATALOGS) expect(Object.keys(catalog.warehouse.notBillable).sort()).toEqual([...PAGE_REASONS].sort())
    for (const code of PAGE_REASONS.filter(r => r !== 'orphan')) expect(SERVER).toContain(`'${code}'`)
  })

  it('calls each type of movement what the type select calls it, in every language', () => {
    const SAYS_TYPE: Record<string, string> = {
      dispatch_with_to_warehouse: 'dispatch',
      receipt_with_from_warehouse: 'receipt',
      transfer_without_from_warehouse: 'transfer',
      adjustment_with_both_warehouses: 'adjustment',
    }
    for (const [locale, catalog] of CATALOGS) {
      for (const [code, type] of Object.entries(SAYS_TYPE)) {
        // Inflected in the sentence, so its stem.
        const word = String(catalog.warehouse.movementTypes[type]).toLowerCase().slice(0, 5)
        expect([locale, code, String(catalog.warehouse.refusals[code]).toLowerCase().includes(word)]).toEqual([locale, code, true])
      }
    }
  })

  it('reads a known code from the catalogue, with what the refusal names', () => {
    const t = (key: string, params?: Record<string, unknown>) => `${key}|${params?.movementNumber ?? ''}`
    const e = { response: { data: { code: 'receipt_without_supplier', message: 'in English', movementNumber: 'SM-1' } } }
    expect(stockRefusalMessage(e, t)).toBe('warehouse.refusals.receipt_without_supplier|SM-1')
  })

  it('leaves any other refusal, and a failure with no answer at all, as they were', () => {
    const t = (key: string) => key
    expect(stockRefusalMessage({ response: { data: { code: 'something_else', message: 'the server said' } } }, t)).toBe('the server said')
    expect(stockRefusalMessage({ response: { data: { message: 'no code' } } }, t)).toBe('no code')
    expect(stockRefusalMessage(new Error('thrown here'), t)).toBe('thrown here')
    expect(stockRefusalMessage({}, t)).toBe('common.operationFailed')
  })
})
