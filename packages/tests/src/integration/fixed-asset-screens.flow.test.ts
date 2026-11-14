import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestFixedAsset, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { AccountingAnalytic, BOOKS_IMPORT, FixedAsset } from 'db/models'
import { mongoose } from 'db/connection'

/**
 * FR-25a §3.4: the fixed-asset screens over the real routes. Made-up assets only.
 *
 * What must hold:
 * - an asset the books import made (`sourceModule: 'plusminus'` + `importKey`) is as booked: an edit and a delete answer
 *   422 `books_as_booked`, and nothing changes;
 * - an asset kept in LGR saves its book and tax sides as the form sends them, by §3.4's rules, and a cleared field is
 *   stored cleared;
 * - the list is light (no properties, no schedule), paged, says which assets are the books', and filters by tax category
 *   and by origin;
 * - the marks of an asset of the books are never a body's to set, and one org never reaches another's assets.
 */

type Id = mongoose.Types.ObjectId

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any

async function tokenFor(orgId: Id, role: keyof typeof DEFAULT_ROLE_PERMISSIONS) {
  const user = await createTestUser(orgId, { role } as any)
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(orgId), role, email: user.email, username: user.username,
    firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
  }) as Promise<string>
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: json, text }
}

const w: Record<string, any> = {}
const url = (orgId: Id = w.org) => `/org/${orgId}/accounting/fixed-asset`
const stored = async (id: unknown) => JSON.stringify(await FixedAsset.findById(id).lean())
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

/** The properties of an imported asset, as the accountant's file lists them: made-up values, in the file's order. */
const PARAMS = [
  { key: 'СМЕТКА', value: '204' }, { key: 'ДАТА', value: '15.03.2024' }, { key: 'СТОЙНОСТ', value: '1200' },
  { key: 'НАЧ.АМ.', value: '200' }, { key: 'КАТ', value: '2' }, { key: 'ДАННОРМА', value: '30' }, { key: 'Б.код', value: '' },
]

