import { describe, it, expect } from 'bun:test'
import {
  describeMatch, formatPartnerReport, normalizeName, partnerOf, pickSupplierByName, summarizePartners,
  unmatchedPartnerOf, unmatchedPartnerWarning,
  type PartnerResult, type SupplierCandidate,
} from 'services/biz/doc-import/supplier-name'

/**
 * FR-28.12 — who a goods receipt came from, when all the import has is the partner's NAME. Pure: the scripts import
 * this (they only have the API's contact list), and `matching.ts#matchSupplierByName` is the same rule over the
 * database (`integration/receipt-supplier.flow.test.ts`). One definition of "the same name", pinned here.
 */

describe('partnerOf — what a receipt\'s partner says', () => {
  it('a supplier: the bare name, without the prefix PlusMinus puts before it', () => {
    expect(partnerOf('ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД')).toEqual({ kind: 'supplier', name: 'ТЕСТ СЕНТЕР ЕООД' })
    expect(partnerOf('  ПАРТНЬОРИ:  Test Centre Ltd  ')).toEqual({ kind: 'supplier', name: 'Test Centre Ltd' })
  })

  it('a name with no prefix (a hand-written items file) is the name', () => {
    expect(partnerOf('Test Centre Ltd')).toEqual({ kind: 'supplier', name: 'Test Centre Ltd' })
  })

  it('the КОРЕКЦИЯ placeholder a correction is printed with is nobody\'s name', () => {
    expect(partnerOf('ПАРТНЬОРИ:2000 КОРЕКЦИЯ')).toEqual({ kind: 'correction', name: '' })
    expect(partnerOf('ПАРТНЬОРИ:2000   корекция')).toEqual({ kind: 'correction', name: '' })
  })

  it('no partner at all is nobody', () => {
    for (const raw of [undefined, null, '', '   ', 'ПАРТНЬОРИ:', 'ПАРТНЬОРИ:   ']) {
      expect(partnerOf(raw)).toEqual({ kind: 'nobody', name: '' })
    }
  })
})

describe('normalizeName — "the same name"', () => {
  it('ignores case, in Cyrillic too, and runs of whitespace', () => {
    expect(normalizeName('  Test   Centre\tLtd ')).toBe('test centre ltd')
    expect(normalizeName('ТЕСТ  СЕНТЕР ЕООД')).toBe('тест сентер еоод')
    expect(normalizeName('тест сентер еоод')).toBe(normalizeName('ТЕСТ СЕНТЕР ЕООД'))
  })

  it('is empty for nothing', () => {
    expect(normalizeName(undefined)).toBe('')
    expect(normalizeName(null)).toBe('')
    expect(normalizeName('   ')).toBe('')
  })

  it('does not fold look-alike letters: a Latin K is not a Cyrillic К', () => {
    expect(normalizeName('KOMET')).not.toBe(normalizeName('КOMET'))
  })
})

const c = (id: string, companyName: string | null | undefined, extra: Partial<SupplierCandidate> = {}): SupplierCandidate => ({ id, companyName, type: 'supplier', isActive: true, ...extra })

