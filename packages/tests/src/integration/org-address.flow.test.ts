import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { Org, OrgAddress, OrgHome, OrgLicence } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import {
  ADDRESS_NOTICE_MS, activeLabelsOf, addressView, decideAddress, labelProblem, listAddresses, ownDnsRecord,
  requestAddress, retireAddress, type DnsLookup,
} from 'services/biz/address/org-address.service'
import { createApiApp } from '../../../portal-api/src/api.js'
import type { Types } from 'mongoose'

/**
 * An org's address on the internet, `<label>.lgrai.app` (FR-20.72, plan step P3-4a): the label rules,
 * the zone's own records, the licence, the sys-admin's approval, and a label issued once.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const saved = { role: config.node.role, admins: [...config.backup.sysAdmins], reserved: process.env.ORG_ADDRESS_RESERVED }
const NOW = new Date('2026-10-27T12:00:00Z')

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'global'
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  config.backup.sysAdmins.splice(0, config.backup.sysAdmins.length, ...saved.admins)
  if (saved.reserved === undefined) delete process.env.ORG_ADDRESS_RESERVED
  else process.env.ORG_ADDRESS_RESERVED = saved.reserved
  forgetAllHomes()
  await clearCollections()
}, 60_000)

/** A zone in which only these names answer, and every other one gets the wildcard's A record. */
function zone(records: Record<string, { A?: string[]; CNAME?: string[]; MX?: unknown[]; TXT?: unknown[] }>, wildcard: string[] = ['94.130.141.98']): DnsLookup {
  const none = () => Promise.reject(Object.assign(new Error('none'), { code: 'ENODATA' }))
  const at = (name: string) => records[name.split('.')[0]]
  return {
    resolve4: async name => at(name)?.A ?? (wildcard.length ? wildcard : none()),
    resolveCname: async name => at(name)?.CNAME ?? none(),
    resolveMx: async name => at(name)?.MX ?? none(),
    resolveTxt: async name => at(name)?.TXT ?? none(),
  }
}

/** An org with a pilot licence through next year, and its admin. */
async function licensed(slug: string, until = new Date('2027-12-31T00:00:00Z')) {
  const org = await createTestOrg({ slug } as any)
  await OrgLicence.create({ orgId: org._id, kind: 'pilot', until, issuedBy: 'ops@lgr.test', issuedAt: NOW })
  return { org, orgId: String(org._id) }
}

describe('the label (FR-20.72)', () => {
  it('a DNS label of at most 63 characters, no punycode, not reserved', () => {
    expect(labelProblem('shop-1')).toBeNull()
    expect(labelProblem('a'.repeat(63))).toBeNull()
    expect(labelProblem('a'.repeat(64))).toBe('too_long')
    for (const bad of ['Shop', 'sh_op', '-shop', 'shop-', 'sh--op', 'sh.op', '']) expect(labelProblem(bad)).toBe('invalid')
    expect(labelProblem('xn--80ak6aa92e')).toBe('punycode')
    for (const r of ['www', 'api', 'admin', 'mail', 'registry', 'qa']) expect(labelProblem(r)).toBe('reserved')
    process.env.ORG_ADDRESS_RESERVED = 'harvex, Other '
    expect(labelProblem('harvex')).toBe('reserved')
    expect(labelProblem('other')).toBe('reserved')
  })

  it('a record of its own in the zone: a CNAME, MX or TXT, or an A record that is not the wildcard\'s', async () => {
    expect(await ownDnsRecord('shop', zone({}))).toBeNull()
    expect(await ownDnsRecord('shop', zone({}, []))).toBeNull()
    expect(await ownDnsRecord('harvex', zone({ harvex: { A: ['10.0.0.9'] } }))).toBe('A')
    expect(await ownDnsRecord('harvex', zone({ harvex: { A: ['10.0.0.9'] } }, []))).toBe('A')
    expect(await ownDnsRecord('shop', zone({ shop: { A: ['94.130.141.98'] } }))).toBeNull()
    expect(await ownDnsRecord('em', zone({ em: { CNAME: ['u123.wl.sendgrid.net'] } }))).toBe('CNAME')
    expect(await ownDnsRecord('m', zone({ m: { MX: [{ exchange: 'mx', priority: 1 }] } }))).toBe('MX')
    expect(await ownDnsRecord('t', zone({ t: { TXT: [['v=spf1 -all']] } }))).toBe('TXT')
    // A resolver that fails otherwise is not "no record": the approval says so rather than issue.
    const broken: DnsLookup = { ...zone({}), resolveCname: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })) }
    let thrown: any = null
    try { await ownDnsRecord('shop', broken) } catch (e) { thrown = e }
    expect(thrown?.code).toBe('ETIMEOUT')
  })
})