/** What the asset form sends to create one (`fixed-asset-form.ts#payloadOf`): the book side, and the tax side. */
function formPayload(extra: Record<string, unknown> = {}) {
  return {
    code: 'FA-NEW-1', name: 'Стругова машина', category: '204', purchaseDate: '2025-03-10', purchasePrice: 1500, salvageValue: 0,
    usefulLifeMonths: 60, depreciationMethod: 'straight_line', status: 'active',
    accountId: String(w.accounts[0]), depreciationAccountId: String(w.accounts[1]), accumulatedDepAccountId: String(w.accounts[2]),
    taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1500, inServiceDate: '2025-04-01',
    currentValue: 1500, currency: 'EUR',
    ...extra,
  }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())

  const org = await createTestOrg({ slug: 'fa-screens' } as any)
  const other = await createTestOrg({ slug: 'fa-screens-other' } as any)
  w.org = org._id
  w.other = other._id
  w.accounts = []
  for (const [code, name] of [['204', 'Машини'], ['603', 'Разходи за амортизация'], ['2414', 'Амортизация на машини']]) {
    w.accounts.push((await createTestAccount(org._id, { code, name } as any))._id)
  }

  // What the books import makes of a `ДА` analytic (FR-25a §4.2), and the analytic it points back at.
  const analytic = await AccountingAnalytic.create({
    orgId: org._id, path: 'ДА:Машина А', root: 'ДА', name: 'Машина А', nameLower: 'машина а', kind: 'fixed_asset', isActive: true, params: PARAMS,
  })
  w.analytic = analytic._id
  w.imported = await createTestFixedAsset(org._id, {
    code: 'ДА:Машина А', name: 'Машина А', category: '204', accountId: w.accounts[0], depreciationAccountId: w.accounts[1],
    accumulatedDepAccountId: w.accounts[2], purchaseDate: day(2024, 3, 15), purchasePrice: 1200, salvageValue: 0, usefulLifeMonths: 80,
    currentValue: 1000, status: 'active', taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1200,
    inServiceDate: day(2024, 4, 1), params: PARAMS, sourceModule: BOOKS_IMPORT, importKey: 'analytic|ДА:Машина А', analyticId: analytic._id,
  } as any)
  await AccountingAnalytic.updateOne({ _id: analytic._id }, { $set: { fixedAssetId: w.imported._id } })
  // Land is not depreciated (`НАЧИСЛ` = `НЕ`), and has no tax category.
  w.land = await createTestFixedAsset(org._id, {
    code: 'ДА:Земя', name: 'Земя', category: '201', accountId: w.accounts[0], depreciationAccountId: w.accounts[1], accumulatedDepAccountId: w.accounts[2],
    purchaseDate: day(2020, 1, 10), purchasePrice: 5000, salvageValue: 0, usefulLifeMonths: 0, currentValue: 5000, status: 'not_depreciated',
    currency: 'BGN', sourceModule: BOOKS_IMPORT, importKey: 'analytic|ДА:Земя',
  } as any)
  // Kept in LGR: one with a tax side, one without.
  w.native = await createTestFixedAsset(org._id, {
    code: 'FA-OWN-1', name: 'Компютър', category: 'IT', accountId: w.accounts[0], depreciationAccountId: w.accounts[1], accumulatedDepAccountId: w.accounts[2],
    purchaseDate: day(2025, 1, 20), purchasePrice: 900, salvageValue: 0, usefulLifeMonths: 24, currentValue: 900,
    taxCategory: '4', taxDepreciationRate: 50, taxUsefulLifeMonths: 24, taxValue: 900, inServiceDate: day(2025, 2, 1),
  } as any)
  w.plain = await createTestFixedAsset(org._id, {
    code: 'FA-OWN-2', name: 'Бюро', category: 'Мебели', accountId: w.accounts[0], depreciationAccountId: w.accounts[1], accumulatedDepAccountId: w.accounts[2],
    purchaseDate: day(2025, 5, 5), purchasePrice: 300, salvageValue: 0, usefulLifeMonths: 60, currentValue: 300,
  } as any)
  w.foreign = await createTestFixedAsset(other._id, { code: 'FA-OTHER', name: 'Чужда машина', taxCategory: '2' } as any)

  w.admin = await tokenFor(org._id, 'admin')
  w.otherAdmin = await tokenFor(other._id, 'admin')
}, 120_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the list (FR-25a §3.4)', () => {
  it('says which assets are the books\', carries the tax columns, and leaves the properties and the schedule out', async () => {
    const res = await call('GET', `${url()}?size=0&sortBy=code&sortOrder=asc`, w.admin)
    expect(res.status).toBe(200)
    const rows = res.body.fixedAssets as any[]
    expect(rows.map(r => r.code)).toEqual(['FA-OWN-1', 'FA-OWN-2', 'ДА:Земя', 'ДА:Машина А'])
    const byCode = new Map(rows.map(r => [r.code, r]))
    expect(byCode.get('ДА:Машина А')).toMatchObject({ imported: true, taxCategory: '2', taxDepreciationRate: 30, analyticId: String(w.analytic) })
    expect(byCode.get('ДА:Машина А').inServiceDate).toStartWith('2024-04-01')
    expect(byCode.get('ДА:Земя')).toMatchObject({ imported: true, status: 'not_depreciated', currency: 'BGN' })
    expect(byCode.get('FA-OWN-1')).toMatchObject({ imported: false, taxCategory: '4', taxDepreciationRate: 50 })
    for (const r of rows) {
      expect(r.params).toBeUndefined()
      expect(r.depreciationSchedule).toBeUndefined()
      expect(r._id).toBe(r.id)
    }
    // The other org's asset is not in this org's list.
    expect(rows.some(r => r.code === 'FA-OTHER')).toBe(false)
  })

  it('is paged', async () => {
    const res = await call('GET', `${url()}?page=1&size=2&sortBy=code&sortOrder=asc`, w.admin)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 4, page: 1, size: 2, totalPages: 2 })
    expect(res.body.fixedAssets.map((r: any) => r.code)).toEqual(['ДА:Земя', 'ДА:Машина А'])
  })

  it('filters by tax category, by none, and by where the asset comes from', async () => {
    const codes = async (query: string) => ((await call('GET', `${url()}?size=0&sortBy=code&sortOrder=asc&${query}`, w.admin)).body.fixedAssets as any[]).map(r => r.code)
    expect(await codes('taxCategory=2')).toEqual(['ДА:Машина А'])
    expect(await codes('taxCategory=4')).toEqual(['FA-OWN-1'])
    expect(await codes('taxCategory=none')).toEqual(['FA-OWN-2', 'ДА:Земя'])
    // A category it does not know matches nothing, rather than everything.
    expect(await codes('taxCategory=IX')).toEqual([])
    expect(await codes('imported=true')).toEqual(['ДА:Земя', 'ДА:Машина А'])
    expect(await codes('imported=false')).toEqual(['FA-OWN-1', 'FA-OWN-2'])
    expect(await codes('imported=false&taxCategory=none')).toEqual(['FA-OWN-2'])
    expect(await codes('search=машина')).toEqual(['ДА:Машина А'])
  })

  it('sorts by a column it knows, and as it always has by anything else', async () => {
    const res = await call('GET', `${url()}?size=0&sortBy=taxDepreciationRate&sortOrder=desc`, w.admin)
    expect((res.body.fixedAssets as any[]).slice(0, 2).map(r => r.code)).toEqual(['FA-OWN-1', 'ДА:Машина А'])
    const fallback = await call('GET', `${url()}?size=0&sortBy=params.value`, w.admin)
    expect(fallback.status).toBe(200)
    expect(fallback.body.total).toBe(4)
  })
})

