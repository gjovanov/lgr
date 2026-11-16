import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestStockMovement, createTestUser, createTestWarehouse } from '../helpers/factories'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Contact, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { MAX_CONTACT_ALIASES, MAX_CONTACT_ALIAS_LENGTH } from 'config/contact-aliases'
import { deliveryNote, movementMarker } from 'config/movement-notes'
import { matchContact, matchSupplierByName } from 'services/biz/doc-import/matching'
import { applyReceiptSupplier, planReceiptSupplierBackfill } from '../../../../scripts/lib/receipt-supplier-backfill'

/**
 * FR-28.12 — a contact's other names („Also known as"): what a person says when a document writes a company
 * under a name no rule may guess (a short form, a respelling, another list's spelling).
 *
 * Through the route as `unified.ts` mounts it, then through every reader of a contact's NAME: the supplier rule
 * over the database, the Files import's contact ladder, the contact search, and the receipt backfill. Made-up
 * partners throughout.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let org: any, other: any, owner: any, token: string

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/org/${org._id}/invoicing/contact${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const stored = async (id: unknown) => (await Contact.findById(String(id)).lean().exec()) as any
const supplierIn = (orgId: any, companyName: string, extra: Record<string, unknown> = {}) =>
  createTestContact(orgId, { type: 'supplier', companyName, ...extra } as any)

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(contactController)
  org = await createTestOrg({ name: 'Други имена Тест', slug: 'contact-aliases-test' } as any)
  other = await createTestOrg({ name: 'Друг', slug: 'contact-aliases-other' } as any)
  owner = await createTestUser(org._id)
  token = await tokenFor({ id: String(owner._id), orgId: String(org._id) })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the route stores a contact\'s other names', () => {
  it('a new contact: cleaned, with the lowered mirror the search reads; its own name is not one of them', async () => {
    const res = await call('POST', '', { type: 'supplier', companyName: 'МАРШРУТ ТЕСТ ЕООД', aliases: ['  Маршрут   Тест ', 'МАРШРУТ ТЕСТ', 'маршрут тест еоод', '', 'M+T'] })
    expect(res.status).toBe(200)
    expect(res.json.contact.aliases).toEqual(['Маршрут Тест', 'M+T'])
    const doc = await stored(res.json.contact.id)
    expect(doc.aliases).toEqual(['Маршрут Тест', 'M+T'])
    expect(doc.aliasesLower).toEqual(['маршрут тест', 'm+t'])
  })

  it('a new contact with none keeps neither field, as every contact before this did', async () => {
    for (const body of [{}, { aliases: [] }, { aliases: ['   '] }]) {
      const res = await call('POST', '', { type: 'customer', companyName: `БЕЗ ДРУГИ ИМЕНА ${Object.keys(body).length}${JSON.stringify(body).length}`, ...body })
      expect(res.status).toBe(200)
      const doc = await stored(res.json.contact.id)
      expect('aliases' in doc).toBe(false)
      expect('aliasesLower' in doc).toBe(false)
    }
  })

  it('an edit replaces them; one that does not carry them leaves them; an empty list clears both fields', async () => {
    const c = await supplierIn(org._id, 'РЕДАКЦИЯ ТЕСТ ООД', { aliases: ['Стара'] })
    expect((await stored(c._id)).aliasesLower).toEqual(['стара'])

    const replaced = await call('PUT', `/${c._id}`, { aliases: ['Нова  Едно', 'НОВА ДВЕ'] })
    expect(replaced.status).toBe(200)
    expect(replaced.json.contact.aliases).toEqual(['Нова Едно', 'НОВА ДВЕ'])
    expect((await stored(c._id)).aliasesLower).toEqual(['нова едно', 'нова две'])

    const untouched = await call('PUT', `/${c._id}`, { phone: '0888 000 000' })
    expect(untouched.status).toBe(200)
    expect((await stored(c._id)).aliases).toEqual(['Нова Едно', 'НОВА ДВЕ'])
    expect((await stored(c._id)).aliasesLower).toEqual(['нова едно', 'нова две'])

    const cleared = await call('PUT', `/${c._id}`, { aliases: [] })
    expect(cleared.status).toBe(200)
    expect((await stored(c._id)).aliases).toEqual([])
    expect((await stored(c._id)).aliasesLower).toEqual([])
  })

  it('an edit that renames the contact to one of its other names drops that one', async () => {
    const c = await supplierIn(org._id, 'ПРЕИМЕНУВАН ТЕСТ ООД', { aliases: ['Кратко Име'] })
    const res = await call('PUT', `/${c._id}`, { companyName: 'КРАТКО ИМЕ', aliases: ['Кратко Име', 'Още Едно'] })
    expect(res.status).toBe(200)
    expect((await stored(c._id)).aliases).toEqual(['Още Едно'])
    // And against the name it already has, when the edit does not carry one.
    const again = await call('PUT', `/${c._id}`, { aliases: ['кратко  име', 'Трето'] })
    expect((await stored(c._id)).aliases).toEqual(['Трето'])
    expect(again.status).toBe(200)
  })

  it('refuses a document\'s worth of names, or of text in one', async () => {
    const tooMany = await call('POST', '', { type: 'supplier', companyName: 'МНОГО ИМЕНА ООД', aliases: Array.from({ length: MAX_CONTACT_ALIASES + 1 }, (_, i) => `име ${i}`) })
    expect(tooMany.status).toBe(422)
    const tooLong = await call('POST', '', { type: 'supplier', companyName: 'ДЪЛГО ИМЕ ООД', aliases: ['x'.repeat(MAX_CONTACT_ALIAS_LENGTH + 1)] })
    expect(tooLong.status).toBe(422)
    expect(await Contact.countDocuments({ orgId: org._id, companyName: { $in: ['МНОГО ИМЕНА ООД', 'ДЪЛГО ИМЕ ООД'] } } as any)).toBe(0)
    const atTheBound = await call('POST', '', { type: 'supplier', companyName: 'НА ГРАНИЦАТА ООД', aliases: ['x'.repeat(MAX_CONTACT_ALIAS_LENGTH)] })
    expect(atTheBound.status).toBe(200)
  })
})

describe('the contact search reads the other names', () => {
  beforeAll(async () => {
    await supplierIn(org._id, 'ТЪРСЕНЕ GMBH', { aliases: ['Кратката Форма', 'S+T'] })
    await supplierIn(org._id, 'ТЪРСЕНЕ ДРУГ ООД')
    await createTestContact(org._id, { type: 'customer', companyName: 'КЛИЕНТ ТЪРСЕНЕ ЕООД', aliases: ['Кратката Клиентска'] } as any)
    await supplierIn(other._id, 'ЧУЖД ТЪРСЕНЕ ООД', { aliases: ['Кратката Форма'] })
  })

  const names = async (query: string) => {
    const res = await call('GET', `?size=50&${query}`)
    expect(res.status).toBe(200)
    return (res.json.contacts as any[]).map(c => c.companyName).sort()
  }

  it('finds a contact by part of an other name, whatever its case, in Cyrillic', async () => {
    expect(await names(`search=${encodeURIComponent('кратката')}`)).toEqual(['КЛИЕНТ ТЪРСЕНЕ ЕООД', 'ТЪРСЕНЕ GMBH'])
    expect(await names(`search=${encodeURIComponent('КРАТКАТА ФОРМА')}`)).toEqual(['ТЪРСЕНЕ GMBH'])
  })

  it('a sign in the name is searched as it is typed', async () => {
    expect(await names(`search=${encodeURIComponent('s+t')}`)).toEqual(['ТЪРСЕНЕ GMBH'])
  })

  it('narrows by type like any search, and never reads another organization', async () => {
    expect(await names(`type=supplier&search=${encodeURIComponent('кратката')}`)).toEqual(['ТЪРСЕНЕ GMBH'])
    expect(await names(`type=customer&search=${encodeURIComponent('кратката')}`)).toEqual(['КЛИЕНТ ТЪРСЕНЕ ЕООД'])
  })

  it('words may be found in different names of the same contact; a word in none of them finds nothing', async () => {
    expect(await names(`search=${encodeURIComponent('gmbh форма')}`)).toEqual(['ТЪРСЕНЕ GMBH'])
    expect(await names(`search=${encodeURIComponent('форма няматакава')}`)).toEqual([])
  })
})

describe('matchSupplierByName — the supplier rule over the database', () => {
  let s: Record<string, any>
  let id: string
  beforeAll(async () => {
    const o = await createTestOrg({ name: 'Правило', slug: 'contact-aliases-rule' } as any)
    id = String(o._id)
    s = {
      short: await supplierIn(o._id, 'F.ПРАВИЛО Nchfg.GMBH', { aliases: ['ПРАВИЛО', 'П+Н'] }),
      spaced: await supplierIn(o._id, 'СД ПРАВИЛО-7 ИВАНОВ И С-ИЕ', { aliases: ['ПРАВИЛО - 7 СД'] }),
      named: await supplierIn(o._id, 'ИМЕ ТРЕЙД'),
      knownAsNamed: await supplierIn(o._id, 'ИМЕ ТРЕЙД ЕООД', { aliases: ['ИМЕ ТРЕЙД', 'Име Друго'] }),
      hyphen: await supplierIn(o._id, 'ТИРЕ-04 ООД'),
      knownAsHyphen: await supplierIn(o._id, 'СЪВСЕМ ДРУГ ООД', { aliases: ['ТИРЕ - 04 ООД'] }),
      twinA: await supplierIn(o._id, 'ПЪРВИ БЛИЗНАК ООД', { aliases: ['Близнак'] }),
      twinB: await createTestContact(o._id, { type: 'both', companyName: 'ВТОРИ БЛИЗНАК ООД', aliases: ['БЛИЗНАК'] } as any),
      customer: await createTestContact(o._id, { type: 'customer', companyName: 'КЛИЕНТ ООД', aliases: ['Само Клиент'] } as any),
      gone: await supplierIn(o._id, 'СПРЯН ООД', { aliases: ['Спряното Име'], isActive: false }),
    }
    await supplierIn(other._id, 'ЧУЖД ООД', { aliases: ['ПРАВИЛО'] })
  })

  it('a short form, initials and another spacing find the supplier that keeps them', async () => {
    expect(await matchSupplierByName(id, 'Правило')).toEqual({ status: 'matched', contactId: String(s.short._id), name: 'F.ПРАВИЛО Nchfg.GMBH', by: 'alias' })
    expect(await matchSupplierByName(id, 'п+н')).toMatchObject({ status: 'matched', contactId: String(s.short._id), by: 'alias' })
    expect(await matchSupplierByName(id, 'ПРАВИЛО-7 СД')).toMatchObject({ status: 'matched', contactId: String(s.spaced._id), by: 'alias' })
  })

  it('a supplier NAMED so comes first, exactly or but for its punctuation', async () => {
    expect(await matchSupplierByName(id, 'ИМЕ ТРЕЙД')).toEqual({ status: 'matched', contactId: String(s.named._id), name: 'ИМЕ ТРЕЙД' })
    expect(await matchSupplierByName(id, 'ТИРЕ - 04 ООД')).toEqual({ status: 'matched', contactId: String(s.hyphen._id), name: 'ТИРЕ-04 ООД', by: 'punctuation' })
    // Its other other name is still its own.
    expect(await matchSupplierByName(id, 'име друго')).toMatchObject({ status: 'matched', contactId: String(s.knownAsNamed._id), by: 'alias' })
  })

  it('two suppliers that keep the same name are nobody; a customer\'s or a deactivated supplier\'s other name is nobody\'s', async () => {
    expect(await matchSupplierByName(id, 'близнак')).toEqual({ status: 'ambiguous', count: 2 })
    expect(await matchSupplierByName(id, 'Само Клиент')).toEqual({ status: 'none' })
    expect(await matchSupplierByName(id, 'Спряното Име')).toEqual({ status: 'none' })
  })

  it('never reads another organization\'s names', async () => {
    expect(await matchSupplierByName(String(other._id), 'П+Н')).toEqual({ status: 'none' })
    expect(await matchSupplierByName(String(other._id), 'ПРАВИЛО')).toMatchObject({ status: 'matched', name: 'ЧУЖД ООД', by: 'alias' })
  })
})

describe('matchContact — the Files import\'s contact ladder', () => {
  let c: Record<string, any>
  let id: string
  const party = (name: string, company_id?: string) => ({ name, ...(company_id ? { company_id } : {}) }) as any
  const find = async (name: string, side: 'customer' | 'supplier' = 'supplier', company_id?: string) => {
    let refused: string | undefined
    const match = await matchContact(id, party(name, company_id), side, { create: false, enrich: false, onRefused: (r) => { refused = r } })
    return { contactId: match?.contactId, refused }
  }
  beforeAll(async () => {
    const o = await createTestOrg({ name: 'Стълба', slug: 'contact-aliases-ladder' } as any)
    id = String(o._id)
    c = {
      initials: await supplierIn(o._id, 'СТЪЛБА+ПАРТНЬОР GMBH', { aliases: ['С+П'], taxNumber: '111111111' }),
      // Two contacts hold the words „ЕДНО ИМЕ": without an other name the ladder refuses to choose.
      first: await supplierIn(o._id, 'ЕДНО ИМЕ СОФИЯ ООД', { aliases: ['Едно Име'] }),
      second: await supplierIn(o._id, 'ЕДНО ИМЕ ПЛОВДИВ ООД'),
      named: await supplierIn(o._id, 'ТОЧНО ИМЕ'),
      knownAsNamed: await supplierIn(o._id, 'ДРУГА ФИРМА ООД', { aliases: ['Точно Име'] }),
      sharedA: await supplierIn(o._id, 'ОБЩО ПЪРВА ООД', { aliases: ['Общото'] }),
      sharedB: await supplierIn(o._id, 'ОБЩО ВТОРА ООД', { aliases: ['ОБЩОТО'] }),
      customer: await createTestContact(o._id, { type: 'customer', companyName: 'КЛИЕНТ СТЪЛБА ЕООД', aliases: ['Клиентът'] } as any),
    }
  })

  it('a name no contact carries and no word search finds is the contact that keeps it as an other name', async () => {
    expect(await find('с+п')).toEqual({ contactId: String(c.initials._id), refused: undefined })
  })

  it('an other name decides where the words alone match several contacts', async () => {
    expect(await find('ЕДНО ИМЕ')).toEqual({ contactId: String(c.first._id), refused: undefined })
  })

  it('a contact NAMED exactly so comes before another contact\'s other name', async () => {
    expect(await find('точно име')).toEqual({ contactId: String(c.named._id), refused: undefined })
  })

  it('two contacts that keep the same other name are refused, not picked from', async () => {
    const r = await find('общото')
    expect(r.contactId).toBeUndefined()
    expect(r.refused).toContain('2 contacts match')
  })

  it('reads the side asked for: a customer\'s other name is no supplier, and the other way round', async () => {
    expect((await find('Клиентът', 'supplier')).contactId).toBeUndefined()
    expect((await find('Клиентът', 'customer')).contactId).toBe(String(c.customer._id))
    expect((await find('С+П', 'customer')).contactId).toBeUndefined()
  })

  it('a document that carries ANOTHER tax number is another company, whatever it is called', async () => {
    expect((await find('С+П', 'supplier', '999999999')).contactId).toBeUndefined()
    expect((await find('С+П', 'supplier', '111111111')).contactId).toBe(String(c.initials._id))
  })
})

describe('the receipt backfill names a receipt by its supplier\'s other name', () => {
  let o: any, by: any, known: any, movement: any, named: any
  beforeAll(async () => {
    o = await createTestOrg({ name: 'Попълване', slug: 'contact-aliases-backfill' } as any)
    by = await createTestUser(o._id)
    const warehouse = await createTestWarehouse(o._id)
    const product = await createTestProduct(o._id)
    known = await supplierIn(o._id, 'F.ПОПЪЛВАНЕ Nchfg.GMBH', { aliases: ['ПОПЪЛВАНЕ'] })
    named = await supplierIn(o._id, 'ПОПЪЛВАНЕ ТРЕЙД')
    await supplierIn(o._id, 'ПОПЪЛВАНЕ ТРЕЙД ЕООД', { aliases: ['Попълване Трейд'] })
    const receipt = (n: number, partner: string) => createTestStockMovement(o._id, {
      movementNumber: `SM-2026-0000${n}`, type: 'receipt', status: 'completed', date: new Date(Date.UTC(2026, 7, n)),
      toWarehouseId: warehouse._id, createdBy: by._id,
      lines: [{ productId: product._id, quantity: 4, unitCost: 2.5, totalCost: 10 }], totalAmount: 10,
      notes: deliveryNote('2026-08-01', movementMarker('goods_receipt', String(3000000000 + n)), `ПАРТНЬОРИ:${partner}`),
    } as any)
    movement = await receipt(1, 'Попълване')
    await receipt(2, 'ПОПЪЛВАНЕ ТРЕЙД')
    await receipt(3, 'НЯМА ТАКЪВ')
  })

  it('plans it with the rule that found it, a supplier named so first, and still reports a name that is nobody\'s', async () => {
    const { plans, unresolved, counts } = await planReceiptSupplierBackfill(String(o._id))
    expect(plans.map(p => [p.movementNumber, p.contactId, p.rule, p.supplierName])).toEqual([
      ['SM-2026-00001', String(known._id), 'alias', 'F.ПОПЪЛВАНЕ Nchfg.GMBH'],
      ['SM-2026-00002', String(named._id), 'name', 'ПОПЪЛВАНЕ ТРЕЙД'],
    ])
    expect(unresolved.map(u => [u.name, u.reason])).toEqual([['НЯМА ТАКЪВ', 'none']])
    expect(counts).toMatchObject({ receipts: 3, resolved: 2, unresolved: 1 })
  })

  it('writes the supplier, and a second plan has nothing left for it', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(o._id))
    const plan = plans.find(p => p.movementId === String(movement._id))!
    expect(await applyReceiptSupplier(String(o._id), plan, by._id, 'test run')).toBe(true)
    expect(String(((await StockMovement.findById(movement._id).lean().exec()) as any).contactId)).toBe(String(known._id))
    const again = await planReceiptSupplierBackfill(String(o._id))
    expect(again.plans.map(p => p.movementNumber)).toEqual(['SM-2026-00002'])
  })
})
