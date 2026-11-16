import { describe, it, expect } from 'bun:test'
import {
  BOOKS_SOURCE_MODULE, JOURNAL_DOC_TYPES, NOTICE_REGISTER_VARIANTS, PAYMENT_CODES,
  bareDocNumber, docNumberVariants, headerProblems, headerUpdateOf, isAsBooked, isDeclaredInAnotherMonth, isNotice,
  isSalesInvoice, isUnpaid, mergedHeader, monthBounds, monthInputOf, monthOfDay, monthOfInput, openAmountOf, paymentCodeOf,
  paymentWayOf, pickLinkedEntry, pickRegisterEntry, registerDocTypeCode, registerDocTypeKey, registerDocTypeVariants,
  sameDocNumber, type EntryCandidate,
} from 'config/journal-header'
import { BOOKS_IMPORT } from 'db/models'
import { DOC_TYPES, PAYMENT_CODES as REGISTRY_PAYMENT_CODES } from 'services/biz/accounting-books/registry'

/**
 * FR-25a §3.6, §3.8: the journal entry's document header, as the routes check it and the entry form shows it.
 * Fictional numbers and partners throughout.
 */

describe('the vocabulary mirrors the books import', () => {
  it('names an imported entry the way the import writes it', () => {
    expect(BOOKS_SOURCE_MODULE).toBe(BOOKS_IMPORT)
    expect(isAsBooked({ sourceModule: BOOKS_IMPORT })).toBe(true)
    expect(isAsBooked({ sourceModule: 'invoice' })).toBe(false)
    expect(isAsBooked({})).toBe(false)
    expect(isAsBooked(null)).toBe(false)
  })

  it('has the import\'s payment codes and document types', () => {
    expect(PAYMENT_CODES).toEqual(REGISTRY_PAYMENT_CODES)
    expect(JOURNAL_DOC_TYPES).toEqual(DOC_TYPES.map(d => ({ code: d.code, family: d.family })))
  })

  it('reads a payment code both ways', () => {
    expect(paymentWayOf('1')).toBe('cash')
    expect(paymentWayOf(' 2 ')).toBe('bank')
    expect(paymentWayOf('7')).toBeUndefined()
    expect(paymentCodeOf('cash')).toBe('1')
    expect(paymentCodeOf('bank')).toBe('2')
    expect(paymentCodeOf('cheque')).toBeUndefined()
    expect(paymentCodeOf(undefined)).toBeUndefined()
  })
})

describe('the register type is read however it was booked', () => {
  it('pads to the register\'s two digits', () => {
    expect(registerDocTypeCode('1')).toBe('01')
    expect(registerDocTypeCode('9')).toBe('09')
    expect(registerDocTypeCode('09')).toBe('09')
    expect(registerDocTypeCode('81')).toBe('81')
    expect(registerDocTypeCode(3)).toBe('03')
    expect(registerDocTypeCode('')).toBeUndefined()
    expect(registerDocTypeCode('A1')).toBeUndefined()
    expect(registerDocTypeCode('123')).toBeUndefined()
  })

  it('names the known ones, and only those', () => {
    expect(registerDocTypeKey('1')).toBe('invoice')
    expect(registerDocTypeKey('2')).toBe('debitNotice')
    expect(registerDocTypeKey('03')).toBe('creditNotice')
    expect(registerDocTypeKey('07')).toBe('customs')
    expect(registerDocTypeKey('9')).toBe('protocol')
    expect(registerDocTypeKey('81')).toBe('tillReport')
    expect(registerDocTypeKey('05')).toBeUndefined()
  })

  it('asks a query for every stored spelling', () => {
    expect(registerDocTypeVariants('1')).toEqual(['01', '1'])
    expect(registerDocTypeVariants('81')).toEqual(['81'])
    expect(registerDocTypeVariants('x')).toEqual([])
    expect([...NOTICE_REGISTER_VARIANTS].sort()).toEqual(['02', '03', '2', '3'])
    expect(isNotice('2')).toBe(true)
    expect(isNotice('03')).toBe(true)
    expect(isNotice('1')).toBe(false)
    expect(isNotice(undefined)).toBe(false)
  })

  it('takes a sales document at the invoice register type for a sales invoice', () => {
    expect(isSalesInvoice({ docType: '-Ф', registerDocType: '1' })).toBe(true)
    expect(isSalesInvoice({ docType: '-Ф', registerDocType: '3' })).toBe(false)
    expect(isSalesInvoice({ docType: '-Ф' })).toBe(false)
    expect(isSalesInvoice({ docType: '+Ф', registerDocType: '01' })).toBe(false)
  })
})