describe('an asset of the books is as booked', () => {
  it('opens with its properties in the file\'s order, and says it is the books\'', async () => {
    const res = await call('GET', `${url()}/${w.imported._id}`, w.admin)
    expect(res.status).toBe(200)
    expect(res.body.fixedAsset).toMatchObject({ imported: true, analyticId: String(w.analytic), currentValue: 1000 })
    expect(res.body.fixedAsset.params).toEqual(PARAMS)
  })

  it('refuses an edit, whatever it changes, and changes nothing', async () => {
    const before = await stored(w.imported._id)
    for (const body of [{ name: 'Друго име' }, { taxDepreciationRate: 10 }, { taxCategory: null }, {}]) {
      const res = await call('PUT', `${url()}/${w.imported._id}`, w.admin, body)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('books_as_booked')
    }
    // The document sent back as it was loaded is refused too.
    const loaded = (await call('GET', `${url()}/${w.imported._id}`, w.admin)).body.fixedAsset
    const { orgId: _o, ...whole } = loaded
    expect((await call('PUT', `${url()}/${w.imported._id}`, w.admin, whole)).body.code).toBe('books_as_booked')
    expect(await stored(w.imported._id)).toBe(before)
  })

  it('refuses a delete, and stays', async () => {
    for (const asset of [w.imported, w.land]) {
      const res = await call('DELETE', `${url()}/${asset._id}`, w.admin)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('books_as_booked')
      expect(await FixedAsset.exists({ _id: asset._id })).toBeTruthy()
    }
  })
})

