import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { clearCollections, setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { Account, AccountingAnalytic, AuditLog, FixedAsset, Org } from 'db/models'
import { importAnalytics, importChart } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { parseAnalyticsFile, type AnalyticItem } from 'services/biz/accounting-books/plusminus-exports'

/**
 * FR-25a §4.2: the fixed-asset register, made by the books import from the `ДА` analytics it has just stored. Made-up
 * data only, sent the way the importer sends it (the analytics file read by the books' own parser).
 *
 * What must hold: the org that holds the register (a books org of its own, or the home of a split) gets an asset per
 * analytic, linked both ways, and a store of a split none; a rerun is unchanged and its dry run writes nothing; a change in
 * the books updates the asset the import made; an asset kept in LGR is never written; nothing is deleted; and a value
 * the import cannot read is a problem in the answer, never a failed import.
 */

const EIK = '000000000'
const CHART = [
  ['101', 'Основен капитал'], ['201', 'Земи'], ['204', 'Машини'], ['2414', 'Амортизация на машини'], ['304', 'Стоки'], ['401', 'Доставчици'],
  ['603', 'Разходи за амортизация'],
].map(([code, name]) => ({ code, name }))

const MACHINE = 'ДА:Машина А'
const LAND = 'ДА:Земя'
const DAMAGED = 'ДА:Машина Б'
const NO_ACCOUNT = 'ДА:Машина В'

/** One asset's properties, as the accountant's program lists them: made-up values. */
const MACHINE_PARAMS: Record<string, string> = {
  'СМЕТКА': '204', 'ДЕБИТ': '603', 'КРЕДИТ': '2414', 'МЕТОД': 'линеен', 'ДАТА': '15.03.2024', 'СТОЙНОСТ': '1200', 'ОБЩАСТОЙНОСТ': '1500',
  'ПРОЦЕНТ': '15', 'СРОК': '6.6667', 'НАЧ.АМ.': '0', 'КАТ': '4', 'ДАТАЕКСП': '01.04.2024', 'ДАННОРМА': '30', 'ДАНСРОК': '3.3333',
  'ДАНСТОЙН': '1500', 'ОБЩДАНАМ': '450', 'НАЧДАНАМ': '0', 'ПЕРДАНАМ': '2025', 'ОТПДАТА': '', 'ОТПДАП': '', 'НАЧИСЛ': '',
}

const ASSETS: Record<string, Record<string, string>> = {
  [MACHINE]: MACHINE_PARAMS,
  [LAND]: { 'СМЕТКА': '201', 'ДЕБИТ': '603', 'КРЕДИТ': '2414', 'МЕТОД': 'линеен', 'ДАТА': '10.01.2020', 'СТОЙНОСТ': '5000', 'ОБЩАСТОЙНОСТ': '5000', 'ПРОЦЕНТ': '0', 'СРОК': '', 'НАЧ.АМ.': '0', 'КАТ': '', 'НАЧИСЛ': 'НЕ' },
  // The in-service date cannot be read: the asset is made from the rest.
  [DAMAGED]: { ...MACHINE_PARAMS, 'ДАТА': '01.02.2026', 'ДАТАЕКСП': '31.02.2026' },
  // Booked on an account the chart does not hold: no asset.
  [NO_ACCOUNT]: { ...MACHINE_PARAMS, 'СМЕТКА': '209' },
}

/** The analytics file as `pull-books` writes it, every root in one, and what the importer sends of it. */
function itemsOf(assets: Record<string, Record<string, string>> = ASSETS): AnalyticItem[] {
  const rows = [
    { ap: 'СТОКИ', params: {}, group: 'true' },
    { ap: 'СТОКИ:БОЛТОВЕ', params: { 'МЯРКА': 'бр' } },
    { ap: 'ДА', params: {}, group: 'true' },
    ...Object.entries(assets).map(([ap, params]) => ({ ap, params })),
  ]
  return parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(rows)))
}

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

let orgId: string
let by: { id: string }

const execute = { eik: EIK, dryRun: false }
const dry = { eik: EIK, dryRun: true }

async function booksOrg(): Promise<string> {
  const org = await createTestOrg({ taxNumber: EIK } as any)
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [] } } })
  return String(org._id)
}

