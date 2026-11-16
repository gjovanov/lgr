import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyHeaderForm, formProblems, hasHeader, headerFormOf, headerPayloadOf, headerSummary, switchLabel,
} from '../../../accounting-ui/src/views/accounting/journal-header-form'
import { HEADER_PROBLEM_CODES, REGISTER_DOC_TYPES } from 'config/journal-header'

/**
 * FR-25a §3.6: the journal entry form's Document card as data, and the words it shows in every locale.
 * Fictional numbers throughout.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const
const catalogue = (l: string) => JSON.parse(readFileSync(join(PACKAGES, 'ui-shared', 'src', 'locales', `${l}.json`), 'utf8'))
const valueAt = (obj: any, key: string) => key.split('.').reduce((o, k) => o?.[k], obj)

describe('the card reads an entry', () => {
  it('as its inputs hold it', () => {
    const form = headerFormOf({
      docType: '-Ф', docNumber: '0000000101', docDate: '2026-03-02T00:00:00.000Z', registerDocType: '1', paymentCode: '2',
      paidAmount: 20, vatRate: 20, reportingMonth: '202604', taxEventDate: '2026-03-03T00:00:00.000Z',
      links: [{ docType: '+ББ', docNumber: '7', date: '2026-03-05T00:00:00.000Z', amount: 20, entryId: 'e1' }],
    })
    expect(form).toMatchObject({
      docType: '-Ф', docNumber: '0000000101', docDate: '2026-03-02', registerDocType: '01', paymentCode: '2', paidAmount: 20,
      paidCash: null, vatRate: 20, reportingMonth: '2026-04', taxEventDate: '2026-03-03', reasonRef: '',
    })
    expect(form.links).toEqual([{ docType: '+ББ', docNumber: '7', date: '2026-03-05', amount: 20, amountFx: null, entryId: 'e1' }])
  })

  it('keeps a value no list offers as booked, so a read-only card shows it', () => {
    expect(headerFormOf({ registerDocType: '5', paymentCode: '7' })).toMatchObject({ registerDocType: '5', paymentCode: '7' })
    expect(headerFormOf(null)).toEqual(emptyHeaderForm())
  })

  it('opens on an entry that says anything of its document', () => {
    expect(hasHeader({ description: 'Typed by hand' })).toBe(false)
    expect(hasHeader({ paidAmount: 0 })).toBe(true)
    expect(hasHeader({ links: [{ docType: '+ББ', docNumber: '7' }] })).toBe(true)
    expect(hasHeader({ docOptions: { exportInvoice: 'true' } })).toBe(true)
    expect(hasHeader({ source: { createdBy: 'someone' } })).toBe(true)
    expect(hasHeader(null)).toBe(false)
  })
})

describe('the card writes the header back', () => {
  it('as the API takes it: every field, a cleared one as null', () => {
    const form = { ...emptyHeaderForm(), docType: ' -Ф ', registerDocType: '03', reasonRef: 'Invoice 101', reportingMonth: '2026-05', paidAmount: 0 }
    expect(headerPayloadOf(form)).toEqual({
      docType: '-Ф', docNumber: null, docDate: null, registerDocType: '03', reasonRef: 'Invoice 101', paymentCode: null, paidAmount: 0,
      paidCash: null, bankOperation: null, vatKind: null, vatRate: null, vatRule: null, vatExemptionReason: null, taxEventDate: null,
      reportingMonth: '202605', protocolType: null, customsRef: null, links: null,
    })
  })

  it('takes an emptied number, a cleared combobox and a cleared month for nothing', () => {
    const form: any = { ...emptyHeaderForm(), paidAmount: '', docType: null, protocolType: null, reportingMonth: null }
    expect(headerPayloadOf(form)).toMatchObject({ paidAmount: null, docType: null, protocolType: null, reportingMonth: null })
  })

  it('sends the links without the entries they were found to name', () => {
    const form = { ...emptyHeaderForm(), links: [{ docType: '+ББ', docNumber: ' 7 ', date: '', amount: 12.5, amountFx: null, entryId: 'e1' }] }
    expect(headerPayloadOf(form).links).toEqual([{ docType: '+ББ', docNumber: '7', date: null, amount: 12.5, amountFx: null }])
  })

  it('names a refused field by the server\'s rules', () => {
    expect(formProblems({ ...emptyHeaderForm(), paidAmount: 10, paidCash: 20 })).toEqual({ paidCash: 'paid_cash_exceeds_paid' })
    expect(formProblems({ ...emptyHeaderForm(), registerDocType: '02' })).toEqual({ reasonRef: 'reason_ref_required' })
    expect(formProblems({ ...emptyHeaderForm(), reportingMonth: '2026-13' })).toEqual({ reportingMonth: 'reporting_month_invalid' })
    expect(formProblems(emptyHeaderForm())).toEqual({})
  })

  it('says in one line what the folded card holds', () => {
    const label = (key: string) => key.split('.').pop()!
    expect(headerSummary({ ...emptyHeaderForm(), docType: '-Ф', docNumber: '101', registerDocType: '01', paymentCode: '1', vatRate: 20 }, label))
      .toBe('-Ф 101 · invoice · cash · rate 20%')
    expect(headerSummary(emptyHeaderForm(), label)).toBe('')
    expect(switchLabel('exportInvoice', 'true')).toBe('exportInvoice')
    expect(switchLabel('discount', '5')).toBe('discount: 5')
  })
})

describe('every word the header shows is in every locale', () => {
  /** The keys the card, the grid, the form and the VAT register name: written out, so a typo in a view fails here. */
  const keysInSources = () => {
    const files = [
      'accounting-ui/src/components/JournalDocumentCard.vue',
      'accounting-ui/src/views/accounting/JournalEntriesView.vue',
      'accounting-ui/src/views/accounting/JournalEntryFormView.vue',
      'accounting-ui/src/views/accounting/VatReturnView.vue',
    ]
    const keys = new Set<string>()
    for (const f of files) {
      const text = readFileSync(join(PACKAGES, f), 'utf8')
      for (const m of text.matchAll(/'(accounting\.(?:journalEntry|paymentCodes|vatRegister)\.[A-Za-z_.]+)'/g)) keys.add(m[1])
    }
    return [...keys]
  }

  it('the literal keys of the views', () => {
    const keys = keysInSources()
    expect(keys.length).toBeGreaterThan(40)
    for (const locale of LOCALES) {
      const c = catalogue(locale)
      for (const key of keys) expect({ locale, key, ok: typeof valueAt(c, key) === 'string' }).toEqual({ locale, key, ok: true })
    }
  })

  it('the keys made up at run time: register types, payment ways and refusals', () => {
    const keys = [
      ...REGISTER_DOC_TYPES.map(r => `accounting.journalEntry.document.registerDocTypes.${r.key}`),
      'accounting.paymentCodes.cash', 'accounting.paymentCodes.bank',
      ...HEADER_PROBLEM_CODES.map(code => `accounting.journalEntry.errors.${code}`),
      'accounting.journalEntry.errors.journal_entry_as_booked',
    ]
    for (const locale of LOCALES) {
      const c = catalogue(locale)
      for (const key of keys) expect({ locale, key, ok: typeof valueAt(c, key) === 'string' }).toEqual({ locale, key, ok: true })
    }
  })

  it('the same tree in each locale', () => {
    const shape = (o: any): any => (typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o)
    const en = catalogue('en').accounting
    for (const locale of LOCALES) {
      const c = catalogue(locale).accounting
      for (const block of ['journalEntry', 'paymentCodes', 'vatRegister']) expect({ locale, block, tree: shape(c[block]) }).toEqual({ locale, block, tree: shape(en[block]) })
    }
  })
})