describe('requesting, approving and retiring an address (FR-20.72)', () => {
  it('needs a licence that includes on-prem; then it is requested, approved and active', async () => {
    const plain = await createTestOrg({ slug: 'no-licence-shop' } as any)
    expect((await addressView(String(plain._id), NOW)).request).toMatchObject({ ok: false, label: 'no-licence-shop', reason: 'no_licence' })
    let refused: any = null
    try { await requestAddress(String(plain._id), 'u1', NOW) } catch (e) { refused = e }
    expect([refused?.statusCode, refused?.code]).toEqual([409, 'no_licence'])

    const { orgId } = await licensed('corner-shop')
    expect((await addressView(orgId, NOW)).request).toEqual({ ok: true, label: 'corner-shop', url: 'https://corner-shop.lgrai.app' })
    const asked = await requestAddress(orgId, 'u1', NOW)
    expect(asked.address).toMatchObject({ label: 'corner-shop', url: 'https://corner-shop.lgrai.app', state: 'requested' })
    expect(asked.request.reason).toBe('already')
    let again: any = null
    try { await requestAddress(orgId, 'u1', NOW) } catch (e) { again = e }
    expect(again?.code).toBe('already')

    const [row] = await listAddresses()
    expect(row).toMatchObject({ label: 'corner-shop', state: 'requested', org: { slug: 'corner-shop' } })
    const issued = await decideAddress(row.id, 'ops@lgr.test', 'approve', { lookup: zone({}), now: NOW })
    expect(issued).toMatchObject({ state: 'active' })
    expect(await activeLabelsOf([orgId])).toEqual(['corner-shop'])
  })

  it('a label with a record of its own is not issued; a refusal says why and frees the label', async () => {
    const { orgId } = await licensed('harvex')
    await requestAddress(orgId, 'u1', NOW)
    const [row] = await listAddresses()
    let blocked: any = null
    try { await decideAddress(row.id, 'ops@lgr.test', 'approve', { lookup: zone({ harvex: { A: ['10.0.0.9'] } }), now: NOW }) } catch (e) { blocked = e }
    expect([blocked?.code, blocked?.message]).toEqual(['dns_record', expect.stringContaining('A record of its own')])
    let noReason: any = null
    try { await decideAddress(row.id, 'ops@lgr.test', 'refuse', { reason: ' ' }) } catch (e) { noReason = e }
    expect(noReason?.code).toBe('reason_required')
    expect(await decideAddress(row.id, 'ops@lgr.test', 'refuse', { reason: 'the zone serves harvex itself' })).toMatchObject({ state: 'refused', reason: 'the zone serves harvex itself' })
    // Refused: the org may ask again (for the same label, which the zone would refuse again).
    expect((await addressView(orgId, NOW)).request.ok).toBe(true)
  })

  it('a label is issued once: a rename keeps it, a retired one answers a notice for a year and is never issued again', async () => {
    const first = await licensed('market')
    await requestAddress(first.orgId, 'u1', NOW)
    const [row] = await listAddresses()
    await decideAddress(row.id, 'ops@lgr.test', 'approve', { lookup: zone({}), now: NOW })
    // The org is renamed: the address does not move.
    await Org.collection.updateOne({ _id: first.org._id }, { $set: { slug: 'market-renamed' } })
    expect((await addressView(first.orgId, NOW)).address).toMatchObject({ label: 'market', state: 'active' })
    // Another org now has the old slug: the label is taken.
    const second = await licensed('market')
    expect((await addressView(second.orgId, NOW)).request).toMatchObject({ ok: false, reason: 'label_taken' })
    const retired = await retireAddress(row.id, 'ops@lgr.test', NOW)
    expect(retired.state).toBe('retired')
    expect(new Date(retired.noticeUntil).getTime() - NOW.getTime()).toBe(ADDRESS_NOTICE_MS)
    expect(await activeLabelsOf([first.orgId])).toEqual([])
    // Retired is not freed: never issued to anyone again.
    expect((await addressView(second.orgId, NOW)).request).toMatchObject({ ok: false, reason: 'label_taken' })
    let twice: any = null
    try { await retireAddress(row.id, 'ops@lgr.test', NOW) } catch (e) { twice = e }
    expect(twice?.code).toBe('not_active')
  })

  it('a slug that is no DNS label, or a reserved one, cannot ask', async () => {
    const { orgId } = await licensed('admin')
    expect((await addressView(orgId, NOW)).request).toMatchObject({ ok: false, reason: 'reserved' })
    const odd = await licensed('Odd_Shop')
    expect((await addressView(odd.orgId, NOW)).request).toMatchObject({ ok: false, reason: 'invalid', label: 'odd_shop' })
  })
})

