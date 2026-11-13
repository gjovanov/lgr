import { describe, it, expect } from 'bun:test'
import { mongoose } from 'db/connection'
import { AccountingAnalytic, Contact, FixedAsset, JournalEntry, Org, orgForClient } from 'db/models'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { hasRepresentative, legacyRepresentativeOf } from 'config/contact-representative'
import { planRepresentativeMoves, representativeWrites, undoWrites } from '../../../../scripts/lib/contact-representative-backfill'

/**
 * FR-25a: what the accountant's books carry that our collections had no place for. Each new field is optional, with
 * no default: a document written before it keeps none of them, so nothing needs a backfill, and each round-trips
 * through its model typed. Made-up values throughout.
 */

const id = () => new mongoose.Types.ObjectId()

const HEADER_KEYS = [
  'paymentCode', 'paidAmount', 'paidCash', 'taxEventDate', 'vatRate', 'vatRule', 'vatExemptionReason', 'registerDocType', 'protocolType',
  'reasonRef', 'customsRef', 'bankOperation', 'reportingMonth', 'links', 'docOptions', 'source',
]

const entry = (over: Record<string, unknown> = {}) => new JournalEntry({
  orgId: id(), entryNumber: 'PM-2025-000001', date: new Date('2025-03-03'), fiscalPeriodId: id(), description: 'Стоки', createdBy: id(), ...over,
})

describe('JournalEntry: the document header (FR-25a)', () => {
  it('keeps every field it is given, each as its type', () => {
    const e = entry({
      paymentCode: '2', paidAmount: '120.5', paidCash: 0, taxEventDate: '2025-03-03', vatRate: 20, vatRule: 'ВОП',
      vatExemptionReason: 'чл. 0 от закона', registerDocType: '3', protocolType: 'p117', reasonRef: '-ФЕ 0000000100/01.03.2025',
      customsRef: '00XX0000000000000', bankOperation: 'Плащане', reportingMonth: '202504',
      links: [{ docType: '+ББ', docNumber: '901', date: '2025-03-12', amount: 120, amountFx: 61.35 }],
      docOptions: { exportInvoice: 'true', paidType: '2' },
      source: { createdBy: 'Оператор', createdAt: '2025-03-04T08:15:30.123Z', modifiedBy: 'Оператор', modifiedAt: '2025-03-05T07:15:00.000Z', version: '20240101' },
    })
    expect(e.validateSync()).toBeUndefined()
    const o: any = e.toObject()
    expect(o).toMatchObject({
      paymentCode: '2', paidAmount: 120.5, paidCash: 0, vatRate: 20, vatRule: 'ВОП', registerDocType: '3', protocolType: 'p117',
      reasonRef: '-ФЕ 0000000100/01.03.2025', customsRef: '00XX0000000000000', bankOperation: 'Плащане', reportingMonth: '202504',
      docOptions: { exportInvoice: 'true', paidType: '2' },
    })
    expect(o.taxEventDate).toEqual(new Date('2025-03-03'))
    expect(o.links).toEqual([{ docType: '+ББ', docNumber: '901', date: new Date('2025-03-12'), amount: 120, amountFx: 61.35 }])
    expect(o.source).toEqual({
      createdBy: 'Оператор', createdAt: new Date('2025-03-04T08:15:30.123Z'), modifiedBy: 'Оператор', modifiedAt: new Date('2025-03-05T07:15:00.000Z'), version: '20240101',
    })
  })

  it('an entry given none of it keeps none of it: no defaults, so no entry from before needs touching', () => {
    const o: any = entry().toObject()
    for (const key of HEADER_KEYS) expect(o).not.toHaveProperty(key)
  })

  it('a link names its document', () => {
    const errors = entry({ links: [{ docNumber: '901' }] }).validateSync()?.errors ?? {}
    expect(Object.keys(errors)).toContain('links.0.docType')
  })
})

describe('AccountingAnalytic and FixedAsset: the file\'s own properties (FR-25a)', () => {
  const params = [{ key: 'НАЧ.АМ.', value: '12.5' }, { key: 'КАТ', value: '2' }, { key: 'МОЛ', value: '' }]

  it('an analytic keeps its properties in file order, a name with dots included', () => {
    const a = new AccountingAnalytic({ orgId: id(), path: 'ДА:Машина', root: 'ДА', name: 'Машина', nameLower: 'машина', kind: 'fixed_asset', params })
    expect(a.validateSync()).toBeUndefined()
    expect((a.toObject() as any).params).toEqual(params)
    expect(new AccountingAnalytic({ orgId: id(), path: 'ДА', root: 'ДА', name: 'ДА', nameLower: 'да' }).toObject()).not.toHaveProperty('params')
    const nameless = new AccountingAnalytic({ orgId: id(), path: 'ДА:Х', root: 'ДА', name: 'Х', nameLower: 'х', params: [{ value: 'x' }] })
    expect(Object.keys(nameless.validateSync()?.errors ?? {})).toContain('params.0.key')
  })

  it('a fixed asset keeps its tax side and its properties, and has none until given them', () => {
    const base = {
      orgId: id(), code: 'FA-1', name: 'Машина', category: 'machinery', accountId: id(), depreciationAccountId: id(), accumulatedDepAccountId: id(),
      purchaseDate: new Date('2024-01-01'), purchasePrice: 100, usefulLifeMonths: 40, depreciationMethod: 'straight_line', currentValue: 100,
    }
    const a = new FixedAsset({ ...base, taxCategory: '2', inServiceDate: '2024-01-15', taxDepreciationRate: '30', taxValue: 100, taxUsefulLifeMonths: 40, params })
    expect(a.validateSync()).toBeUndefined()
    expect(a.toObject()).toMatchObject({ taxCategory: '2', inServiceDate: new Date('2024-01-15'), taxDepreciationRate: 30, taxValue: 100, taxUsefulLifeMonths: 40, params })
    const plain: any = new FixedAsset(base).toObject()
    for (const key of ['taxCategory', 'inServiceDate', 'taxDepreciationRate', 'taxValue', 'taxUsefulLifeMonths', 'params']) expect(plain).not.toHaveProperty(key)
  })
})

