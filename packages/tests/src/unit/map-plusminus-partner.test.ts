/**
 * PlusMinus's partner directory → the contacts a daily import settles (`map-plusminus-partner.ts`).
 * Every name and number below is made up.
 */
import { describe, it, expect } from 'bun:test'
import {
  collectPartnerUses, fillsFor, idsOf, isInternalPartner, mapPartner, normalizeEik, normalizeVat, planPartnerContacts, splitPartnerKey,
  PARTNER_GROUPS_ARG, type LgrContact, type PartnerDirectory, type PartnerUse, type UsedDocument,
} from 'services/biz/doc-import/map-plusminus-partner'
import { MAX_CONTACT_ALIASES } from 'config/contact-aliases'

const uses = (...rows: [string, ('customer' | 'supplier')[]][]): Map<string, PartnerUse> =>
  new Map(rows.map(([key, roles]) => [key, { key, roles: new Set(roles), docs: [`doc ${key}`] }]))

const contact = (id: string, o: Partial<LgrContact> = {}): LgrContact => ({ id, type: 'customer', isActive: true, ...o })

describe('identifiers', () => {
  it('reads a ЕИК however it was typed, and nothing that is not one', () => {
    expect(normalizeEik('204 856 684')).toBe('204856684')
    expect(normalizeEik('204856684 ЕООД')).toBe('204856684')
    expect(normalizeEik('2048566841234')).toBe('2048566841234') // a branch: 13 digits
    expect(normalizeEik('7501010101')).toBe('7501010101') // 10 digits
    expect(normalizeEik('1.12500982E+008')).toBeUndefined() // Excel made it a float
    expect(normalizeEik('12345')).toBeUndefined()
    expect(normalizeEik('20485668412')).toBeUndefined() // 11 digits is no length of a ЕИК
    expect(normalizeEik('')).toBeUndefined()
  })

  it('reads a VAT number only with its country prefix', () => {
    expect(normalizeVat('BG 204 856 684')).toBe('BG204856684')
    expect(normalizeVat('bg204856684  ЕООД')).toBe('BG204856684')
    expect(normalizeVat('204856684')).toBeUndefined()
    expect(normalizeVat('BG12')).toBeUndefined()
  })

  it('finds a company by its number and by the first nine of its branch number; a placeholder finds nobody', () => {
    expect(idsOf('2048566841234').sort()).toEqual(['204856684', '2048566841234'])
    expect(idsOf('BG204856684', '204 856 684')).toEqual(['204856684'])
    expect(idsOf('999999999', '000000000', '123456789', '1234567890')).toEqual([])
  })
})

describe('mapPartner', () => {
  it('maps a customer-ledger entry the way the seeded contacts are mapped', () => {
    const f = mapPartner('КЛИЕНТИ:Тест Клиент - ООД', { БУЛСТАТ: '100 200 300', ИНДДС: 'BG100200300', АДРЕС: 'ул. Тест 1', ГРАД: 'гр.СОФИЯ', МОЛ: 'Иван Тестов', ТЕЛЕФОН: '0888 111 222' })
    expect(f).toEqual({
      name: 'Тест Клиент - ООД', eik: '100200300', vat: 'BG100200300', phone: '0888 111 222',
      address: { street: 'ул. Тест 1', city: 'СОФИЯ' }, contactPerson: 'Иван Тестов',
    })
  })

  it('reads the partner list\'s own property names, and derives the ЕИК from the VAT number when the БУЛСТАТ is empty', () => {
    const f = mapPartner('ПАРТНЬОРИ:Тест Доставчик ЕООД', { БУЛСТАТ: '', ИНДДС: 'BG200300400', 'ТЕЛ.': '02 123 4567', ГРАД: 'гр. ПЛОВДИВ' })
    expect(f.eik).toBe('200300400')
    expect(f.phone).toBe('02 123 4567')
    expect(f.address).toEqual({ street: 'ПЛОВДИВ', city: 'ПЛОВДИВ' })
  })

  it('never reads the civil number (ЕГН), and keeps a colon in a name', () => {
    const f = mapPartner('ПАРТНЬОРИ:Иван Тестов ЕТ', { ЕГН: '7501010101', ГРАД: 'гр.СОФИЯ' })
    expect(JSON.stringify(f)).not.toContain('7501010101')
    expect(f.eik).toBeUndefined()
    expect(splitPartnerKey('ПАРТНЬОРИ:СКЛАД:склад')).toEqual({ group: 'ПАРТНЬОРИ', name: 'СКЛАД:склад' })
  })

  it('asks for the groups the vendor\'s own client asks for', () => {
    expect(PARTNER_GROUPS_ARG).toBe('ДОСТАВЧИЦИ:; КЛИЕНТИ:; ПАРТНЬОРИ:; КОНТРАГЕНТИ:')
  })
})

