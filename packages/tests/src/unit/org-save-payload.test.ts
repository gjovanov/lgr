import { describe, it, expect } from 'bun:test'
import {
  orgSavePayload, taxConfigPayload, tickDefaultRate, vatRowsOf, type OrgSaveForm,
} from '../../../portal-ui/src/views/settings/org-save-payload'

/**
 * #816: what a save of Settings → Organization sends. The page showed controls that a person could change and that
 * answered "Saved" without being stored: the Default box of a VAT rate, the emptied company fields, the last address
 * or bank account removed. And it showed controls that nothing reads: the module switches and the payroll fields.
 *
 * What the route stores of this body is `integration/org-settings-save.flow` ("what the page changes is stored").
 */

const ROWS = [{ name: 'Standard', rate: 20 }, { name: 'Reduced', rate: 9 }, { name: 'Zero', rate: 0 }, { name: 'Also 20', rate: 20 }]

function form(over: Partial<OrgSaveForm> = {}): OrgSaveForm {
  return {
    name: 'Org', description: '',
    taxNumber: '', vatNumber: '', email: '', phone: '', website: '',
    representative: '', placeOfIssue: '', activityCode: '',
    addresses: [], bankDetails: [],
    baseCurrency: 'EUR', defaultLocale: 'en',
    vatEnabled: true, vatRates: vatRowsOf(ROWS, 20),
    defaultCostingMethod: 'wac', allowNegativeStock: false,
    cashRegister: {}, requireConnectedDevice: true,
    digestEnabled: false, digestHour: 7, digestLocale: '', digestRecipients: [], digestSections: {},
    ...over,
  }
}

describe('the Default box of a VAT rate', () => {
  it('is ticked on load on the first row whose rate is the stored default, and on that row only', () => {
    expect(vatRowsOf(ROWS, 20).map(r => r.default)).toEqual([true, false, false, false])
    expect(vatRowsOf(ROWS, 0).map(r => r.default)).toEqual([false, false, true, false])
  })

  it('is ticked on no row when no row has the stored default, or there is none', () => {
    for (const stored of [18, undefined, null, '20', Number.NaN]) {
      expect(vatRowsOf(ROWS, stored).some(r => r.default)).toBe(false)
    }
    expect(vatRowsOf(undefined, 20)).toEqual([])
  })

  it('loads copies: a row edited on the page is not the stored one', () => {
    const stored = [{ name: 'Standard', rate: 20 }]
    vatRowsOf(stored, 20)[0].rate = 18
    expect(stored[0].rate).toBe(20)
  })

  it('holds one tick at most: ticking a row unticks the others, unticking leaves none', () => {
    const rows = vatRowsOf(ROWS, 20)
    tickDefaultRate(rows, 2, true)
    expect(rows.map(r => r.default)).toEqual([false, false, true, false])
    tickDefaultRate(rows, 2, false)
    expect(rows.map(r => r.default)).toEqual([false, false, false, false])
  })
})

describe('the tax block a save sends', () => {
  it('sends the ticked row\'s rate as the default, and the rows as a name and a rate', () => {
    const rows = vatRowsOf(ROWS, 20)
    tickDefaultRate(rows, 1, true)
    expect(taxConfigPayload(true, rows)).toEqual({ vatEnabled: true, vatRates: ROWS, defaultVatRate: 9 })
  })

  it('sends the rate the ticked row has now, after an edit of it', () => {
    const rows = vatRowsOf(ROWS, 9)
    rows[1].rate = 10
    expect(taxConfigPayload(true, rows).defaultVatRate).toBe(10)
  })

  it('sends no default with no row ticked, or a ticked row with no rate typed: the stored one stays', () => {
    const none = vatRowsOf(ROWS, 18)
    expect('defaultVatRate' in taxConfigPayload(true, none)).toBe(false)
    const emptied = vatRowsOf(ROWS, 9)
    emptied[1].rate = ''
    expect('defaultVatRate' in taxConfigPayload(true, emptied)).toBe(false)
  })
})

describe('the body of the save', () => {
  it('sends a company field emptied as empty text, which the route removes', () => {
    const body = orgSavePayload(form())
    expect(body).toMatchObject({ taxNumber: '', vatNumber: '', email: '', phone: '', website: '' })
    expect(orgSavePayload(form({ email: 'office@example.test' })).email).toBe('office@example.test')
  })

  it('sends an empty list of addresses or bank accounts, which empties the stored one', () => {
    const body = orgSavePayload(form())
    expect(body.addresses).toEqual([])
    expect(body.bankDetails).toEqual([])
  })

  it('sends no module list and no payroll block: the page has no control for either', () => {
    const { settings } = orgSavePayload(form())
    expect('modules' in settings).toBe(false)
    expect('payroll' in settings).toBe(false)
  })

  it('sends the FR-25a fields trimmed, and empty to clear them', () => {
    expect(orgSavePayload(form({ representative: '  Ivan Petrov ', placeOfIssue: '   ', activityCode: ' 47.52' }))).toMatchObject({
      representative: 'Ivan Petrov', placeOfIssue: '', activityCode: '47.52',
    })
  })
})