describe('the routes (P3-4a)', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const app = new Elysia().use(createApiApp())
  const tokenFor = (u: { id: string; orgId: string; role: string; email: string }) => (signer as any).decorator.jwt.sign({ ...u, username: u.role, permissions: [] })
  async function call(path: string, token: string, method = 'GET', body?: unknown) {
    const res = await app.handle(new Request(`http://localhost/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
    let json: any = null
    try { json = await res.json() } catch { /* empty */ }
    return { status: res.status, json }
  }

  it('the org\'s admin asks, even for an org homed on its server; a member cannot; a sys-admin decides; a master has none', async () => {
    const { org, orgId } = await licensed('route-shop')
    const admin: any = await createTestUser(org._id as Types.ObjectId, { email: 'admin@route-shop.test', role: 'admin' } as any)
    const member: any = await createTestUser(org._id as Types.ObjectId, { email: 'member@route-shop.test', role: 'member' } as any)
    // The org lives on its server: global writes none of its data, but this is global's own record.
    await OrgHome.collection.insertOne({ orgId: org._id, home: 'master-addresstest0000000', epoch: 1, state: 'active', since: new Date() } as any)
    await Org.collection.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } })
    forgetAllHomes()
    const adminToken = await tokenFor({ id: String(admin._id), orgId, role: 'admin', email: 'admin@route-shop.test' })
    const memberToken = await tokenFor({ id: String(member._id), orgId, role: 'member', email: 'member@route-shop.test' })
    config.backup.sysAdmins.splice(0, config.backup.sysAdmins.length, 'ops@lgr.test')
    const opsToken = await tokenFor({ id: '6a0000000000000000000009', orgId, role: 'admin', email: 'ops@lgr.test' })

    expect((await call(`/org/${orgId}/address`, memberToken)).status).toBe(403)
    expect((await call(`/org/${orgId}/address`, memberToken, 'POST')).status).toBe(403)
    expect((await call(`/org/${orgId}/address`, adminToken)).json.request).toMatchObject({ ok: true, label: 'route-shop' })
    const asked = await call(`/org/${orgId}/address`, adminToken, 'POST')
    expect([asked.status, asked.json?.address?.state]).toEqual([200, 'requested'])
    expect((await call(`/org/${orgId}/address`, adminToken, 'POST')).status).toBe(409)

    expect((await call('/admin/addresses', adminToken)).status).toBe(403)
    const list = await call('/admin/addresses', opsToken)
    const id = list.json.addresses[0].id
    expect((await call(`/admin/addresses/${id}/refuse`, opsToken, 'POST', { reason: 'not yet' })).json.address).toMatchObject({ state: 'refused', reason: 'not yet' })
    expect((await call(`/admin/addresses/${id}/approve`, opsToken, 'POST')).status).toBe(409)

    ;(config.node as any).role = 'master'
    expect((await call(`/org/${orgId}/address`, adminToken)).status).toBe(404)
    expect((await call('/admin/addresses', opsToken)).status).toBe(404)
  }, 60_000)
})