describe('isInternalPartner', () => {
  it('is true for the org\'s own stores and warehouses, and for its own ЕИК', () => {
    expect(isInternalPartner('СКЛАД:склад')).toBe(true)
    expect(isInternalPartner('МАГАЗИН- ТЕСТ - СОФИЯ')).toBe(true)
    expect(isInternalPartner('Тест ООД', '100200300', '100 200 300'.replace(/\s/g, ''))).toBe(true)
    expect(isInternalPartner('Тест Доставчик ООД', '100200300', '200300400')).toBe(false)
    expect(isInternalPartner('Тест Доставчик ООД')).toBe(false)
  })
})

describe('collectPartnerUses', () => {
  const inv = (number: string, partner?: string): UsedDocument => ({ family: 'invoicem', number, header: { partner } })
  const rec = (number: string, partner: string | undefined, ...quantities: number[]): UsedDocument => ({ family: 'stokrazp', number, header: { partner }, lines: quantities.map((quantity) => ({ quantity })) })

  it('names a customer for every sales document and a supplier only for a receipt that brings stock in', () => {
    const u = collectPartnerUses([
      inv('1', 'КЛИЕНТИ:Тест Клиент'),
      inv('2', 'ПАРТНЬОРИ:Тест Клиент 2'),
      inv('3'), // no partner
      rec('10', 'ПАРТНЬОРИ:Тест Доставчик', 5, -1),
      rec('11', 'ПАРТНЬОРИ:Само Цени', 0), // price-only
      rec('12', 'ПАРТНЬОРИ:Само Излизане', -4), // only stock out
      rec('13', 'ПАРТНЬОРИ:2000 КОРЕКЦИЯ', 9), // the placeholder is nobody's name
      rec('14', undefined, 3),
    ])
    expect([...u.keys()].sort()).toEqual(['КЛИЕНТИ:Тест Клиент', 'ПАРТНЬОРИ:Тест Доставчик', 'ПАРТНЬОРИ:Тест Клиент 2'])
    expect([...u.get('ПАРТНЬОРИ:Тест Доставчик')!.roles]).toEqual(['supplier'])
    expect(u.get('КЛИЕНТИ:Тест Клиент')!.docs).toEqual(['invoicem 1'])
  })

  it('joins the roles of a partner that buys and sells', () => {
    const u = collectPartnerUses([inv('1', 'ПАРТНЬОРИ:Тест Двустранен'), rec('2', 'ПАРТНЬОРИ:Тест Двустранен', 1)])
    expect([...u.get('ПАРТНЬОРИ:Тест Двустранен')!.roles].sort()).toEqual(['customer', 'supplier'])
  })
})

const DIR: PartnerDirectory = {
  'КЛИЕНТИ:Нов Клиент - ООД': { БУЛСТАТ: '300400500', ИНДДС: 'BG300400500', АДРЕС: 'ул. Нова 5', ГРАД: 'гр.СОФИЯ', МОЛ: 'Петър Тестов' },
  'ПАРТНЬОРИ:Нов Доставчик ЕООД': { БУЛСТАТ: '400500600', ИНДДС: 'BG400500600', АДРЕС: 'бул. Нов 7', ГРАД: 'гр.ПЛОВДИВ', 'ТЕЛ.': '032 111 222' },
  'ПАРТНЬОРИ:Без Данни': { },
  'ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД': { БУЛСТАТ: '500600700', ИНДДС: 'BG500600700', АДРЕС: 'ул. Първа 1', ГРАД: 'гр.СОФИЯ' },
  'ПАРТНЬОРИ:Склад:склад': { },
  'ПАРТНЬОРИ:2000 КОРЕКЦИЯ': { },
}

