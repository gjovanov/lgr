import { describe, it, expect } from 'bun:test'
import {
  BUILT_IN_KEYS,
  acceptedKeys,
  allowInDevelopment,
  ephemeralSigningKey,
  signLicence,
  verifyLicence,
} from 'services/biz/licence/licence-token'
import { licenceStatus, nextLocalDate } from 'services/biz/licence/licence-state'
import { LICENSED_ACTIONS, licensedAction } from 'services/biz/licence/licence-gate'

/**
 * FR-20.55 (plan step P2-3b) — a licence's token, its dates on the org's calendar, and what an
 * expired one stops. Import-pure.
 */

const ORG = '0123456789abcdef01234567'
const NODE = 'master-abcdefghijklmnop'
const base = { sub: ORG, org: 'acme-corp', orgName: 'Acme', node: NODE, plan: 'pilot' as const, paidThrough: '2026-11-30T23:59:59.999Z', graceDays: 30 }

describe('the token', () => {
  it('has the built-in key the supervisor knows, under the same id', () => {
    // The same derivation as packages/server/src/licence.rs#kid_of, which asserts this id too.
    expect([...BUILT_IN_KEYS.keys()]).toEqual(['XJ8Nns0gqH9HSjOZ'])
  })

  it('verifies only with the key that signed it, and refuses any change', () => {
    const key = ephemeralSigningKey()
    const keys = new Map([[key.kid, key.publicKey]])
    const jws = signLicence(base, key)
    const v = verifyLicence(jws, keys)
    expect(v.ok && v.claims.sub).toBe(ORG)
    expect(v.ok && v.claims.node).toBe(NODE)
    // Another key, a production master (built-in keys only), a payload changed after signing.
    expect(verifyLicence(jws, new Map([[key.kid, ephemeralSigningKey().publicKey]]))).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyLicence(jws, BUILT_IN_KEYS)).toEqual({ ok: false, reason: 'unknown_key' })
    const [h, , s] = jws.split('.')
    const longer = Buffer.from(JSON.stringify({ ...base, v: 1, paidThrough: '2099-01-01T00:00:00.000Z', iat: 1, jti: 'x' })).toString('base64url')
    expect(verifyLicence(`${h}.${longer}.${s}`, keys)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyLicence('a.b', keys)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyLicence(42, keys)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyLicence(signLicence({ ...base, sub: '../../etc/passwd' }, key), keys)).toEqual({ ok: false, reason: 'bad_claims' })
  })

  it('a key this process signs with is accepted here outside production only', () => {
    const key = ephemeralSigningKey()
    allowInDevelopment(key)
    expect(acceptedKeys(false).has(key.kid)).toBe(true)
    expect(acceptedKeys(true).has(key.kid)).toBe(false)
    expect([...acceptedKeys(true).keys()]).toEqual([...BUILT_IN_KEYS.keys()])
  })
})

