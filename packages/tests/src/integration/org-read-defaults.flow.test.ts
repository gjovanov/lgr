import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { Org, User } from 'db/models'
import { register, tokenize } from 'services/biz/auth.service'
import { orgDao } from 'services/dao/org.dao'
import { orgDefaults } from 'services/biz/receipt-bill.service'

/**
 * An org's document holds only the settings somebody saved. A key the schema gained after the org was founded is not
 * in it, and neither is one that a save of Settings → Organization removed before #815. Read through the model, such a
 * key is the model's default; read lean, it is `undefined`.
 *
 * The SPAs read the org from `GET /auth/me` and `GET /org/:orgId`, and the default VAT rate among those settings is
 * the rate a new article gets: the quick-create dialog sends it, and the server falls back to it when none is sent.
 * So an org without the stored key must still answer the model's rate, on every one of those reads.
 *
 * An org made by a test stores every default (`Org.create` writes them). So this file REMOVES the keys from the stored
 * document first: that is the state the model's defaults exist for, and no other suite has it.
 *
 * Made-up values throughout. NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId: string
let token: string

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** The stored document itself: no model default fills in for a key that is not there. */
const stored = async () => (await Org.findById(orgId).lean().exec()) as any

/** The settings the model fills in, as an answer must carry them for an org that stores none of them. */
const MODEL_DEFAULTS = {
  timezone: 'Europe/Berlin',
  taxConfig: { defaultVatRate: 20, taxIdLabel: 'VAT ID' },
  inventory: { defaultCostingMethod: 'wac', allowNegativeStock: false },
  dailyDigest: { enabled: false, hour: 7, sections: { kpis: true, documents: true, backups: false, server: true } },
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'Defaults', orgSlug: 'org-read-defaults', email: 'founder@defaults.test', username: 'founder', password: 'secure-pass-123', firstName: 'Fo', lastName: 'Under' })
  // What the activation link does: a session is a live membership's.
  await User.updateOne({ _id: r.user._id }, { $set: { isActive: true } })
  orgId = String(r.org._id)
  token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(r.user._id).exec())!))

  // The org as an older one is stored: without the keys nobody saved.
  await Org.updateOne({ _id: r.org._id }, {
    $unset: {
      'settings.timezone': '',
      'settings.taxConfig.defaultVatRate': '',
      'settings.taxConfig.taxIdLabel': '',
      'settings.inventory': '',
      'settings.dailyDigest': '',
    },
  }).exec()
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('an org that stores no value for a setting answers the model\'s default', () => {
  it('the stored document has none of them (the test starts from the state it means)', async () => {
    const org = await stored()
    expect(org.settings.timezone).toBeUndefined()
    expect(org.settings.taxConfig.defaultVatRate).toBeUndefined()
    expect(org.settings.taxConfig.taxIdLabel).toBeUndefined()
    expect(org.settings.inventory).toBeUndefined()
    expect(org.settings.dailyDigest).toBeUndefined()
    // What it does store is still there.
    expect(org.settings.taxConfig.vatEnabled).toBe(true)
  })

  it('GET /org/:orgId, which the quick-create dialog and the tax-rate picker read', async () => {
    const res = await call('GET', `/org/${orgId}`)
    expect(res.status).toBe(200)
    expect(res.json.org.settings).toMatchObject(MODEL_DEFAULTS)
  })

  it('GET /auth/me, which every SPA takes its org from', async () => {
    const res = await call('GET', '/auth/me')
    expect(res.status).toBe(200)
    expect(res.json.org.settings).toMatchObject(MODEL_DEFAULTS)
  })

  it('orgDao.findById: a plain object, with the defaults', async () => {
    const org: any = await orgDao.findById(orgId)
    expect(org.settings).toMatchObject(MODEL_DEFAULTS)
    expect(String(org._id)).toBe(orgId)
    // Not a document: nothing to save, and it serialises as it is.
    expect(typeof org.save).toBe('undefined')
    expect(typeof org.toObject).toBe('undefined')
    expect(JSON.parse(JSON.stringify(org)).settings.taxConfig.defaultVatRate).toBe(20)
    expect(await orgDao.findById('000000000000000000000000')).toBeNull()
  })

  it('reading it writes nothing: the document still stores none of them', async () => {
    const org = await stored()
    expect(org.settings.taxConfig.defaultVatRate).toBeUndefined()
    expect(org.settings.inventory).toBeUndefined()
  })
})

describe('the rate of a new article, in an org that stores no default VAT rate', () => {
  it('an article created with no rate takes the model\'s rate, not zero', async () => {
    const res = await call('POST', `/org/${orgId}/warehouse/product/quick`, { name: 'БОЛТ ТЕСТ М8 БЕЗ СТАВКА' })
    expect(res.status).toBe(200)
    expect(res.json.product.taxRate).toBe(20)
  })

  it('a rate the request names is kept, zero included', async () => {
    const zero = await call('POST', `/org/${orgId}/warehouse/product/quick`, { name: 'БОЛТ ТЕСТ М8 НУЛЕВА', taxRate: 0 })
    expect(zero.json.product.taxRate).toBe(0)
    const nine = await call('POST', `/org/${orgId}/warehouse/product/quick`, { name: 'БОЛТ ТЕСТ М8 ДЕВЕТ', taxRate: 9 })
    expect(nine.json.product.taxRate).toBe(9)
  })

  it('a bill made from a receipt reads the same rate for a line whose article is gone', async () => {
    expect(await orgDefaults(orgId)).toEqual({ currency: 'EUR', vat: 20 })
  })

  it('and the rate the org does store wins over the model\'s', async () => {
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.taxConfig.defaultVatRate': 9 } }).exec()
    expect((await call('GET', `/org/${orgId}`)).json.org.settings.taxConfig.defaultVatRate).toBe(9)
    expect((await call('GET', '/auth/me')).json.org.settings.taxConfig.defaultVatRate).toBe(9)
    expect((await orgDefaults(orgId)).vat).toBe(9)
    const res = await call('POST', `/org/${orgId}/warehouse/product/quick`, { name: 'БОЛТ ТЕСТ М8 СТАВКА НА ФИРМАТА' })
    expect(res.json.product.taxRate).toBe(9)
  })
})