describe('a header is checked by §3.6\'s rules', () => {
  it('passes an empty header and a whole valid one', () => {
    expect(headerProblems({})).toEqual([])
    expect(headerProblems({
      docType: '-Ф', docNumber: '0000000101', docDate: '2026-03-02', registerDocType: '01', paymentCode: '1',
      paidAmount: 120, paidCash: 120, vatRate: 20, reportingMonth: '202604', taxEventDate: '2026-03-02',
      links: [{ docType: '+ББ', docNumber: '7', date: '2026-03-05', amount: 120 }],
    })).toEqual([])
  })

  it('refuses more paid in cash than paid', () => {
    expect(headerProblems({ paidAmount: 100, paidCash: 100.004 })).toEqual([])
    expect(headerProblems({ paidAmount: 100, paidCash: 100.01 })).toEqual([{ field: 'paidCash', code: 'paid_cash_exceeds_paid' }])
    expect(headerProblems({ paidCash: 5 })).toEqual([{ field: 'paidCash', code: 'paid_cash_exceeds_paid' }])
  })

  it('asks a sales invoice at 0 % for its exemption ground', () => {
    const invoice = { docType: '-Ф', registerDocType: '01', vatRate: 0 }
    expect(headerProblems(invoice)).toEqual([{ field: 'vatExemptionReason', code: 'exemption_reason_required' }])
    expect(headerProblems({ ...invoice, vatExemptionReason: '   ' })).toEqual([{ field: 'vatExemptionReason', code: 'exemption_reason_required' }])
    expect(headerProblems({ ...invoice, vatExemptionReason: 'A legal ground' })).toEqual([])
    // A purchase at 0 % prints no ground of ours.
    expect(headerProblems({ docType: '+Ф', registerDocType: '01', vatRate: 0 })).toEqual([])
  })

  it('asks a notice what it corrects', () => {
    expect(headerProblems({ registerDocType: '3' })).toEqual([{ field: 'reasonRef', code: 'reason_ref_required' }])
    expect(headerProblems({ registerDocType: '02', reasonRef: 'Invoice 0000000101' })).toEqual([])
  })

  it('refuses what no vocabulary has', () => {
    expect(headerProblems({ paymentCode: '9' })).toEqual([{ field: 'paymentCode', code: 'payment_code_unknown' }])
    expect(headerProblems({ vatRate: 18 })).toEqual([{ field: 'vatRate', code: 'vat_rate_unknown' }])
    expect(headerProblems({ registerDocType: '05' })).toEqual([{ field: 'registerDocType', code: 'register_doc_type_unknown' }])
    expect(headerProblems({ reportingMonth: '202613' })).toEqual([{ field: 'reportingMonth', code: 'reporting_month_invalid' }])
    expect(headerProblems({ docDate: 'soon' })).toEqual([{ field: 'docDate', code: 'date_invalid' }])
    expect(headerProblems({ links: [{ docType: '+ББ', docNumber: ' ' }] })).toEqual([{ field: 'links', code: 'link_incomplete' }])
  })
})

describe('an update sets what is given and removes what is cleared', () => {
  it('splits a header into its sets and its removals', () => {
    const { set, unset } = headerUpdateOf({
      docType: ' -Ф ', registerDocType: '1', paidAmount: 0, reasonRef: '', vatRate: null, docDate: '2026-03-02', links: [],
    })
    expect(set).toEqual({ docType: '-Ф', registerDocType: '01', paidAmount: 0, docDate: new Date('2026-03-02') })
    expect(unset.sort()).toEqual(['links', 'reasonRef', 'vatRate'])
  })

  it('leaves a field the input does not name', () => {
    expect(headerUpdateOf({})).toEqual({ set: {}, unset: [] })
    expect(headerUpdateOf({ paidAmount: undefined })).toEqual({ set: {}, unset: [] })
  })

  it('keeps a link\'s number and day', () => {
    const { set } = headerUpdateOf({ links: [{ docType: '+ББ', docNumber: ' 0007 ', date: '2026-03-05', amount: 10, amountFx: null }] })
    expect(set.links).toEqual([{ docType: '+ББ', docNumber: '0007', date: new Date('2026-03-05'), amount: 10 }])
  })

  it('checks the header the update leaves, not the update alone', () => {
    const entry = { docType: '-Ф', registerDocType: '01', vatRate: 0, vatExemptionReason: 'A legal ground', paidAmount: 50 }
    expect(headerProblems(mergedHeader(entry, headerUpdateOf({ paidCash: 40 })))).toEqual([])
    expect(headerProblems(mergedHeader(entry, headerUpdateOf({ vatExemptionReason: null })))).toEqual([
      { field: 'vatExemptionReason', code: 'exemption_reason_required' },
    ])
    expect(headerProblems(mergedHeader(entry, headerUpdateOf({ paidAmount: null, paidCash: 1 })))).toEqual([
      { field: 'paidCash', code: 'paid_cash_exceeds_paid' },
    ])
  })
})

