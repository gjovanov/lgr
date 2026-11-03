import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { TaxReturn } from 'db/models'

/**
 * The tax-return routes validate what they are sent against the model (FR-25 R0 #8). With no schema
 * a create that the model refused answered 500, and a body could carry any field the model has,
 * `createdAt` and the timestamps included.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia
let orgId: string
let otherOrgId: string
let accountId: string
let token: string

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/accounting/tax-return${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const valid = () => ({ type: 'vat', period: { from: '2026-01-01', to: '2026-01-31' } })

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg()
  orgId = String(org._id)
  otherOrgId = String((await createTestOrg())._id)
  accountId = String((await createTestAccount(org._id, { code: '4532', name: 'Output VAT', type: 'liability', subType: 'current_liability' } as any))._id)
  const user = await createTestUser(org._id, { role: 'accountant' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'accountant', email: 'tax@schema.test', username: 'tax',
    firstName: 'T', lastName: 'X', permissions: DEFAULT_ROLE_PERMISSIONS.accountant, ownRecordsModules: [],
  })
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('creating a tax return', () => {
  it('needs what the model needs, and fills in the rest', async () => {
    const { status, json } = await call('POST', '', valid())

    expect(status).toBe(200)
    expect(json.taxReturn.type).toBe('vat')
    expect(json.taxReturn.status).toBe('draft')
    expect(json.taxReturn.orgId).toBe(orgId)
    expect(new Date(json.taxReturn.period.from).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('takes every field of the model', async () => {
    const { status, json } = await call('POST', '', {
      type: 'income_tax',
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' },
      status: 'filed',
      totalTax: 200,
      totalInput: 50,
      totalOutput: 250,
      netPayable: 200,
      lines: [{ description: 'Standard rate', taxableAmount: 1000, taxRate: 20, taxAmount: 200, accountId }],
      filedAt: '2026-04-10',
      filedBy: accountId,
      attachments: [accountId],
    })

    expect(status).toBe(200)
    expect(json.taxReturn.status).toBe('filed')
    expect(json.taxReturn.netPayable).toBe(200)
    expect(json.taxReturn.lines[0].accountId).toBe(accountId)
  })

  const refused: [string, Record<string, unknown>][] = [
    ['no type', { period: valid().period }],
    ['a type the model has no such value for', { ...valid(), type: 'VAT' }],
    ['no period', { type: 'vat' }],
    ['half a period', { type: 'vat', period: { from: '2026-01-01' } }],
    ['a period that is no date', { type: 'vat', period: { from: 'soon', to: '2026-01-31' } }],
    ['a status the model has no such value for', { ...valid(), status: 'submitted' }],
    ['a total that is no number', { ...valid(), totalTax: 'a lot' }],
    ['a line with no account', { ...valid(), lines: [{ description: 'x', taxableAmount: 1, taxRate: 1, taxAmount: 1 }] }],
    ['a line whose account is no id', { ...valid(), lines: [{ description: 'x', taxableAmount: 1, taxRate: 1, taxAmount: 1, accountId: 'cash' }] }],
    ['a line with no amounts', { ...valid(), lines: [{ description: 'x', accountId: '0123456789abcdef01234567' }] }],
    ['an org of its own', { ...valid(), orgId: '0123456789abcdef01234567' }],
  ]
  for (const [what, body] of refused) {
    it(`refuses ${what} with 422, and writes nothing`, async () => {
      const before = await TaxReturn.countDocuments()
      const { status, json } = await call('POST', '', body)

      expect(status).toBe(422)
      expect(typeof json.message).toBe('string')
      expect(await TaxReturn.countDocuments()).toBe(before)
    })
  }

  it('does not store a field the model has no use for, or a timestamp it did not choose', async () => {
    const { status, json } = await call('POST', '', { ...valid(), createdAt: '2001-01-01', injected: 'x' })

    expect(status).toBe(200)
    const raw = await TaxReturn.findById(json.taxReturn.id).lean() as any
    expect(raw.injected).toBeUndefined()
    expect(new Date(raw.createdAt).getFullYear()).not.toBe(2001)
  })
})

describe('updating a tax return', () => {
  it('takes part of the model, and leaves the rest', async () => {
    const created = (await call('POST', '', valid())).json.taxReturn

    const { status, json } = await call('PUT', `/${created.id}`, { status: 'filed', netPayable: 12.5 })

    expect(status).toBe(200)
    expect(json.taxReturn.status).toBe('filed')
    expect(json.taxReturn.netPayable).toBe(12.5)
    expect(json.taxReturn.type).toBe('vat')
  })

  it('refuses what the model refuses, and leaves the return as it was', async () => {
    const created = (await call('POST', '', valid())).json.taxReturn

    for (const body of [{ type: 'VAT' }, { status: 'submitted' }, { period: { from: 'soon', to: 'later' } }, { totalTax: 'a lot' }]) {
      expect((await call('PUT', `/${created.id}`, body)).status).toBe(422)
    }

    const raw = await TaxReturn.findById(created.id).lean() as any
    expect(raw.type).toBe('vat')
    expect(raw.status).toBe('draft')
  })

  it('a PUT carrying orgId is refused, and the return stays in its org', async () => {
    const created = (await call('POST', '', valid())).json.taxReturn

    const moved = await call('PUT', `/${created.id}`, { status: 'filed', orgId: otherOrgId })

    expect(moved.status).toBe(422)
    const raw = await TaxReturn.findById(created.id).lean() as any
    expect(String(raw.orgId)).toBe(orgId)
    expect(raw.status).toBe('draft')
  })

  it('an update operator in the body moves nothing', async () => {
    const created = (await call('POST', '', valid())).json.taxReturn

    await call('PUT', `/${created.id}`, { $set: { orgId: otherOrgId, status: 'paid' } })

    const raw = await TaxReturn.findById(created.id).lean() as any
    expect(String(raw.orgId)).toBe(orgId)
    expect(raw.status).toBe('draft')
  })
})
