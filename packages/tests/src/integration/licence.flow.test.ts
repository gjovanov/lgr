import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestFiscalDevice, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Invoice, OrgLicence, POSSession } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { entitlementsOf, issueLicences, issuerKey } from 'services/biz/licence/licence-issue.service'
import { forgetLicences, licenceOf } from 'services/biz/licence/master-licence.service'
import { acceptedKeys, signLicence, verifyLicence } from 'services/biz/licence/licence-token'
import { LICENSED_ACTIONS } from 'services/biz/licence/licence-gate'
import { handleUplinkClose, handleUplinkMessage, handleUplinkOpen } from '../../../portal-api/src/websocket/uplink'

/**
 * FR-20.55 (plan step P2-3b) — an org's licence to run on a master.
 *
 * Global signs one per entitled org (an Enterprise subscription that is paid, or a sys-admin's
 * pilot) and sends it in the uplink's `welcome`, and again when it changes. The master verifies it
 * against keys built into the package and, once it has run out past its grace, stops opening till
 * sessions and starting sales documents, and nothing else.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const DAY = 86_400_000
const saved = { role: config.node.role, id: config.node.id, dir: config.licence.dir, created: config.licence.nodeCreatedAt, sysAdmins: config.backup.sysAdmins }
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.licence as any).dir = saved.dir
  ;(config.licence as any).nodeCreatedAt = saved.created
  ;(config.backup as any).sysAdmins = saved.sysAdmins
  forgetAllHomes()
  forgetLicences()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
async function bearer(user: any, orgId: string) {
  return (await jwt()).sign({ id: String(user._id), email: user.email, username: user.username, role: user.role, orgId, permissions: [], operatorCode: user.operatorCode })
}

function call(app: any, method: string, path: string, token?: string, body?: unknown, key?: string) {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }))
}

function fakeWs() {
  const sent: any[] = []
  return { raw: { id: Math.random() }, send: (s: string) => { sent.push(JSON.parse(s)) }, close: () => {}, sent }
}

describe('global: who is entitled, and the licence it signs', () => {
  it('a paid Enterprise subscription or a pilot, the later date winning; never a past-due one', async () => {
    const end = new Date(Date.now() + 20 * DAY)
    const paid = await createTestOrg({ subscription: { plan: 'enterprise', status: 'active', currentPeriodEnd: end, maxUsers: -1, cancelAtPeriodEnd: false } } as any)
    const late = await createTestOrg({ subscription: { plan: 'enterprise', status: 'past_due', currentPeriodEnd: end, maxUsers: -1, cancelAtPeriodEnd: false } } as any)
    const free = await createTestOrg()
    await OrgLicence.create({ orgId: free._id, until: new Date(Date.now() + 5 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    // A pilot longer than the subscription wins; a revoked one counts for nothing.
    await OrgLicence.create({ orgId: paid._id, until: new Date(Date.now() + 40 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    await OrgLicence.create({ orgId: late._id, until: new Date(Date.now() + 40 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date(), revokedAt: new Date() })

    const e = await entitlementsOf([paid._id, late._id, free._id])
    expect(e.get(String(paid._id))?.plan).toBe('pilot')
    expect(e.has(String(late._id))).toBe(false)
    expect(e.get(String(free._id))?.plan).toBe('pilot')

    await OrgLicence.deleteOne({ orgId: paid._id })
    expect((await entitlementsOf([paid._id])).get(String(paid._id))).toEqual({ plan: 'enterprise', paidThrough: end })
  })

  it('signs a licence that names the org and the master, and verifies with the keys a master accepts', async () => {
    const org = await createTestOrg()
    await OrgLicence.create({ orgId: org._id, until: new Date(Date.now() + 10 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })
    const nodeId = 'master-aaaaaaaaaaaaaaaa'
    const issued = (await issueLicences(nodeId, [org._id])).get(String(org._id))!
    const v = verifyLicence(issued.jws, acceptedKeys())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.claims).toMatchObject({ sub: String(org._id), node: nodeId, plan: 'pilot', graceDays: 30, org: org.slug })
      expect(v.kid).toBe((issuerKey() as any).key.kid)
    }
    expect((await issueLicences(nodeId, [(await createTestOrg())._id])).size).toBe(0)
  })
})

describe('the uplink delivers it', () => {
  it('in welcome on the interactive socket, and again when a sys-admin moves the pilot', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin', email: 'ops@lgr.test' } as any)
    const stub = makeNodeStub()
    const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
    await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
    const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
    await OrgLicence.create({ orgId: org._id, until: new Date(Date.now() + 10 * DAY), issuedBy: 'ops@lgr.test', issuedAt: new Date() })

    const hello = (ch: string) => JSON.stringify({ t: 'hello', v: 1, ch, token: nodeToken, bootNonce: 'boot-licence1', versions: { app: '0.1.0', protocol: 1 } })
    const interactive = fakeWs()
    handleUplinkOpen(interactive, 'interactive')
    await handleUplinkMessage(interactive, hello('interactive'))
    const bulk = fakeWs()
    handleUplinkOpen(bulk, 'bulk')
    await handleUplinkMessage(bulk, hello('bulk'))
    try {
      const welcome = interactive.sent.find(m => m.t === 'welcome')
      const v = verifyLicence(welcome.orgs[0].entitlements, acceptedKeys())
      expect(v.ok && v.claims.node).toBe(stub.nodeId)
      expect(bulk.sent.find(m => m.t === 'welcome').orgs[0].entitlements).toBeUndefined()

      // A sys-admin moves the pilot: the master hears it at once, with the new date.
      ;(config.backup as any).sysAdmins = ['ops@lgr.test']
      const app = new Elysia().use(createApiApp())
      const until = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10)
      const put = await call(app, 'PUT', `/api/admin/licences/${org._id}`, await bearer(admin, String(org._id)), { until, note: 'the first shop' })
      expect(put.status).toBe(200)
      expect((await put.json()).told).toBe(1)
      const pushed = interactive.sent.filter(m => m.t === 'entitlements')
      expect(pushed).toHaveLength(1)
      const again = verifyLicence(pushed[0].jws, acceptedKeys())
      expect(again.ok && again.claims.paidThrough).toBe(`${until}T23:59:59.999Z`)
      expect(bulk.sent.some(m => m.t === 'entitlements')).toBe(false)
    } finally {
      await handleUplinkClose(interactive)
      await handleUplinkClose(bulk)
    }
  })
})

describe('the sys-admins issue pilots and air-gapped licence files', () => {
  it('only a sys-admin, only on global; the date is checked; a file names its master', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin', email: 'owner@acme.test' } as any)
    const token = await bearer(admin, String(org._id))
    const app = new Elysia().use(createApiApp())
    const soon = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10)

    expect((await call(app, 'GET', '/api/admin/licences')).status).toBe(401)
    ;(config.backup as any).sysAdmins = []
    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: soon })).status).toBe(403)
    ;(config.backup as any).sysAdmins = ['owner@acme.test']

    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: '2020-01-01' })).status).toBe(422)
    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: new Date(Date.now() + 800 * DAY).toISOString() })).status).toBe(422)
    expect((await call(app, 'PUT', '/api/admin/licences/0123456789abcdef01234567', token, { until: soon })).status).toBe(404)
    // With no entitlement there is nothing to put in a file.
    expect((await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'master-aaaaaaaaaaaaaaaa' })).status).toBe(409)

    expect((await call(app, 'PUT', `/api/admin/licences/${org._id}`, token, { until: soon })).status).toBe(200)
    const list = await (await call(app, 'GET', '/api/admin/licences', token)).json()
    expect(list.signing.ok).toBe(true)
    const row = list.orgs.find((o: any) => o.id === String(org._id))
    expect(row.pilot.issuedBy).toBe('owner@acme.test')
    expect(row.entitlement.plan).toBe('pilot')

    expect((await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'not-a-node' })).status).toBe(422)
    const file = await (await call(app, 'POST', `/api/admin/licences/${org._id}/file`, token, { nodeId: 'master-aaaaaaaaaaaaaaaa' })).json()
    expect(file.fileName).toBe(`lgr-licence-${org.slug}-master-aaaaaaaaaaaaaaaa.jws`)
    const v = verifyLicence(file.jws, acceptedKeys())
    expect(v.ok && v.claims.node).toBe('master-aaaaaaaaaaaaaaaa')

    // Revoked: no more renewals. A second revoke finds nothing.
    expect((await call(app, 'DELETE', `/api/admin/licences/${org._id}`, token)).status).toBe(200)
    expect((await entitlementsOf([org._id])).size).toBe(0)
    expect((await call(app, 'DELETE', `/api/admin/licences/${org._id}`, token)).status).toBe(404)

    ;(config.node as any).role = 'master'
    expect((await call(app, 'GET', '/api/admin/licences', token)).status).toBe(404)
  })
})

describe('a master enforces it', () => {
  const NODE = 'master-licencetestaaaaa'

  async function aMaster() {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-licences-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    ;(config.licence as any).dir = tmp
    const org = await createTestOrg({ settings: { timezone: 'Europe/Sofia' } } as any)
    await homeNewOrg(String(org._id))
    const admin = await createTestUser(org._id, { role: 'admin', operatorCode: '0001' } as any)
    const app = new Elysia().use(createApiApp())
    return { orgId: String(org._id), oid: org._id, slug: org.slug, token: await bearer(admin, String(org._id)), app }
  }

  function licence(orgId: string, paidThrough: Date, node = NODE) {
    const key = issuerKey()
    if (!key.ok) throw new Error(key.reason)
    writeFileSync(join(tmp, `${orgId}.jws`), signLicence({ sub: orgId, org: 'x', orgName: 'X', node, plan: 'pilot', paidThrough: paidThrough.toISOString(), graceDays: 30 }, key.key))
    forgetLicences()
  }

  const newDoc = (m: any, type: string) => call(m.app, 'POST', `/api/org/${m.orgId}/invoices`, m.token, { type, direction: 'outgoing', issueDate: '2026-10-25', currency: 'EUR', lines: [], subtotal: 0, total: 0 })

  it('with no licence: a 30-day evaluation, then no new sales documents', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor(Date.now() / 1000)
    const fresh = await (await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).json()
    expect(fresh).toMatchObject({ applies: true, state: 'evaluation', basis: 'evaluation' })
    expect((await newDoc(m, 'invoice')).status).not.toBe(402)

    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 60 * DAY) / 1000)
    expect((await licenceOf(m.orgId) as any).state).toBe('restricted')
    const refused = await newDoc(m, 'invoice')
    expect(refused.status).toBe(402)
    expect((await refused.json())).toMatchObject({ code: 'licence_expired', action: 'a new invoice, proforma or cash sale' })
    expect((await newDoc(m, 'cash_sale')).status).toBe(402)
    // A credit note of an existing sale, reading, the licence itself: never stopped.
    expect((await newDoc(m, 'credit_note')).status).not.toBe(402)
    expect((await call(m.app, 'GET', `/api/org/${m.orgId}/invoices`, m.token)).status).toBe(200)
    expect((await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).status).toBe(200)
  })

  it('a licence for this org and this master lifts it; one for another master does not', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 60 * DAY) / 1000)
    licence(m.orgId, new Date(Date.now() + 10 * DAY))
    expect(await (await call(m.app, 'GET', `/api/org/${m.orgId}/licence`, m.token)).json()).toMatchObject({ state: 'licensed', basis: 'licence', plan: 'pilot' })
    expect((await newDoc(m, 'invoice')).status).not.toBe(402)

    licence(m.orgId, new Date(Date.now() + 10 * DAY), 'master-bbbbbbbbbbbbbbbb')
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'restricted', basis: 'evaluation', problem: 'other_node' })
    expect((await newDoc(m, 'invoice')).status).toBe(402)

    writeFileSync(join(tmp, `${m.orgId}.jws`), 'a.forged.licence')
    forgetLicences()
    expect(await licenceOf(m.orgId)).toMatchObject({ problem: 'malformed' })
  })

  it('grace for 30 days after the paid-through date, then restricted', async () => {
    const m = await aMaster()
    ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 400 * DAY) / 1000)
    licence(m.orgId, new Date(Date.now() - 10 * DAY))
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'grace' })
    expect((await newDoc(m, 'invoice')).status).not.toBe(402)
    licence(m.orgId, new Date(Date.now() - 40 * DAY))
    expect(await licenceOf(m.orgId)).toMatchObject({ state: 'restricted', basis: 'licence' })
    expect((await newDoc(m, 'invoice')).status).toBe(402)
  })

  describe('a till under an expired licence (owner, 2026-11-01)', () => {
    /** Before the restriction began, by far: what was started then is what "existing" means. */
    const longAgo = () => new Date(Date.now() - 45 * DAY)
    const today = () => new Date().toISOString().slice(0, 10)
    const lines = [{ description: 'Услуга', quantity: 2, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 4, lineTotal: 24 }]

    /** A master with a till: its evaluation running, an Eltrade connected, an article in stock, a customer. */
    async function aTill() {
      const m = await aMaster()
      ;(config.licence as any).nodeCreatedAt = Math.floor(Date.now() / 1000)
      const warehouse = await createTestWarehouse(m.oid as any)
      const product = await createTestProduct(m.oid as any, { name: 'Болт', sellingPrice: 10, purchasePrice: 4, taxRate: 20 } as any)
      await createTestStockLevel(m.oid as any, product._id as any, warehouse._id as any, { quantity: 10, availableQuantity: 10 } as any)
      const contact = await createTestContact(m.oid as any, { companyName: 'Клиент ООД', type: 'customer' } as any)
      const device = await createTestFiscalDevice(m.oid as any, warehouse._id as any, {
        deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
      } as any)
      const sim = new EltradeSimulator()
      registerPrinter(String(device._id), new EltradeFiscalPrinter(sim.exchange, String(device._id)))
      tills.push(String(device._id))
      const api = async (method: string, path: string, body?: unknown) => {
        const r = await call(m.app, method, `/api/org/${m.orgId}${path}`, m.token, body)
        return { status: r.status as number, json: await r.json().catch(() => null) as any }
      }
      return { ...m, warehouse, product, contact, sim, api }
    }
    type Till = Awaited<ReturnType<typeof aTill>>

    const tills: string[] = []
    afterEach(() => { for (const id of tills.splice(0)) unregisterPrinter(id) })

    const expire = () => { ;(config.licence as any).nodeCreatedAt = Math.floor((Date.now() - 60 * DAY) / 1000) }
    const openSession = (t: Till) => t.api('POST', '/trade/pos/session', { warehouseId: String(t.warehouse._id), openingBalance: 0, currency: 'EUR' })
    const session = async (t: Till) => {
      const r = await openSession(t)
      expect(r.status).toBe(200)
      return String(r.json.session.id ?? r.json.session._id)
    }
    const sale = (t: Till, sessionId: string, key?: string) => call(t.app, 'POST', `/api/org/${t.orgId}/trade/pos/session/${sessionId}/transaction`, t.token, {
      type: 'sale',
      lines: [{ productId: String(t.product._id), name: 'Болт', quantity: 1, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 10 }],
      subtotal: 10, discountTotal: 0, taxTotal: 2, total: 12, payments: [{ method: 'cash', amount: 12 }], changeDue: 0, nonFiscal: false,
    }, key)
    /** A draft, as though it had been started before the restriction. */
    async function fromBefore(t: Till, paymentMethod: string, type = 'invoice') {
      const r = await t.api('POST', '/invoices', {
        type, direction: 'outgoing', contactId: String(t.contact._id), issueDate: today(), currency: 'EUR', lines, subtotal: 20, taxTotal: 4, total: 24, paymentMethod,
      })
      expect(r.status).toBe(200)
      const id = String(r.json.invoice.id)
      await Invoice.collection.updateOne({ _id: new (Invoice.base as any).Types.ObjectId(id) }, { $set: { createdAt: longAgo() } })
      return id
    }
    const printed = (t: Till) => t.sim.receipts.filter(r => !r.voided)

    it('a session opens, a cash payment on a document from before prints, and the day closes', async () => {
      const t = await aTill()
      const id = await fromBefore(t, 'bank_transfer')
      await session(t)
      expect((await t.api('POST', `/invoices/${id}/send`, {})).status).toBe(200)
      await POSSession.deleteMany({ orgId: t.oid })
      expire()

      const sessionId = await session(t)
      const paid = await t.api('POST', `/invoices/${id}/payments`, { date: today(), amount: 24, method: 'cash' })

      expect(paid.status).toBe(200)
      expect(paid.json.invoice).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect(printed(t)).toHaveLength(1)
      expect((await t.api('POST', `/trade/pos/session/${sessionId}/close`, { counted: { cash: 24 } })).status).toBe(200)
      expect(t.sim.reports).toHaveLength(1)
    })

    it('⚠ a new till sale in that session is refused: nothing written, nothing printed', async () => {
      const t = await aTill()
      expire()
      const sessionId = await session(t)

      const refused = await sale(t, sessionId)

      expect(refused.status).toBe(402)
      expect(await refused.json()).toMatchObject({ code: 'licence_expired', action: 'a new till sale' })
      expect(t.sim.receipts).toHaveLength(0)
      expect(t.sim.executed.some(c => c.cmd === 0x90)).toBe(false)
      expect(await Invoice.countDocuments({ orgId: t.oid })).toBe(0)
    })

    it('⚠ any new document is refused with it, the session open or not', async () => {
      const t = await aTill()
      expire()
      await session(t)

      for (const type of ['invoice', 'proforma', 'cash_sale']) {
        const r = await t.api('POST', '/invoices', {
          type, direction: 'outgoing', contactId: String(t.contact._id), issueDate: today(), currency: 'EUR', lines, subtotal: 20, taxTotal: 4, total: 24, paymentMethod: 'cash',
        })
        expect(r.status).toBe(402)
        expect(r.json.code).toBe('licence_expired')
      }
      expect(printed(t)).toHaveLength(0)
      expect(await Invoice.countDocuments({ orgId: t.oid })).toBe(0)
    })

    it('a draft from before issues in cash, and its receipt prints: it was started before', async () => {
      const t = await aTill()
      const id = await fromBefore(t, 'cash')
      expire()
      await session(t)

      expect((await t.api('POST', `/invoices/${id}/send`, {})).status).toBe(200)

      expect(printed(t)).toHaveLength(1)
      expect((await t.api('GET', `/invoices/${id}`)).json.invoice).toMatchObject({ status: 'paid', amountPaid: 24 })
    })

    it('⚠ a debit note written since prints nothing: its receipt would be a new sale on the device', async () => {
      const t = await aTill()
      const invoice = await fromBefore(t, 'bank_transfer')
      await session(t)
      expect((await t.api('POST', `/invoices/${invoice}/send`, {})).status).toBe(200)
      await POSSession.deleteMany({ orgId: t.oid })
      expire()
      await session(t)

      const note = await t.api('POST', '/invoices', {
        type: 'debit_note', direction: 'outgoing', contactId: String(t.contact._id), relatedInvoiceId: invoice, issueDate: today(), currency: 'EUR',
        lines, subtotal: 20, taxTotal: 4, total: 24, paymentMethod: 'cash',
      })
      expect(note.status).toBe(200)
      const id = String(note.json.invoice.id)

      const refused = await t.api('POST', `/invoices/${id}/send`, {})

      expect(refused.status).toBe(402)
      expect(refused.json).toMatchObject({ code: 'licence_expired', action: 'a fiscal receipt for a new document' })
      expect(printed(t)).toHaveLength(0)
      expect((await t.api('GET', `/invoices/${id}`)).json.invoice.status).toBe('draft')

      // On a bank transfer it goes through as ever: only the receipt stops, and a cash payment on it.
      expect((await t.api('PUT', `/invoices/${id}`, { paymentMethod: 'bank_transfer' })).status).toBe(200)
      expect((await t.api('POST', `/invoices/${id}/send`, {})).status).toBe(200)
      const cash = await t.api('POST', `/invoices/${id}/payments`, { date: today(), amount: 24, method: 'cash' })
      expect(cash.status).toBe(402)
      expect(printed(t)).toHaveLength(0)
    })

    it('a session open when the restriction began keeps selling: it starts at a midnight for that', async () => {
      const t = await aTill()
      const sessionId = await session(t)
      await POSSession.updateOne({ _id: sessionId }, { $set: { openedAt: longAgo() } })
      expire()

      expect((await sale(t, sessionId)).status).toBe(200)
      expect(printed(t)).toHaveLength(1)
    })

    it('a retry of a sale made before is answered, not refused', async () => {
      const t = await aTill()
      const sessionId = await session(t)
      expect((await sale(t, sessionId, 'sale-before-licence-1')).status).toBe(200)
      expire()

      expect((await sale(t, sessionId, 'sale-before-licence-1')).status).toBe(200)
      expect(printed(t)).toHaveLength(1)
    })

    it('a licence lifts it: that same session sells', async () => {
      const t = await aTill()
      expire()
      const sessionId = await session(t)
      expect((await sale(t, sessionId)).status).toBe(402)

      licence(t.orgId, new Date(Date.now() + 10 * DAY))

      expect((await sale(t, sessionId)).status).toBe(200)
    })
  })

  it('on global nothing applies', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    const app = new Elysia().use(createApiApp())
    expect(await (await call(app, 'GET', `/api/org/${org._id}/licence`, await bearer(admin, String(org._id)))).json()).toEqual({ applies: false })
  })
})

describe('the gate names real routes', () => {
  it('every action an expired licence stops is a route the API serves', () => {
    const routes = new Set(((createApiApp() as any).routes as Array<{ method: string; path: string }>).map(r => `${r.method} ${r.path.replace(/\/+$/, '')}`))
    for (const key of LICENSED_ACTIONS.keys()) expect(routes.has(key)).toBe(true)
  })

})