describe('what is open, and what is declared elsewhere', () => {
  it('is the total less what is paid', () => {
    expect(openAmountOf({ docTotal: 120, paidAmount: 20 })).toBe(100)
    expect(openAmountOf({ docTotal: 120 })).toBe(120)
    expect(openAmountOf({ docTotal: 0.3, paidAmount: 0.1 })).toBe(0.2)
    expect(openAmountOf({ paidAmount: 20 })).toBeUndefined()
  })

  it('is unpaid only for a document paid some way and short of its total', () => {
    expect(isUnpaid({ paymentCode: '2', docTotal: 120, paidAmount: 20 })).toBe(true)
    expect(isUnpaid({ paymentCode: '2', docTotal: 120 })).toBe(true)
    expect(isUnpaid({ paymentCode: '1', docTotal: 120, paidAmount: 120 })).toBe(false)
    expect(isUnpaid({ paymentCode: '1', docTotal: 120, paidAmount: 119.996 })).toBe(false)
    expect(isUnpaid({ paymentCode: '2', docTotal: -50, paidAmount: 0 })).toBe(true)
    expect(isUnpaid({ docTotal: 120, paidAmount: 0 })).toBe(false)
  })

  it('reads months at UTC', () => {
    expect(monthOfDay(new Date('2026-03-31T00:00:00Z'))).toBe('202603')
    expect(monthOfDay('2026-12-01')).toBe('202612')
    expect(monthOfDay('soon')).toBeUndefined()
    expect(monthInputOf('202604')).toBe('2026-04')
    expect(monthInputOf('2026-04')).toBe('')
    expect(monthOfInput('2026-04')).toBe('202604')
    expect(monthOfInput('2026-13')).toBeUndefined()
    expect(monthBounds('202612')).toEqual({ from: new Date('2026-12-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') })
  })

  it('is declared in another month only when the month it names is not its own', () => {
    expect(isDeclaredInAnotherMonth({ reportingMonth: '202605', date: '2026-03-10' })).toBe(true)
    expect(isDeclaredInAnotherMonth({ reportingMonth: '202603', date: '2026-03-10' })).toBe(false)
    expect(isDeclaredInAnotherMonth({ date: '2026-03-10' })).toBe(false)
  })
})

describe('the entries a header names', () => {
  it('reads a number without its leading zeros', () => {
    expect(bareDocNumber('0000000123')).toBe('123')
    expect(bareDocNumber('000')).toBe('0')
    expect(sameDocNumber('0000000123', '123')).toBe(true)
    expect(sameDocNumber('', '')).toBe(false)
    expect(docNumberVariants('123').sort()).toEqual(['0000000123', '123'])
    expect(docNumberVariants('0000000123').sort()).toEqual(['0000000123', '123'])
    expect(docNumberVariants('A-7').sort()).toEqual(['A-7'])
    expect(docNumberVariants('')).toEqual([])
  })

  const candidate = (over: Partial<EntryCandidate>): EntryCandidate => ({ id: 'x', docType: '-Ф', docNumber: '101', ...over })

  it('links the one entry of that type, number and partner', () => {
    const link = { docType: '-Ф', docNumber: '0000000101' }
    const self = { id: 'bank', partnerAnalyticId: 'p1' }
    expect(pickLinkedEntry(link, self, [candidate({ id: 'a', partnerAnalyticId: 'p1' }), candidate({ id: 'b', partnerAnalyticId: 'p2' })])).toBe('a')
    // A number is unique only per partner: another partner's document is not it.
    expect(pickLinkedEntry(link, self, [candidate({ id: 'b', partnerAnalyticId: 'p2' })])).toBeUndefined()
    // Never the entry itself, never a voided one, never another type.
    expect(pickLinkedEntry(link, self, [candidate({ id: 'bank', partnerAnalyticId: 'p1' })])).toBeUndefined()
    expect(pickLinkedEntry(link, self, [candidate({ id: 'a', status: 'voided' })])).toBeUndefined()
    expect(pickLinkedEntry(link, self, [candidate({ id: 'a', docType: '-ФЕ' })])).toBeUndefined()
  })

  it('settles a tie by the link\'s day, and links nothing it cannot settle', () => {
    const two = [candidate({ id: 'a', date: new Date('2026-03-02') }), candidate({ id: 'b', date: new Date('2026-04-02') })]
    expect(pickLinkedEntry({ docType: '-Ф', docNumber: '101', date: new Date('2026-04-02') }, {}, two)).toBe('b')
    expect(pickLinkedEntry({ docType: '-Ф', docNumber: '101' }, {}, two)).toBeUndefined()
  })

  it('finds a register row\'s entry by its two-digit type and its number', () => {
    const row = { docTypeCode: '01', docNumber: '0000000101', docDate: new Date('2026-03-02') }
    const entries = [
      candidate({ id: 'invoice', registerDocType: '1' }),
      candidate({ id: 'notice', registerDocType: '3' }),
      candidate({ id: 'shadow', registerDocType: '01', ledger: 'shadow' }),
    ]
    expect(pickRegisterEntry(row, entries)).toBe('invoice')
    expect(pickRegisterEntry({ ...row, docTypeCode: '03' }, entries)).toBe('notice')
    expect(pickRegisterEntry({ ...row, docTypeCode: '09' }, entries)).toBeUndefined()
    expect(pickRegisterEntry({ ...row, docTypeCode: '' }, entries)).toBeUndefined()
  })
})