describe('an asset kept in LGR saves its tax side (§3.4)', () => {
  it('creates one as the form sends it, through the real route', async () => {
    const res = await call('POST', url(), w.admin, formPayload())
    expect(res.status).toBe(200)
    expect(res.body.fixedAsset.imported).toBe(false)
    const doc: any = await FixedAsset.findById(res.body.fixedAsset._id).lean()
    expect(doc).toMatchObject({
      code: 'FA-NEW-1', usefulLifeMonths: 60, depreciationMethod: 'straight_line', currentValue: 1500, currency: 'EUR',
      taxCategory: '2', taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1500,
    })
    expect(doc.inServiceDate.toISOString()).toBe('2025-04-01T00:00:00.000Z')
    expect(doc.sourceModule).toBeUndefined()
    expect(doc.importKey).toBeUndefined()
  })

  it('creates one with no tax side, storing none of its fields', async () => {
    const res = await call('POST', url(), w.admin, formPayload({
      code: 'FA-NEW-2', taxCategory: null, taxDepreciationRate: null, taxUsefulLifeMonths: null, taxValue: null, inServiceDate: null,
    }))
    expect(res.status).toBe(200)
    const doc: any = await FixedAsset.findById(res.body.fixedAsset._id).lean()
    for (const field of ['taxCategory', 'taxDepreciationRate', 'taxUsefulLifeMonths', 'taxValue', 'inServiceDate']) expect(field in doc).toBe(false)
  })

  it('edits it, a category given as a number stored as its digit', async () => {
    const res = await call('PUT', `${url()}/${w.native._id}`, w.admin, { taxCategory: 7, taxDepreciationRate: 15, taxUsefulLifeMonths: 80, taxValue: 850.5, inServiceDate: '2025-03-01' })
    expect(res.status).toBe(200)
    const doc: any = await FixedAsset.findById(w.native._id).lean()
    expect(doc).toMatchObject({ taxCategory: '7', taxDepreciationRate: 15, taxUsefulLifeMonths: 80, taxValue: 850.5 })
    expect(doc.inServiceDate.toISOString()).toBe('2025-03-01T00:00:00.000Z')
  })

  it('stores a cleared field as cleared, and leaves a field the body does not name', async () => {
    const res = await call('PUT', `${url()}/${w.native._id}`, w.admin, { taxCategory: null, inServiceDate: '', taxValue: null, name: 'Компютър 2' })
    expect(res.status).toBe(200)
    const doc: any = await FixedAsset.findById(w.native._id).lean()
    expect('taxCategory' in doc).toBe(false)
    expect('inServiceDate' in doc).toBe(false)
    expect('taxValue' in doc).toBe(false)
    expect(doc).toMatchObject({ name: 'Компютър 2', taxDepreciationRate: 15, taxUsefulLifeMonths: 80 })
  })

  it('refuses what §3.4 does not allow, and changes nothing', async () => {
    const before = await stored(w.plain._id)
    const refused: [Record<string, unknown>, string | null][] = [
      [{ taxDepreciationRate: 100.5 }, null],
      [{ taxDepreciationRate: -1 }, null],
      [{ taxCategory: '8' }, null],
      [{ taxCategory: 'II' }, null],
      [{ taxCategory: 0 }, null],
      [{ taxUsefulLifeMonths: 40.5 }, null],
      [{ taxUsefulLifeMonths: -12 }, null],
      [{ taxValue: -0.01 }, null],
      [{ inServiceDate: '2025-02-30' }, 'in_service_date_invalid'],
      // Bought on 5 May 2025: put into service a day before is refused.
      [{ inServiceDate: '2025-05-04' }, 'in_service_before_purchase'],
      [{ inServiceDate: '2025-06-01', purchaseDate: '2025-06-02' }, 'in_service_before_purchase'],
    ]
    for (const [body, code] of refused) {
      const res = await call('PUT', `${url()}/${w.plain._id}`, w.admin, body)
      expect(`${JSON.stringify(body)} ${res.status}`).toBe(`${JSON.stringify(body)} 422`)
      if (code) {
        expect(res.body.code).toBe('fixed_asset_tax_invalid')
        expect(res.body.problems).toEqual([{ field: 'inServiceDate', code }])
      }
    }
    expect(await stored(w.plain._id)).toBe(before)
    // The day it was bought is fine, and so is a new purchase date before a stored in-service date.
    expect((await call('PUT', `${url()}/${w.plain._id}`, w.admin, { inServiceDate: '2025-05-05' })).status).toBe(200)
    expect((await call('PUT', `${url()}/${w.plain._id}`, w.admin, { purchaseDate: '2025-05-01' })).status).toBe(200)
    // …but not one after it.
    const late = await call('PUT', `${url()}/${w.plain._id}`, w.admin, { purchaseDate: '2025-05-06' })
    expect(late.status).toBe(422)
    expect(late.body.problems).toEqual([{ field: 'inServiceDate', code: 'in_service_before_purchase' }])
  })

  it('refuses a new one put into service before it was bought, and makes none', async () => {
    const res = await call('POST', url(), w.admin, formPayload({ code: 'FA-NEW-3', inServiceDate: '2025-03-09' }))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('fixed_asset_tax_invalid')
    expect(await FixedAsset.exists({ orgId: w.org, code: 'FA-NEW-3' })).toBeNull()
  })

  it('saves the document sent back as it was loaded, its origin flag and all', async () => {
    const loaded = (await call('GET', `${url()}/${w.native._id}`, w.admin)).body.fixedAsset
    expect(loaded.imported).toBe(false)
    const { orgId: _o, ...whole } = loaded
    const res = await call('PUT', `${url()}/${w.native._id}`, w.admin, { ...whole, name: 'Компютър 3' })
    expect(res.status).toBe(200)
    const doc: any = await FixedAsset.findById(w.native._id).lean()
    expect(doc.name).toBe('Компютър 3')
    expect('imported' in doc).toBe(false)
  })

  it('deletes one', async () => {
    const made = await call('POST', url(), w.admin, formPayload({ code: 'FA-NEW-4' }))
    const res = await call('DELETE', `${url()}/${made.body.fixedAsset._id}`, w.admin)
    expect(res.status).toBe(200)
    expect(await FixedAsset.exists({ _id: made.body.fixedAsset._id })).toBeNull()
  })
})