describe('the dates, on the org calendar', () => {
  const key = ephemeralSigningKey()
  const claims = (over: Partial<typeof base> = {}) => {
    const v = verifyLicence(signLicence({ ...base, ...over }, key), new Map([[key.kid, key.publicKey]]))
    if (!v.ok) throw new Error(v.reason)
    return v.claims
  }
  const at = (iso: string, c = claims(), timezone = 'Europe/Sofia') =>
    licenceStatus({ claims: c, now: new Date(iso), timezone, evaluationStart: new Date('2026-01-01T00:00:00Z') })

  it('licensed, then 30 days of grace, then restricted from the next local midnight', () => {
    expect(at('2026-11-15T12:00:00Z').state).toBe('licensed')
    expect(at('2026-12-01T09:00:00Z').state).toBe('grace')
    // Paid through 30 Nov 23:59:59.999 UTC = 31 Dec 01:59 in Sofia once the grace is added: the
    // restriction starts at Sofia's next midnight, 1 January.
    const lastDay = at('2026-12-31T21:30:00Z') // 23:30 on 31 December in Sofia
    expect(lastDay.state).toBe('grace')
    expect(lastDay.restrictedFrom).toBe('2027-01-01')
    expect(lastDay.daysLeft).toBe(1)
    const next = at('2026-12-31T22:00:00Z') // 00:00 on 1 January in Sofia
    expect(next.state).toBe('restricted')
    expect(next.daysLeft).toBe(0)
  })

  it('the day boundary is the org zone, not the server one', () => {
    // The grace ends at 23:59:59 UTC on 30 December: on 31 December in Sofia, still on the 30th in
    // New York. So New York's restriction starts at its midnight of the 31st, Sofia's on 1 January.
    expect(at('2026-12-31T12:00:00Z', claims(), 'Europe/Sofia').state).toBe('grace')
    expect(at('2026-12-31T12:00:00Z', claims(), 'America/New_York').state).toBe('restricted')
  })

  it('with no licence, 30 days of evaluation from the master first start', () => {
    const s = (iso: string) => licenceStatus({ claims: null, now: new Date(iso), timezone: 'UTC', evaluationStart: new Date('2026-10-01T10:00:00Z') })
    expect(s('2026-10-20T00:00:00Z')).toMatchObject({ state: 'evaluation', basis: 'evaluation', restrictedFrom: '2026-11-01' })
    expect(s('2026-10-31T23:59:00Z').state).toBe('evaluation')
    expect(s('2026-11-01T00:00:00Z').state).toBe('restricted')
  })

  it('a problem is carried, and a licence that is there but unusable counts as none', () => {
    const s = licenceStatus({ claims: null, problem: 'other_node', now: new Date('2026-10-02T00:00:00Z'), timezone: 'UTC', evaluationStart: new Date('2026-10-01T00:00:00Z') })
    expect(s).toMatchObject({ state: 'evaluation', problem: 'other_node' })
  })

  it('a calendar day after', () => {
    expect(nextLocalDate('2026-12-31')).toBe('2027-01-01')
    expect(nextLocalDate('2028-02-28')).toBe('2028-02-29')
  })
})

describe('what an expired licence stops', () => {
  it('opening a session and starting a sales document; nothing that corrects or closes', () => {
    expect(licensedAction('POST', '/api/org/:orgId/trade/pos/session')?.what).toBe('opening a till session')
    // The route a cashier sells through in an open session, the close and the storno go through.
    expect(licensedAction('POST', '/api/org/:orgId/trade/pos/session/:id/transaction')).toBeNull()
    expect(licensedAction('POST', '/api/org/:orgId/trade/pos/session/:id/close')).toBeNull()
    expect(licensedAction('POST', '/api/org/:orgId/trade/pos/session/:id/storno')).toBeNull()
    // A declared `/` keeps its slash in the route table.
    expect(licensedAction('POST', '/api/org/:orgId/invoicing/internal-orders/')?.what).toBe('a new client order')
    // Issuing an existing draft, a payment, a bill import: through.
    expect(licensedAction('POST', '/api/org/:orgId/invoices/:id/send')).toBeNull()
    expect(licensedAction('GET', '/api/org/:orgId/invoices')).toBeNull()
  })

  it('a new invoice is decided on its body, and only by its handler', () => {
    const route = '/api/org/:orgId/invoices/'
    // The auth plugins pass no body: the route is left to its handler.
    expect(licensedAction('POST', route)).toBeNull()
    expect(licensedAction('POST', route, { type: 'invoice', direction: 'outgoing' })).not.toBeNull()
    expect(licensedAction('POST', route, { type: 'cash_sale', direction: 'outgoing' })).not.toBeNull()
    expect(licensedAction('POST', route, { type: 'proforma', direction: 'outgoing' })).not.toBeNull()
    expect(licensedAction('POST', route, { type: 'credit_note', direction: 'outgoing' })).toBeNull()
    expect(licensedAction('POST', route, { type: 'debit_note', direction: 'outgoing' })).toBeNull()
    expect(licensedAction('POST', route, { type: 'invoice', direction: 'incoming' })).toBeNull()
  })

  it('every entry is a POST under an org', () => {
    for (const key of LICENSED_ACTIONS.keys()) expect(key).toMatch(/^POST \/api\/org\/:orgId\//)
  })
})