describe('pickSupplierByName — the ONE active supplier of exactly that name', () => {
  it('matches the same words whatever the case and the whitespace', () => {
    expect(pickSupplierByName('test centre ltd', [c('1', 'Test  Centre Ltd')])).toEqual({ status: 'matched', contactId: '1', name: 'Test  Centre Ltd' })
    expect(pickSupplierByName('ТЕСТ СЕНТЕР ЕООД', [c('1', ' тест   сентер еоод ')])).toMatchObject({ status: 'matched', contactId: '1' })
  })

  it('a different name is a different company: a longer name that holds the words, a near name', () => {
    expect(pickSupplierByName('Test Centre', [c('1', 'Test Centre Ltd'), c('2', 'The Test Centre'), c('3', 'Test Centre')])).toMatchObject({ status: 'matched', contactId: '3' })
    expect(pickSupplierByName('Test Centre', [c('1', 'Test Centre Ltd'), c('2', 'Test Center')])).toEqual({ status: 'none' })
  })

  it('a customer, or a deactivated contact, is not a supplier to book a receipt against', () => {
    expect(pickSupplierByName('Acme', [c('1', 'Acme', { type: 'customer' })])).toEqual({ status: 'none' })
    expect(pickSupplierByName('Acme', [c('1', 'Acme', { isActive: false })])).toEqual({ status: 'none' })
    expect(pickSupplierByName('Acme', [c('1', 'Acme', { type: 'customer' }), c('2', 'Acme', { isActive: false }), c('3', 'Acme')])).toMatchObject({ status: 'matched', contactId: '3' })
  })

  it('a contact that is both customer and supplier is a supplier; a missing type or flag counts as an active supplier', () => {
    expect(pickSupplierByName('Acme', [c('1', 'Acme', { type: 'both' })])).toMatchObject({ status: 'matched', contactId: '1' })
    expect(pickSupplierByName('Acme', [{ id: '1', companyName: 'Acme' }])).toMatchObject({ status: 'matched', contactId: '1' })
  })

  it('several active suppliers of that name are ambiguous, with how many: nothing is guessed', () => {
    expect(pickSupplierByName('Acme', [c('1', 'Acme'), c('2', ' acme '), c('3', 'Other')])).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('no candidate, an empty name and a contact with no company name resolve to nothing', () => {
    expect(pickSupplierByName('Acme', [])).toEqual({ status: 'none' })
    expect(pickSupplierByName('', [c('1', 'Acme')])).toEqual({ status: 'none' })
    expect(pickSupplierByName('   ', [c('1', '')])).toEqual({ status: 'none' })
    expect(pickSupplierByName('Acme', [c('1', null), c('2', undefined)])).toEqual({ status: 'none' })
  })
})

describe('the import\'s report', () => {
  const partner = (name: string): PartnerResult['partner'] => ({ kind: 'supplier', name })
  const matched: PartnerResult['match'] = { status: 'matched', contactId: 'x', name: 'Acme' }

  it('describes each answer in one line for the log', () => {
    expect(describeMatch('Acme', matched!)).toBe('supplier: Acme (x)')
    expect(describeMatch('Acme', { status: 'none' })).toContain('no active supplier is named "Acme"')
    expect(describeMatch('Acme', { status: 'ambiguous', count: 3 })).toContain('3 active suppliers are named "Acme"')
  })

  it('counts what resolved, lists each unresolved NAME once with its documents (the commonest first), and counts the nobodies', () => {
    const results: PartnerResult[] = [
      { docNumber: 'D1', partner: partner('Acme'), match: matched },
      { docNumber: 'D2', partner: partner('Ghost Ltd'), match: { status: 'none' } },
      { docNumber: 'D3', partner: partner('Zeta Ltd'), match: { status: 'none' } },
      { docNumber: 'D4', partner: partner('ghost   ltd'), match: { status: 'none' } },
      { docNumber: 'D5', partner: partner('Twin'), match: { status: 'ambiguous', count: 2 } },
      { docNumber: 'D6', partner: { kind: 'correction', name: '' } },
      { docNumber: 'D7', partner: { kind: 'nobody', name: '' } },
    ]
    const s = summarizePartners(results)
    expect(s.resolved).toBe(1)
    expect(s.nobody).toBe(2)
    expect(s.unresolved).toEqual([
      { name: 'Ghost Ltd', reason: 'none', documents: ['D2', 'D4'] },
      { name: 'Twin', reason: 'ambiguous', candidates: 2, documents: ['D5'] },
      { name: 'Zeta Ltd', reason: 'none', documents: ['D3'] },
    ])
  })

  it('the same name that matched none and that matched several are two different problems', () => {
    const s = summarizePartners([
      { docNumber: 'D1', partner: partner('Twin'), match: { status: 'none' } },
      { docNumber: 'D2', partner: partner('Twin'), match: { status: 'ambiguous', count: 2 } },
    ])
    expect(s.unresolved.map((u) => u.reason).sort()).toEqual(['ambiguous', 'none'])
  })

  it('a supplier with no answer at all is reported as unmatched, never as resolved', () => {
    const s = summarizePartners([{ docNumber: 'D1', partner: partner('Ghost') }])
    expect(s.resolved).toBe(0)
    expect(s.unresolved).toEqual([{ name: 'Ghost', reason: 'none', documents: ['D1'] }])
  })

  it('prints a count and each unresolved name with its documents; a clean run prints one line and no warning', () => {
    const clean = formatPartnerReport(summarizePartners([{ docNumber: 'D1', partner: partner('Acme'), match: matched }]))
    expect(clean).toEqual(['Suppliers: 1 document(s) name a supplier, 0 named one that could not be resolved.'])

    const lines = formatPartnerReport(summarizePartners([
      { docNumber: 'D1', partner: partner('Acme'), match: matched },
      { docNumber: 'D2', partner: partner('Ghost Ltd'), match: { status: 'none' } },
      { docNumber: 'D3', partner: partner('Ghost Ltd'), match: { status: 'none' } },
      { docNumber: 'D4', partner: partner('Twin'), match: { status: 'ambiguous', count: 2 } },
      { docNumber: 'D5', partner: { kind: 'correction', name: '' } },
    ]))
    expect(lines[0]).toBe('Suppliers: 1 document(s) name a supplier, 3 named one that could not be resolved, 1 name nobody (a correction, or no partner).')
    expect(lines[1]).toContain('2 partner name(s) matched no single active supplier, so 3 receipt(s) carry no supplier')
    // A receipt already booked is not changed: the advice is not "re-run".
    expect(lines[1]).toContain('before the next import')
    expect(lines[1]).toContain('a receipt already booked is not changed')
    expect(lines[1]).not.toContain('re-run')
    expect(lines[2]).toBe('   "Ghost Ltd" — no active supplier of that name — 2 document(s): D2, D3')
    expect(lines[3]).toBe('   "Twin" — 2 suppliers share that name — 1 document(s): D4')
    expect(lines).toHaveLength(4)
  })
})

describe('a document booked without its partner still says who it was', () => {
  it('the warning names the partner, and the reader gives the name back', () => {
    for (const name of ['ТЕСТ СЕНТЕР ЕООД', 'Test Centre Ltd', '„АЛФА" ООД', '"АЛФА" ЕООД', 'склад']) {
      expect(unmatchedPartnerOf(unmatchedPartnerWarning(name))).toBe(name)
    }
  })

  it('the opening words are the ones every stored analysis carries', () => {
    // `DocFile.analysis.diagnostics.warnings` holds this text for documents analysed since 2026-09: a reader that
    // stops recognising it loses the partner of every receipt booked that way. Change the words only with a reader
    // that still takes these.
    const stored = 'the document names „ТЕСТ СЕНТЕР ЕООД" as partner and no contact matches — booked without one. That is expected when the partner is another of the org\x27s OWN stores rather than a counterparty (goods handed to a sister store, a second warehouse LGR does not track yet); only add a contact if it really is one.'
    expect(unmatchedPartnerWarning('ТЕСТ СЕНТЕР ЕООД')).toBe(stored)
    expect(unmatchedPartnerOf(stored)).toBe('ТЕСТ СЕНТЕР ЕООД')
  })

  it('any other warning names nobody', () => {
    expect(unmatchedPartnerOf('partner: the name matches two contacts. Booked without one, so the invoice this note may later be converted into will not be recognised as its conversion.')).toBeUndefined()
    expect(unmatchedPartnerOf('line 3: no product matches')).toBeUndefined()
    for (const v of ['', undefined, null, 7]) expect(unmatchedPartnerOf(v)).toBeUndefined()
  })
})
