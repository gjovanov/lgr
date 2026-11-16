import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { mongoose } from 'db/connection'
import { Contact } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { MAX_REPRESENTATIVE_LENGTH } from 'config/party-identity'
import { applyMirrorWrites, contactsWithRepresentative, planRepresentativeMirror } from '../../../../scripts/lib/contact-representative-mirror'
import { applyWrites, contactsWithNotes, planRepresentativeMoves, representativeWrites } from '../../../../scripts/lib/contact-representative-backfill'

/**
 * FR-25a §3.5: a contact's МОЛ through the routes as `unified.ts` mounts them: bounded, stored trimmed, cleared by an
 * empty box, and found by the contact search through its lowered mirror. Then the two backfills that bring the
 * contacts from before up to that: the mirror of a МОЛ written without one, and the МОЛ still kept as a notes line.
 * Made-up names throughout.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let org: any, other: any, token: string

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/org/${org._id}/invoicing/contact${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const stored = async (id: unknown) => (await Contact.findById(String(id)).lean().exec()) as any
const names = async (search: string) => {
  const res = await call('GET', `?size=50&search=${encodeURIComponent(search)}`)
  expect(res.status).toBe(200)
  return (res.json.contacts as any[]).map(c => c.companyName).sort()
}
/** A contact as a release before the mirror wrote it: straight into the collection, past the model's plugin. */
const rawContact = async (orgId: unknown, fields: Record<string, unknown>) => {
  const _id = new mongoose.Types.ObjectId()
  const at = new Date('2026-01-02T10:00:00Z')
  await Contact.collection.insertOne({ _id, orgId, type: 'customer', isActive: true, addresses: [], bankDetails: [], createdAt: at, updatedAt: at, ...fields } as any)
  return _id
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(contactController)
  org = await createTestOrg({ name: 'МОЛ Тест', slug: 'contact-representative-test' } as any)
  other = await createTestOrg({ name: 'Друг', slug: 'contact-representative-other' } as any)
  const owner = await createTestUser(org._id)
  token = await (signer as any).decorator.jwt.sign({
    id: String(owner._id), orgId: String(org._id), role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the МОЛ through the contact routes', () => {
  let id: string

  it('a new contact keeps it trimmed, with the mirror the search reads', async () => {
    const res = await call('POST', '', { type: 'customer', companyName: 'КЛИЕНТ МОЛ ЕООД', representative: '  Лице Тестово  ' })
    expect(res.status).toBe(200)
    id = res.json.contact._id ?? res.json.contact.id
    expect(await stored(id)).toMatchObject({ representative: 'Лице Тестово', representativeLower: 'лице тестово' })
  })

  it('a new contact sent a blank one keeps none', async () => {
    const res = await call('POST', '', { type: 'customer', companyName: 'БЕЗ МОЛ ООД', representative: '   ' })
    expect(res.status).toBe(200)
    const doc = await stored(res.json.contact._id ?? res.json.contact.id)
    expect('representative' in doc).toBe(false)
    expect('representativeLower' in doc).toBe(false)
  })

  it('an update trims it; a save that does not send it keeps it', async () => {
    expect((await call('PUT', `/${id}`, { representative: 'Лице Ново ' })).status).toBe(200)
    expect(await stored(id)).toMatchObject({ representative: 'Лице Ново', representativeLower: 'лице ново' })
    expect((await call('PUT', `/${id}`, { phone: '+359 000' })).status).toBe(200)
    expect(await stored(id)).toMatchObject({ representative: 'Лице Ново', phone: '+359 000' })
  })

  it('an empty box clears it, as it does every text field of the form', async () => {
    expect((await call('PUT', `/${id}`, { representative: '' })).status).toBe(200)
    expect(await stored(id)).toMatchObject({ representative: '', representativeLower: '' })
    expect((await call('PUT', `/${id}`, { representative: 'Лице Тестово' })).status).toBe(200)
  })

  it(`takes ${MAX_REPRESENTATIVE_LENGTH} characters and refuses more, storing nothing`, async () => {
    const atBound = 'Л'.repeat(MAX_REPRESENTATIVE_LENGTH)
    expect((await call('POST', '', { type: 'customer', companyName: 'НА ГРАНИЦАТА ООД', representative: atBound })).status).toBe(200)
    expect((await call('POST', '', { type: 'customer', companyName: 'НАД ГРАНИЦАТА ООД', representative: `${atBound}Л` })).status).toBe(422)
    expect(await Contact.countDocuments({ orgId: org._id, companyName: 'НАД ГРАНИЦАТА ООД' })).toBe(0)
    expect((await call('PUT', `/${id}`, { representative: `${atBound}Л` })).status).toBe(422)
    expect((await stored(id)).representative).toBe('Лице Тестово')
  })
})

describe('the contact search reads the МОЛ', () => {
  beforeAll(async () => {
    await call('POST', '', { type: 'supplier', companyName: 'ДОСТАВЧИК МОЛ ООД', representative: 'Лице Търсено' })
    await Contact.create({ orgId: other._id, type: 'customer', companyName: 'ЧУЖД КЛИЕНТ ООД', representative: 'Лице Търсено' } as any)
  })

  it('finds a contact by part of its МОЛ, whatever its case, in Cyrillic, and never in another organization', async () => {
    expect(await names('лице търсено')).toEqual(['ДОСТАВЧИК МОЛ ООД'])
    expect(await names('ТЪРСЕНО')).toEqual(['ДОСТАВЧИК МОЛ ООД'])
  })

  it('still finds a contact by its own name', async () => {
    expect(await names('доставчик мол')).toEqual(['ДОСТАВЧИК МОЛ ООД'])
  })
})

describe('the backfill of the mirror: a МОЛ written before it', () => {
  it('writes what the plugin would have, so the search finds it; drops a mirror whose МОЛ is gone; a rerun finds nothing', async () => {
    const old = await rawContact(org._id, { companyName: 'СТАР КЛИЕНТ ООД', representative: 'Лице Отпреди' })
    const stale = await rawContact(org._id, { companyName: 'БЕЗ МОЛ ВЕЧЕ ООД', representativeLower: 'някой' })
    const kept = await rawContact(org._id, { companyName: 'С ОГЛЕДАЛО ООД', representative: 'Лице Огледало', representativeLower: 'лице огледало' })
    expect(await names('отпреди')).toEqual([])

    const plan = planRepresentativeMirror(await contactsWithRepresentative(org._id))
    expect(plan.counts.set).toBe(1)
    expect(plan.counts.unset).toBe(1)
    expect(await applyMirrorWrites(plan.ops)).toBe(2)

    expect(await stored(old)).toMatchObject({ representative: 'Лице Отпреди', representativeLower: 'лице отпреди' })
    expect('representativeLower' in await stored(stale)).toBe(false)
    expect(await stored(kept)).toMatchObject({ representativeLower: 'лице огледало' })
    // only the mirror: nothing about the contact changed
    expect((await stored(old)).updatedAt.toISOString()).toBe('2026-01-02T10:00:00.000Z')
    expect(await names('ОТПРЕДИ')).toEqual(['СТАР КЛИЕНТ ООД'])

    expect(planRepresentativeMirror(await contactsWithRepresentative(org._id)).ops).toEqual([])
    // and the other organization is not this one's to touch
    expect((await contactsWithRepresentative(other._id)).every(c => c.representativeLower === 'лице търсено')).toBe(true)
  })

  it('a contact saved between the plan and the run keeps what the plugin wrote', async () => {
    const id = await rawContact(org._id, { companyName: 'ПРОМЕНЕН ООД', representative: 'Лице Едно' })
    const plan = planRepresentativeMirror(await contactsWithRepresentative(org._id))
    // as the routes write (`updateInOrg`): a `$set`, which the plugin mirrors
    await Contact.findOneAndUpdate({ _id: id, orgId: org._id }, { $set: { representative: 'Лице Две' } })
    await applyMirrorWrites(plan.ops)
    expect(await stored(id)).toMatchObject({ representative: 'Лице Две', representativeLower: 'лице две' })
  })
})

describe('the МОЛ moved out of the notes is found too', () => {
  it('the notes backfill writes the mirror with the МОЛ', async () => {
    const id = await rawContact(org._id, { companyName: 'С БЕЛЕЖКА ООД', notes: 'МОЛ: Лице Бележково' })
    const { moves } = planRepresentativeMoves((await contactsWithNotes(String(org._id))).filter(c => String(c._id) === String(id)))
    expect(await applyWrites(representativeWrites(String(org._id), moves))).toBe(1)
    expect(await stored(id)).toMatchObject({ representative: 'Лице Бележково', representativeLower: 'лице бележково' })
    expect(await names('бележково')).toEqual(['С БЕЛЕЖКА ООД'])
  })
})