describe('planPartnerContacts', () => {
  it('creates a contact nobody holds, with what PlusMinus knows, and leaves a partner with nothing known to the document import', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [],
      uses: uses(['КЛИЕНТИ:Нов Клиент - ООД', ['customer']], ['ПАРТНЬОРИ:Нов Доставчик ЕООД', ['supplier']], ['ПАРТНЬОРИ:Без Данни', ['customer']]),
    })
    const created = plan.items.filter((i) => i.kind === 'create')
    expect(created.map((i) => i.kind === 'create' && i.body)).toEqual([
      {
        type: 'customer', companyName: 'Нов Клиент - ООД', taxId: '300400500', taxNumber: '300400500', vatNumber: 'BG300400500',
        // FR-25a: the МОЛ in a field of its own, no longer a notes line
        addresses: [{ type: 'billing', street: 'ул. Нова 5', city: 'СОФИЯ', country: 'BG', isDefault: true }], representative: 'Петър Тестов', isActive: true,
      },
      {
        type: 'supplier', companyName: 'Нов Доставчик ЕООД', taxId: '400500600', taxNumber: '400500600', vatNumber: 'BG400500600', phone: '032 111 222',
        addresses: [{ type: 'billing', street: 'бул. Нов 7', city: 'ПЛОВДИВ', country: 'BG', isDefault: true }], isActive: true,
      },
    ])
    expect(plan.items.find((i) => i.kind === 'skip')).toMatchObject({ why: 'no-data', name: 'Без Данни' })
    expect(plan.counts).toMatchObject({ create: 2, skip: 1, update: 0 })
  })

  it('finds a partner whose name PlusMinus typed with a double space, in the document and in the directory alike', () => {
    const key = 'ПАРТНЬОРИ:ТЕСТ МВ  ООД'
    const dir: PartnerDirectory = { [key]: { БУЛСТАТ: '800900100', АДРЕС: 'бул. Европа 1', ГРАД: 'СОФИЯ' } }
    const docs: UsedDocument[] = [{ family: 'invoicem', number: '1', header: { partner: key } }]
    const plan = planPartnerContacts({ directory: dir, uses: collectPartnerUses(docs), contacts: [] })
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({ kind: 'create', name: 'ТЕСТ МВ  ООД' })
    // and the document's key with its spaces collapsed finds the same entry
    const collapsed = planPartnerContacts({ directory: dir, uses: uses(['ПАРТНЬОРИ:ТЕСТ МВ ООД', ['customer']]), contacts: [] })
    expect(collapsed.items[0]).toMatchObject({ kind: 'create', name: 'ТЕСТ МВ  ООД' })
  })

  it('creates a SUPPLIER PlusMinus knows only by name (a receipt can name only a supplier that exists), and advises on look-alikes', () => {
    const dir: PartnerDirectory = { 'ПАРТНЬОРИ:Тест-флекс България ООД': {}, 'ПАРТНЬОРИ:Тест-флекс Клиент': {} }
    const plan = planPartnerContacts({
      directory: dir,
      contacts: [contact('c1', { type: 'supplier', companyName: 'ТЕСТ ТРЕЙД ЕООД' })],
      uses: uses(['ПАРТНЬОРИ:Тест-флекс България ООД', ['supplier']], ['ПАРТНЬОРИ:Тест-флекс Клиент', ['customer']]),
    })
    const made = plan.items.find((i) => i.kind === 'create')
    if (made?.kind !== 'create') throw new Error('expected a create')
    expect(made.nameOnly).toBe(true)
    expect(made.body).toMatchObject({ type: 'supplier', companyName: 'Тест-флекс България ООД', isActive: true })
    expect(made.body.taxId).toBeUndefined()
    expect(made.body.notes).toContain('Създаден от партньор')
    // „Тест" starts both names, so the look-alike is named for a person to see; the contact is created all the same
    expect(made.similar).toEqual(['ТЕСТ ТРЕЙД ЕООД'])
    // a customer with nothing known is left to the invoice import
    expect(plan.items.find((i) => i.name === 'Тест-флекс Клиент')).toMatchObject({ kind: 'skip', why: 'no-data' })
  })

  it('names the contacts on file that start with the same word as a supplier it creates by name', () => {
    const plan = planPartnerContacts({
      directory: { 'ПАРТНЬОРИ:ТЕСТБОЛТ': {} },
      contacts: [contact('c1', { type: 'supplier', companyName: 'ТЕСТБОЛТ D.O.O.' }), contact('c2', { type: 'supplier', companyName: 'Друг ООД' })],
      uses: uses(['ПАРТНЬОРИ:ТЕСТБОЛТ', ['supplier']]),
    })
    expect(plan.items[0]).toMatchObject({ kind: 'create', nameOnly: true, similar: ['ТЕСТБОЛТ D.O.O.'] })
  })

  it('skips the org\'s own stores, the correction placeholder, and a partner the directory does not list', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [],
      uses: uses(['ПАРТНЬОРИ:Склад:склад', ['supplier']], ['ПАРТНЬОРИ:2000 КОРЕКЦИЯ', ['supplier']], ['ПАРТНЬОРИ:Непознат', ['customer']]),
    })
    expect(plan.items.map((i) => i.kind === 'skip' && i.why).sort()).toEqual(['correction', 'internal', 'not-in-directory'])
  })

  it('finds the contact by number when the names differ, fills what is empty, and gives the documents\' name as another name', () => {
    const contacts = [contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС - АД', taxId: '500600700', taxNumber: '500600700' })]
    const plan = planPartnerContacts({ directory: DIR, contacts, uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]) })
    expect(plan.items).toHaveLength(1)
    const u = plan.items[0]
    expect(u).toMatchObject({ kind: 'update', contactId: 'c1', by: 'eik' })
    if (u.kind !== 'update') throw new Error('unreachable')
    expect(u.body).toEqual({
      vatNumber: 'BG500600700',
      addresses: [{ type: 'billing', street: 'ул. Първа 1', city: 'СОФИЯ', country: 'BG', isDefault: true }],
      aliases: ['ТЕСТ ЕКСПРЕС АД'],
    })
    expect(u.changes).toEqual(['fill vatNumber', 'fill address', 'alias „ТЕСТ ЕКСПРЕС АД"'])
    // The caller's list is not edited by the plan.
    expect(contacts[0]).toEqual(contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС - АД', taxId: '500600700', taxNumber: '500600700' }))
  })

  it('is settled once its own body is applied: a second plan finds nothing to do', () => {
    const c = contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС - АД', taxId: '500600700', taxNumber: '500600700' })
    const first = planPartnerContacts({ directory: DIR, contacts: [c], uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]) })
    const u = first.items[0]
    if (u.kind !== 'update') throw new Error('expected an update')
    const settled: LgrContact = { ...c, vatNumber: u.body.vatNumber, addresses: [{ street: 'ул. Първа 1', city: 'СОФИЯ' }], aliases: u.body.aliases }
    const second = planPartnerContacts({ directory: DIR, contacts: [settled], uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]) })
    expect(second.items.map((i) => i.kind)).toEqual(['same'])
    expect(second.counts).toMatchObject({ create: 0, update: 0, same: 1 })
  })

  it('fills the number of a contact held by name alone, and does not add its own name as another name', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [contact('c1', { companyName: 'Нов Клиент - ООД' })], uses: uses(['КЛИЕНТИ:Нов Клиент - ООД', ['customer']]),
    })
    const u = plan.items[0]
    if (u.kind !== 'update') throw new Error('expected an update')
    expect(u.by).toBe('name')
    expect(u.body.aliases).toBeUndefined()
    expect(u.changes).toEqual(['fill taxId', 'fill taxNumber', 'fill vatNumber', 'fill address', 'fill representative'])
    expect(u.body.representative).toBe('Петър Тестов')
    expect(u.body.notes).toBeUndefined()
  })

  it('gives no second МОЛ to a contact that keeps one, in its field or still as the old notes line (FR-25a)', () => {
    const fields = mapPartner('КЛИЕНТИ:Нов Клиент - ООД', DIR['КЛИЕНТИ:Нов Клиент - ООД'])
    const full = { companyName: 'Нов Клиент - ООД', taxId: '300400500', taxNumber: '300400500', vatNumber: 'BG300400500', addresses: [{ street: 'ул. Нова 5' }] }
    for (const held of [{ representative: 'Друг Човек' }, { notes: 'МОЛ: Петър Тестов' }, { notes: 'МОЛ: Друг Човек · бележка' }]) {
      const { body, changes } = fillsFor(contact('c1', { ...full, ...held }), 'Нов Клиент - ООД', 'name', ['customer'], fields)
      expect(body).toEqual({})
      expect(changes).toEqual([])
    }
    // notes about something else are no МОЛ
    expect(fillsFor(contact('c1', { ...full, notes: 'моя бележка' }), 'Нов Клиент - ООД', 'name', ['customer'], fields).body).toEqual({ representative: 'Петър Тестов' })
  })

  it('takes the same words with other punctuation as the same company when no number contradicts it', () => {
    const plan = planPartnerContacts({
      directory: { 'ПАРТНЬОРИ:ТЕСТ 04 ООД': { ГРАД: 'гр.СОФИЯ' } },
      contacts: [contact('c1', { companyName: 'ТЕСТ-04 ООД' })], uses: uses(['ПАРТНЬОРИ:ТЕСТ 04 ООД', ['customer']]),
    })
    // "ТЕСТ 04" and "ТЕСТ-04" fold to the same words
    expect(plan.items[0]).toMatchObject({ kind: 'update', by: 'punctuation' })
    expect((plan.items[0] as any).body.aliases).toEqual(['ТЕСТ 04 ООД'])
  })

  it('leaves a name that a contact with ANOTHER ЕИК holds to a person, and does not create a second contact', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС АД', taxId: '999000111' })], uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]),
    })
    expect(plan.items.map((i) => i.kind)).toEqual(['conflict'])
    expect(plan.counts).toMatchObject({ conflict: 1, create: 0 })
  })

  it('does not revive or duplicate a deactivated contact', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС - АД', taxId: '500600700', isActive: false })], uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]),
    })
    expect(plan.items.map((i) => i.kind)).toEqual(['inactive'])
  })

  it('does not stop at a company held twice: the one named so, else the oldest', () => {
    const contacts = [
      contact('c2', { companyName: 'Друго Име', taxId: '500600700', taxNumber: '500600700', vatNumber: 'BG500600700', addresses: [{ street: 'ул. А' }] }),
      contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС АД', taxId: '500600700', taxNumber: '500600700', vatNumber: 'BG500600700', addresses: [{ street: 'ул. А' }] }),
      contact('c3', { companyName: 'Още Едно', taxId: '500600700', taxNumber: '500600700', vatNumber: 'BG500600700', addresses: [{ street: 'ул. А' }] }),
    ]
    const named = planPartnerContacts({ directory: DIR, contacts, uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]) })
    expect(named.items[0]).toMatchObject({ kind: 'same', contactId: 'c1' })
    const unnamed = planPartnerContacts({ directory: DIR, contacts: contacts.filter((c) => c.id !== 'c1'), uses: uses(['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', ['customer']]) })
    expect(unnamed.items[0]).toMatchObject({ kind: 'update', contactId: 'c2' })
  })

  it('refuses two contacts that merely share another name, but takes the older of two named exactly so', () => {
    const dir: PartnerDirectory = { 'ПАРТНЬОРИ:Общо Име': { ГРАД: 'гр.СОФИЯ' } }
    const shared = planPartnerContacts({
      directory: dir, uses: uses(['ПАРТНЬОРИ:Общо Име', ['customer']]),
      contacts: [contact('c1', { companyName: 'Първа', aliases: ['Общо Име'] }), contact('c2', { companyName: 'Втора', aliases: ['Общо Име'] })],
    })
    expect(shared.items.map((i) => i.kind)).toEqual(['ambiguous'])
    const twins = planPartnerContacts({
      directory: dir, uses: uses(['ПАРТНЬОРИ:Общо Име', ['customer']]),
      contacts: [contact('c2', { companyName: 'Общо Име' }), contact('c1', { companyName: 'Общо Име' })],
    })
    expect(twins.items[0]).toMatchObject({ contactId: 'c1' })
  })

  it('widens a contact to both when the documents use it in the other role', () => {
    const plan = planPartnerContacts({
      directory: DIR, contacts: [contact('c1', { type: 'customer', companyName: 'Нов Доставчик ЕООД', taxId: '400500600', taxNumber: '400500600', vatNumber: 'BG400500600', phone: 'x', addresses: [{ street: 'a' }] })],
      uses: uses(['ПАРТНЬОРИ:Нов Доставчик ЕООД', ['supplier']]),
    })
    expect(plan.items[0]).toMatchObject({ kind: 'update', body: { type: 'both' }, changes: ['type customer→both'] })
    expect(plan.counts.roles).toBe(1)
  })

  it('makes one contact of two partner names that share a number, with the second name as another name', () => {
    const dir: PartnerDirectory = {
      'ПАРТНЬОРИ:Двойник ООД': { БУЛСТАТ: '600700800', ГРАД: 'гр.СОФИЯ' },
      'КЛИЕНТИ:Двойник - ООД': { БУЛСТАТ: '600700800', ГРАД: 'гр.СОФИЯ' },
    }
    const plan = planPartnerContacts({ directory: dir, contacts: [], uses: uses(['ПАРТНЬОРИ:Двойник ООД', ['customer']], ['КЛИЕНТИ:Двойник - ООД', ['supplier']]) })
    expect(plan.items).toHaveLength(1)
    const c = plan.items[0]
    if (c.kind !== 'create') throw new Error('expected a create')
    expect(c.body.type).toBe('both')
    expect(c.body.aliases).toHaveLength(1)
    expect(plan.counts).toMatchObject({ create: 1, merged: 1 })
  })

  it('finds a head office by the number of its branch', () => {
    const plan = planPartnerContacts({
      directory: { 'ПАРТНЬОРИ:Клон ООД': { БУЛСТАТ: '7008009000001', ГРАД: 'гр.СОФИЯ' } },
      contacts: [contact('c1', { companyName: 'Клон Централа', taxId: '700800900', taxNumber: '700800900', addresses: [{ street: 'x' }] })],
      uses: uses(['ПАРТНЬОРИ:Клон ООД', ['customer']]),
    })
    expect(plan.items[0]).toMatchObject({ contactId: 'c1', by: 'eik' })
  })

  it('does not match two companies on a placeholder number', () => {
    const plan = planPartnerContacts({
      directory: { 'ПАРТНЬОРИ:Нов ООД': { БУЛСТАТ: '999999999', АДРЕС: 'ул. 1', ГРАД: 'гр.СОФИЯ' } },
      contacts: [contact('c1', { companyName: 'Стар ООД', taxId: '999999999' })],
      uses: uses(['ПАРТНЬОРИ:Нов ООД', ['customer']]),
    })
    expect(plan.items[0].kind).toBe('create')
  })

  it('catch-up: creates every ledger customer PlusMinus identifies, skips the nameless, fills the ones it holds', () => {
    const dir: PartnerDirectory = {
      'КЛИЕНТИ:Един ООД': { БУЛСТАТ: '110220330', АДРЕС: 'ул. 1', ГРАД: 'гр.СОФИЯ' },
      'КЛИЕНТИ:Два ООД': { БУЛСТАТ: '220330440', АДРЕС: 'ул. 2', ГРАД: 'гр.СОФИЯ' },
      'КЛИЕНТИ:Без Данни': {},
      'ПАРТНЬОРИ:Не Клиент': { БУЛСТАТ: '330440550', АДРЕС: 'ул. 3' },
    }
    const plan = planPartnerContacts({ directory: dir, contacts: [contact('c1', { companyName: 'Два ООД' })], uses: new Map(), allClients: true })
    expect(plan.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['skip:Без Данни', 'update:Два ООД', 'create:Един ООД'])
    // the partner list is never swept, only what the day names
  })

  it('writes nothing over what somebody typed', () => {
    const c = contact('c1', { companyName: 'Нов Доставчик ЕООД', type: 'supplier', taxId: '400500600', taxNumber: '400500600', vatNumber: 'BG0', phone: '111', notes: 'моя бележка', addresses: [{ street: 'моя улица' }] })
    const { body, changes } = fillsFor(c, 'Нов Доставчик ЕООД', 'name', ['supplier'], mapPartner('ПАРТНЬОРИ:Нов Доставчик ЕООД', DIR['ПАРТНЬОРИ:Нов Доставчик ЕООД']))
    expect(body).toEqual({})
    expect(changes).toEqual([])
  })

  it('adds no other name to a contact that keeps the most it may', () => {
    const full = Array.from({ length: MAX_CONTACT_ALIASES }, (_, i) => `Име ${i}`)
    const c = contact('c1', { companyName: 'ТЕСТ ЕКСПРЕС - АД', taxId: '500600700', taxNumber: '500600700', vatNumber: 'BG500600700', addresses: [{ street: 'x' }], aliases: full })
    const { body } = fillsFor(c, 'ТЕСТ ЕКСПРЕС АД', 'eik', ['customer'], mapPartner('ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД', DIR['ПАРТНЬОРИ:ТЕСТ ЕКСПРЕС АД']))
    expect(body.aliases).toBeUndefined()
  })
})