const chartIn = (org = orgId) => importChart(org, { ...execute, accounts: CHART }, by)
const imported = (org: string, items = itemsOf(), body = execute) => importAnalytics(org, { ...body, items }, by)
const assetOf = (path: string, org = orgId) => FixedAsset.findOne({ orgId: org, importKey: `analytic|${path}` }).lean() as Promise<any>
const analyticOf = (path: string, org = orgId) => AccountingAnalytic.findOne({ orgId: org, path }).lean() as Promise<any>
const accountId = async (code: string, org = orgId) => String(((await Account.findOne({ orgId: org, code }).lean()) as any)._id)
/** The whole collection as stored, to prove a run wrote nothing. */
const snapshot = async () => JSON.stringify(await FixedAsset.find({}).sort({ _id: 1 }).lean()) + JSON.stringify(await AccountingAnalytic.find({}).sort({ _id: 1 }).lean())

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
  orgId = await booksOrg()
  by = { id: String((await createTestUser(orgId as any))._id) }
})

describe('the register, from the analytics', () => {
  it('makes an asset of each ДА analytic, by the mapping, linked both ways; one it cannot make is named, and the import goes on', async () => {
    await chartIn()
    const answer = await imported(orgId)
    expect(answer.fixedAssets).toEqual({
      linked: 0, unlinked: 1, created: 3, updated: 0, unchanged: 0,
      problems: [
        { path: DAMAGED, key: 'ДАТАЕКСП', reason: 'unreadable' },
        { path: NO_ACCOUNT, key: 'СМЕТКА', reason: 'unknown_account', code: '209' },
      ],
    })
    // The rest of the analytics are imported as always.
    expect(answer).toMatchObject({ dryRun: false, created: 7 })
    expect((await analyticOf('СТОКИ:БОЛТОВЕ')).unit).toBe('бр')

    const machine = await assetOf(MACHINE)
    const analytic = await analyticOf(MACHINE)
    expect(machine).toMatchObject({
      code: MACHINE, name: 'Машина А', category: '204', depreciationMethod: 'straight_line', purchaseDate: day(2024, 3, 15), purchasePrice: 1500,
      currency: 'BGN', usefulLifeMonths: 80, currentValue: 1500, salvageValue: 0, status: 'active', taxCategory: '4', inServiceDate: day(2024, 4, 1),
      taxDepreciationRate: 30, taxUsefulLifeMonths: 40, taxValue: 1500, sourceModule: 'plusminus', importKey: `analytic|${MACHINE}`,
      depreciationSchedule: [],
    })
    expect(machine.params).toEqual(Object.entries(MACHINE_PARAMS).map(([key, value]) => ({ key, value })))
    expect([String(machine.accountId), String(machine.depreciationAccountId), String(machine.accumulatedDepAccountId)])
      .toEqual([await accountId('204'), await accountId('603'), await accountId('2414')])
    expect(String(machine.analyticId)).toBe(String(analytic._id))
    expect(String(analytic.fixedAssetId)).toBe(String(machine._id))

    expect(await assetOf(LAND)).toMatchObject({ status: 'not_depreciated', usefulLifeMonths: 0, category: '201', purchasePrice: 5000 })
    const damaged = await assetOf(DAMAGED)
    expect(damaged).toMatchObject({ currency: 'EUR', purchaseDate: day(2026, 2, 1) })
    expect(damaged).not.toHaveProperty('inServiceDate')
    // No asset, and the analytic links to none.
    expect(await assetOf(NO_ACCOUNT)).toBeNull()
    expect((await analyticOf(NO_ACCOUNT)).fixedAssetId).toBeUndefined()
    expect(await FixedAsset.countDocuments({ orgId })).toBe(3)

    const audit: any = await AuditLog.findOne({ orgId, entityName: 'fixed assets' }).lean()
    expect(audit?.changes).toMatchObject([{ field: 'created', newValue: 3 }, { field: 'updated', newValue: 0 }])
  })

  it('a rerun is unchanged, and so is its dry run, which writes nothing', async () => {
    await chartIn()
    await imported(orgId)
    const again = await imported(orgId)
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 5 })
    expect(again.fixedAssets).toMatchObject({ linked: 0, unlinked: 1, created: 0, updated: 0, unchanged: 3 })
    const before = await snapshot()
    const proof = await imported(orgId, itemsOf(), dry)
    expect(proof).toMatchObject({ dryRun: true, created: 0, updated: 0, unchanged: 5 })
    expect(proof.fixedAssets).toEqual(again.fixedAssets)
    expect(await snapshot()).toBe(before)
  })

  it('a dry run counts what it would make, and writes nothing', async () => {
    await chartIn()
    const answer = await imported(orgId, itemsOf(), dry)
    expect(answer.fixedAssets).toMatchObject({ linked: 0, unlinked: 1, created: 3, updated: 0, unchanged: 0 })
    expect(await FixedAsset.countDocuments({})).toBe(0)
    expect(await AccountingAnalytic.countDocuments({})).toBe(0)
    expect(await AuditLog.countDocuments({ entityName: 'fixed assets' })).toBe(0)
  })

  it('a change in the books updates the asset the import made; what the file no longer says is cleared', async () => {
    await chartIn()
    await imported(orgId)
    const before = await assetOf(MACHINE)
    const answer = await imported(orgId, itemsOf({ ...ASSETS, [MACHINE]: { ...MACHINE_PARAMS, 'ДАНСТОЙН': '1400', 'ДАТАЕКСП': '', 'ОТПДАТА': '30.06.2025' } }))
    expect(answer.fixedAssets).toMatchObject({ created: 0, updated: 1, unchanged: 2, unlinked: 1 })
    const after = await assetOf(MACHINE)
    expect(after).toMatchObject({ taxValue: 1400, status: 'disposed', disposalDate: day(2025, 6, 30) })
    expect(after).not.toHaveProperty('inServiceDate')
    expect(String(after._id)).toBe(String(before._id))
    expect(after.params.find((p: any) => p.key === 'ДАНСТОЙН').value).toBe('1400')
    // and back
    await imported(orgId)
    expect(await assetOf(MACHINE)).toMatchObject({ taxValue: 1500, status: 'active', inServiceDate: day(2024, 4, 1) })
  })

  it('a value it cannot read keeps what the asset holds, and is named', async () => {
    await chartIn()
    await imported(orgId)
    const answer = await imported(orgId, itemsOf({ ...ASSETS, [MACHINE]: { ...MACHINE_PARAMS, 'ДАННОРМА': 'тридесет', 'ДАТА': '' } }))
    expect(answer.fixedAssets!.problems).toContainEqual({ path: MACHINE, key: 'ДАННОРМА', reason: 'unreadable' })
    expect(answer.fixedAssets!.problems).toContainEqual({ path: MACHINE, key: 'ДАТА', reason: 'missing' })
    // the properties are the file's; what could not be read is what it was
    expect(await assetOf(MACHINE)).toMatchObject({ taxDepreciationRate: 30, purchaseDate: day(2024, 3, 15), currency: 'BGN' })
    // a problem's answer carries no value of the file
    expect(JSON.stringify(answer.fixedAssets)).not.toContain('тридесет')
  })

  it('an analytic the file no longer lists: its asset stays as it is, and the answer names it', async () => {
    await chartIn()
    await imported(orgId)
    const before = JSON.stringify(await assetOf(LAND))
    const { [LAND]: _gone, ...rest } = ASSETS
    const answer = await imported(orgId, itemsOf(rest))
    expect(answer.fixedAssets).toMatchObject({ created: 0, updated: 0, unchanged: 2, unlinked: 1 })
    expect(answer.fixedAssets!.problems).toContainEqual({ path: LAND, reason: 'vanished' })
    expect(JSON.stringify(await assetOf(LAND))).toBe(before)
    expect(await FixedAsset.countDocuments({ orgId })).toBe(3)
  })
})