describe('Contact and Org: the person responsible, and where documents are issued (FR-25a)', () => {
  it('a contact keeps its МОЛ in a field of its own', () => {
    const c = new Contact({ orgId: id(), type: 'customer', companyName: 'Клиент А', representative: 'Лице Тестово' })
    expect(c.validateSync()).toBeUndefined()
    expect(c.toObject()).toMatchObject({ representative: 'Лице Тестово' })
    expect(new Contact({ orgId: id(), type: 'customer' }).toObject()).not.toHaveProperty('representative')
  })

  it('an org keeps its representative, place of issue and activity code, shows them to its client, and they are its home\'s', () => {
    const org = new Org({ name: 'Тест', slug: 'test', representative: 'Лице Тестово', placeOfIssue: 'гр. Пример', activityCode: '0000' })
    expect(org.validateSync()).toBeUndefined()
    expect(orgForClient(org.toJSON() as any)).toMatchObject({ representative: 'Лице Тестово', placeOfIssue: 'гр. Пример', activityCode: '0000' })
    for (const field of ['representative', 'placeOfIssue', 'activityCode']) expect(REPLICATION_META.Org.home).toContain(field)
  })
})

describe('the МОЛ that was a notes line (FR-25a)', () => {
  it('reads a name only from notes that are the old line and nothing else', () => {
    expect(legacyRepresentativeOf('МОЛ: Лице Тестово')).toBe('Лице Тестово')
    expect(legacyRepresentativeOf('  МОЛ: Лице Тестово  ')).toBe('Лице Тестово')
    for (const notes of ['МОЛ: Лице · Създаден от партньор', 'МОЛ: Лице\nдруго', 'бележка. МОЛ: Лице', 'МОЛ:Лице', 'МОЛ: ', '', undefined, 5]) {
      expect(legacyRepresentativeOf(notes)).toBeUndefined()
    }
  })

  it('a contact has one when its field holds it, or its notes still start with the old line', () => {
    expect(hasRepresentative({ representative: 'Лице' })).toBe(true)
    expect(hasRepresentative({ notes: 'МОЛ: Лице' })).toBe(true)
    expect(hasRepresentative({ notes: 'МОЛ: Лице · Създаден от партньор' })).toBe(true)
    expect(hasRepresentative({ notes: 'моя бележка' })).toBe(false)
    expect(hasRepresentative({ representative: '  ' })).toBe(false)
    expect(hasRepresentative({})).toBe(false)
  })

  it('the backfill moves the line where nothing is set, clears it where the same name is, and leaves the rest', () => {
    const [a, b, c, d, e, f] = [id(), id(), id(), id(), id(), id()]
    const { moves, counts } = planRepresentativeMoves([
      { _id: a, notes: 'МОЛ: Лице Едно' },
      { _id: b, notes: 'МОЛ: Лице Две', representative: 'Лице Две' },
      { _id: c, notes: 'МОЛ: Лице Три', representative: 'Друго Лице' },
      { _id: d, notes: 'моя бележка' },
      { _id: e, notes: '' },
      { _id: f },
    ])
    expect(counts).toEqual({ withNotes: 4, otherNotes: 1, move: 1, clear: 1, conflict: 1 })
    expect(moves).toEqual([
      { kind: 'move', id: String(a), notes: 'МОЛ: Лице Едно', name: 'Лице Едно' },
      { kind: 'clear', id: String(b), notes: 'МОЛ: Лице Две', name: 'Лице Две' },
      { kind: 'conflict', id: String(c) },
    ])

    const orgId = String(id())
    const [move, clear, ...rest] = representativeWrites(orgId, moves)
    expect(rest).toEqual([])
    // each write is conditional on what the plan read: an edit made since is skipped, never overwritten
    expect(move.updateOne.filter).toMatchObject({ notes: 'МОЛ: Лице Едно' })
    expect(move.updateOne.filter.$or).toBeTruthy()
    expect(move.updateOne.update).toEqual({ $set: { representative: 'Лице Едно' }, $unset: { notes: 1 } })
    expect(clear.updateOne.filter).toMatchObject({ notes: 'МОЛ: Лице Две', representative: 'Лице Две' })
    expect(clear.updateOne.update).toEqual({ $unset: { notes: 1 } })

    const [undoMove, undoClear] = undoWrites(orgId, moves)
    expect(undoMove.updateOne.update).toEqual({ $set: { notes: 'МОЛ: Лице Едно' }, $unset: { representative: 1 } })
    expect(undoClear.updateOne.update).toEqual({ $set: { notes: 'МОЛ: Лице Две' } })
    expect(undoMove.updateOne.filter).toMatchObject({ representative: 'Лице Едно', notes: { $exists: false } })
  })
})
