import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.25: a document's partner picker shows the right side first, by recent use. It opened on
 * the org's newest contacts with suppliers mixed in, so the customer at the counter was typed every
 * time (the P5 walk: the customer was no. 14 of 20, below the menu's fold).
 *
 * `GET /invoicing/contact?prefer=customer|supplier` lists the contacts of that side's latest
 * documents first, then the rest of the side by name, then everyone else. Without `prefer` the list
 * is what it was.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(contactController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  // A few ms apart, so "newest first" has an order to keep.
  const contact = async (companyName: string, type: string) => {
    await Bun.sleep(5)
    return createTestContact(org._id, { companyName, type } as any)
  }
  // Created in this order, so the old newest-first list reads Епсилон, Делта, Гама, Бета, Алфа.
  const alfa = await contact('Алфа ООД', 'customer')
  const beta = await contact('Бета ЕООД', 'customer')
  const gama = await contact('Гама АД', 'customer')
  const delta = await contact('Делта Доставки', 'supplier')
  const epsilon = await contact('Епсилон', 'both')
  // Sold to Гама a month ago and to Бета yesterday; Делта's bill came last week.
  const doc = (c: any, direction: string, issueDate: Date) =>
    createTestInvoice(org._id, c._id, { direction, issueDate, invoiceNumber: `T-${Math.random().toString(36).slice(2, 10)}` } as any)
  await doc(gama, 'outgoing', daysAgo(30))
  await doc(beta, 'outgoing', daysAgo(1))
  await doc(delta, 'incoming', daysAgo(7))

  async function names(query: string): Promise<string[]> {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoicing/contact?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    return ((await res.json()) as any).contacts.map((c: any) => c.companyName)
  }
  return { names, alfa, beta, gama, delta, epsilon }
}

describe('the partner picker shows its side first, by recent use (FR-22.25)', () => {
  it('a sales document: the latest customers, the other customers by name, then the suppliers', async () => {
    const w = await world()
    expect(await w.names('prefer=customer&size=20')).toEqual([
      'Бета ЕООД', // invoiced yesterday
      'Гама АД', // a month ago
      'Алфа ООД', // a customer never invoiced, by name…
      'Епсилон', // …with a contact that is both
      'Делта Доставки', // a supplier, last
    ])
  })

  it('a bill: its suppliers only (the form asks for that side), the latest first', async () => {
    const w = await world()
    expect(await w.names('prefer=supplier&type=supplier&size=20')).toEqual(['Делта Доставки', 'Епсилон'])
  })

  it('a search keeps the order within what it finds', async () => {
    const w = await world()
    // „а" matches all but Епсилон.
    expect(await w.names('prefer=customer&size=20&search=а')).toEqual(['Бета ЕООД', 'Гама АД', 'Алфа ООД', 'Делта Доставки'])
  })

  it('a page of the size asked for, recent first', async () => {
    const w = await world()
    expect(await w.names('prefer=customer&size=2')).toEqual(['Бета ЕООД', 'Гама АД'])
    expect(await w.names('prefer=customer&size=2&page=1')).toEqual(['Алфа ООД', 'Епсилон'])
  })

  it('without `prefer` the list is what it was: the newest contacts first', async () => {
    const w = await world()
    expect(await w.names('size=20')).toEqual(['Епсилон', 'Делта Доставки', 'Гама АД', 'Бета ЕООД', 'Алфа ООД'])
  })
})