describe('an asset kept in LGR', () => {
  const native = async (name: string, code = `FA-${name}`) => {
    const account = await accountId('204')
    return FixedAsset.create({
      orgId, code, name, category: 'machinery', accountId: account, depreciationAccountId: account, accumulatedDepAccountId: account,
      purchaseDate: new Date('2023-01-01'), purchasePrice: 100, usefulLifeMonths: 60, depreciationMethod: 'straight_line', currentValue: 100, status: 'active',
    } as any)
  }

  it('is never written: one of the analytic\'s name is linked as before, and the books make none beside it', async () => {
    await chartIn()
    const kept = await native('Машина А')
    const other = await native('Струг')
    const stored = async () => JSON.stringify(await FixedAsset.find({ _id: { $in: [kept._id, other._id] } }).sort({ _id: 1 }).lean())
    const before = await stored()
    const answer = await imported(orgId)
    expect(answer.fixedAssets).toMatchObject({ linked: 1, unlinked: 1, created: 2 })
    expect(answer.fixedAssets!.problems).toContainEqual({ path: MACHINE, reason: 'native_asset' })
    expect(String((await analyticOf(MACHINE)).fixedAssetId)).toBe(String(kept._id))
    expect(await assetOf(MACHINE)).toBeNull()
    expect(await stored()).toBe(before)
    expect(await imported(orgId).then(a => a.fixedAssets)).toMatchObject({ linked: 1, created: 0, updated: 0, unchanged: 2 })
    expect(await stored()).toBe(before)
  })

  it('made after the import made its own: the analytic stays on the import\'s, and the answer says the name is there twice', async () => {
    await chartIn()
    await imported(orgId)
    const mine = await assetOf(MACHINE)
    const kept = await native('Машина А')
    const answer = await imported(orgId)
    expect(answer.fixedAssets).toMatchObject({ linked: 0, created: 0, updated: 0, unchanged: 3 })
    expect(answer.fixedAssets!.problems).toContainEqual({ path: MACHINE, reason: 'native_namesake' })
    expect(String((await analyticOf(MACHINE)).fixedAssetId)).toBe(String(mine._id))
    // An older client, whose file carries no properties, links by name only what the import did not make.
    const older = await imported(orgId, itemsOf().map(({ params: _p, ...item }) => item))
    expect(older.fixedAssets).toEqual({ linked: 3, unlinked: 1 })
    expect(older.updated).toBe(0)
    expect(String((await analyticOf(MACHINE)).fixedAssetId)).toBe(String(mine._id))
    expect(String(kept._id)).not.toBe(String(mine._id))
  })

  it('holds the code an asset of the import\'s would take: none is made, and it is named', async () => {
    await chartIn()
    await native('Друго име', MACHINE)
    const answer = await imported(orgId)
    expect(answer.fixedAssets).toMatchObject({ created: 2, unlinked: 2 })
    expect(answer.fixedAssets!.problems).toContainEqual({ path: MACHINE, reason: 'code_taken' })
  })
})