describe('what marks an asset of the books is the server\'s', () => {
  it('is never a body\'s to set, on a new asset or an edit', async () => {
    const before = await stored(w.plain._id)
    for (const mark of [{ sourceModule: BOOKS_IMPORT }, { importKey: 'analytic|ДА:Нещо' }, { analyticId: String(w.analytic) }]) {
      const edit = await call('PUT', `${url()}/${w.plain._id}`, w.admin, mark)
      expect(edit.status).toBe(422)
      expect(edit.body.code).toBe('server_owned_field')
      const made = await call('POST', url(), w.admin, formPayload({ code: `FA-MARK-${Object.keys(mark)[0]}`, ...mark }))
      expect(made.status).toBe(422)
      expect(made.body.code).toBe('server_owned_field')
    }
    expect(await stored(w.plain._id)).toBe(before)
    expect(await FixedAsset.countDocuments({ orgId: w.org, code: /^FA-MARK-/ })).toBe(0)
  })
})

describe('one org never reaches another\'s assets', () => {
  it('refuses another org\'s token on this org\'s routes', async () => {
    for (const [method, path] of [['GET', url()], ['GET', `${url()}/${w.native._id}`], ['PUT', `${url()}/${w.native._id}`], ['DELETE', `${url()}/${w.native._id}`]] as const) {
      const res = await call(method, path, w.otherAdmin, method === 'PUT' ? { name: 'x' } : undefined)
      expect(`${method} ${res.status}`).toBe(`${method} 403`)
    }
  })

  it('finds no asset of another org through its own routes', async () => {
    const before = await stored(w.foreign._id)
    expect((await call('GET', `${url()}/${w.foreign._id}`, w.admin)).status).toBe(404)
    expect((await call('PUT', `${url()}/${w.foreign._id}`, w.admin, { name: 'x' })).status).toBe(404)
    expect((await call('DELETE', `${url()}/${w.foreign._id}`, w.admin)).status).toBe(404)
    expect(await stored(w.foreign._id)).toBe(before)
  })
})