describe('where the register is kept', () => {
  it('a store of a split makes no asset; its home makes them all', async () => {
    const home = await createTestOrg({ slug: 'fa-home', taxNumber: EIK } as any)
    const store = await createTestOrg({ slug: 'fa-store', taxNumber: EIK } as any)
    await linkBooks({ booksSlug: 'fa-home', split: true, branches: [{ slug: 'fa-home', code: 'A', docSeries: ['00001'] }, { slug: 'fa-store', code: 'B', docSeries: ['00002'] }] }, { dryRun: false })
    for (const org of [String(home._id), String(store._id)]) await chartIn(org)

    const atStore = await imported(String(store._id))
    expect(atStore.fixedAssets).toEqual({ linked: 0, unlinked: 4 })
    expect(await FixedAsset.countDocuments({ orgId: store._id })).toBe(0)
    expect((await analyticOf(MACHINE, String(store._id))).fixedAssetId).toBeUndefined()
    // It keeps the analytics, properties and all.
    expect((await analyticOf(MACHINE, String(store._id))).params).toHaveLength(Object.keys(MACHINE_PARAMS).length)

    const atHome = await imported(String(home._id))
    expect(atHome.fixedAssets).toMatchObject({ created: 3, unlinked: 1 })
    expect(await FixedAsset.countDocuments({ orgId: home._id })).toBe(3)
  })

  it('an org with no ДА analytics, and a file with no properties, are answered as before, and nothing is made', async () => {
    await chartIn()
    const none = await imported(orgId, itemsOf({}))
    expect(none.fixedAssets).toEqual({ linked: 0, unlinked: 0 })
    const bare = await imported(orgId, itemsOf().map(({ params: _p, ...item }) => item))
    expect(bare.fixedAssets).toEqual({ linked: 0, unlinked: 4 })
    expect(await FixedAsset.countDocuments({})).toBe(0)
  })
})

describe('the marker', () => {
  it('one asset of the import\'s per analytic and org; assets kept in LGR carry none, and any number of them is fine', async () => {
    await chartIn()
    const account = await accountId('204')
    const base = {
      orgId, category: 'x', accountId: account, depreciationAccountId: account, accumulatedDepAccountId: account,
      purchaseDate: new Date('2024-01-01'), purchasePrice: 1, usefulLifeMonths: 12, depreciationMethod: 'straight_line', currentValue: 1,
    }
    await FixedAsset.create({ ...base, code: 'A', name: 'A', sourceModule: 'plusminus', importKey: 'analytic|ДА:A' } as any)
    const twice = await captureRejection(FixedAsset.create({ ...base, code: 'B', name: 'B', sourceModule: 'plusminus', importKey: 'analytic|ДА:A' } as any))
    expect(twice?.code).toBe(11000)
    await FixedAsset.create({ ...base, code: 'C', name: 'C' } as any)
    await FixedAsset.create({ ...base, code: 'D', name: 'D' } as any)
    const elsewhere = await booksOrg()
    await FixedAsset.create({ ...base, orgId: elsewhere, code: 'A', name: 'A', sourceModule: 'plusminus', importKey: 'analytic|ДА:A' } as any)
    expect(await FixedAsset.countDocuments({})).toBe(4)
  })
})
