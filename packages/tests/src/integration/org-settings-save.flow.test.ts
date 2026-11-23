import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { orgController } from '../../../api/src/controllers/org.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { Org } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import {
  orgSavePayload, tickDefaultRate, vatRowsOf, type OrgSaveForm,
} from '../../../web/src/modules/portal/views/settings/org-save-payload'

/**
 * `PUT /org/:orgId`, the save of Settings → Organization: it writes what it is sent, and nothing else.
 *
 * The page sends part of several settings blocks. Each block used to be written whole, so a save removed every key of
 * the block that the page does not show: the org's default VAT rate and its tax number's label, the accounts stock
 * entries post to, the digest sections the page does not list. Nothing said so, because the model's defaults fill a
 * missing key on the next read through mongoose. That is why every case here reads the stored document itself (lean).
 *
 * Made-up values throughout.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const { Types } = mongoose

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** A document as JSON holds it (ids as text), without the ids mongoose gives the rows of a list. */
function plain<T>(value: T): T {
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_id').map(([k, x]) => [k, strip(x)]))
    return v
  }
  return strip(JSON.parse(JSON.stringify(value)))
}

/** An org of its own for a case, with an admin's session, a way to save it and a way to read what is stored. */
async function scene() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(org._id), role: 'admin', email: 'a@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const put = async (body: Record<string, unknown>) => {
    // As `unified.ts` mounts it.
    const res = await new Elysia().onError(spaErrorHandler({}) as any).use(orgController).handle(new Request(`http://localhost/org/${org._id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }
  /** The stored settings themselves: no model default fills in for a key that is gone. */
  const settings = async () => plain(((await Org.findById(org._id).lean().exec()) as any).settings)
  /** The stored document itself, for the company's fields and lists beside the settings. */
  const stored = async () => plain((await Org.findById(org._id).lean().exec()) as any)
  const plant = (paths: Record<string, unknown>) => Org.updateOne({ _id: org._id }, { $set: paths })
  return { org, put, settings, stored, plant }
}

const PAGE_SECTIONS = ['kpis', 'documents', 'materials', 'stock', 'corrections', 'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops']

/**
 * What the Organization page sends for a person who changed nothing: part of each block it shows. Since #816 no module
 * list and no payroll block (the page has no control for either), and no default VAT rate unless a row is ticked.
 */
const pageSave = (settings: Record<string, unknown> = {}) => ({
  name: 'Test Org',
  description: '',
  representative: '',
  placeOfIssue: '',
  activityCode: '',
  settings: {
    baseCurrency: 'EUR',
    locale: 'en',
    taxConfig: { vatEnabled: true, vatRates: [{ name: 'Standard', rate: 18 }, { name: 'Zero', rate: 0 }] },
    inventory: { defaultCostingMethod: 'wac', allowNegativeStock: false },
    cashRegister: { requireConnectedDevice: true },
    dailyDigest: {
      enabled: false, hour: 7, locale: '', recipients: [],
      sections: Object.fromEntries(PAGE_SECTIONS.map(s => [s, true])),
    },
    ...settings,
  },
})

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

describe('a save of the Organization page keeps what the page does not show', () => {
  it('the tax block: the default rate and the tax number\'s label', async () => {
    const { put, settings, plant } = await scene()
    await plant({ 'settings.taxConfig.defaultVatRate': 9, 'settings.taxConfig.taxIdLabel': 'ЕИК' })

    const res = await put(pageSave())
    expect(res.status).toBe(200)

    expect((await settings()).taxConfig).toEqual({
      vatEnabled: true,
      vatRates: [{ name: 'Standard', rate: 18 }, { name: 'Zero', rate: 0 }],
      defaultVatRate: 9,
      taxIdLabel: 'ЕИК',
    })
    // What the page reads back is the stored rate, not the model's default for a missing one.
    expect(res.json.org.settings.taxConfig.defaultVatRate).toBe(9)
  })

  it('the inventory block: whether stock entries post, and the accounts they post to', async () => {
    const { put, settings, plant } = await scene()
    const stock = new Types.ObjectId()
    const cost = new Types.ObjectId()
    await plant({
      'settings.inventory.autoPostJournalEntries': true,
      'settings.inventory.defaultInventoryAccountId': stock,
      'settings.inventory.defaultCOGSAccountId': cost,
      'settings.inventory.useLocations': true,
    })

    // The two the page shows are changed.
    expect((await put(pageSave({ inventory: { defaultCostingMethod: 'fifo', allowNegativeStock: true } }))).status).toBe(200)

    expect((await settings()).inventory).toEqual({
      defaultCostingMethod: 'fifo',
      allowNegativeStock: true,
      autoPostJournalEntries: true,
      defaultInventoryAccountId: String(stock),
      defaultCOGSAccountId: String(cost),
      useLocations: true,
    })
  })

  it('the digest: the sections the page does not list', async () => {
    const { put, settings, plant } = await scene()
    // Backups is off unless an operator turns it on; the server's own section is on unless turned off.
    await plant({ 'settings.dailyDigest.sections.backups': true, 'settings.dailyDigest.sections.server': false })

    const sections = { ...Object.fromEntries(PAGE_SECTIONS.map(s => [s, true])), stock: false }
    expect((await put(pageSave({ dailyDigest: { enabled: true, hour: 6, locale: '', recipients: [], sections } }))).status).toBe(200)

    const digest = (await settings()).dailyDigest
    expect(digest).toMatchObject({ enabled: true, hour: 6, recipients: [] })
    expect(digest.sections).toMatchObject({ backups: true, server: false, stock: false, kpis: true, ops: true })
  })

  it('what it never sends: the time zone, the access model, the backup switch, the kind of org, the modules, payroll', async () => {
    const { put, settings, plant } = await scene()
    await plant({
      'settings.timezone': 'Europe/Sofia',
      'settings.access.model': 'roles',
      'settings.backup.enabled': true,
      'settings.environment': 'dev',
      'settings.payroll.engine': 'bg',
      'settings.payroll.payFrequency': 'weekly',
      'settings.modules': ['accounting', 'not-a-switch-of-the-page'],
    })

    expect((await put(pageSave())).status).toBe(200)

    const stored = await settings()
    expect(stored).toMatchObject({
      timezone: 'Europe/Sofia', environment: 'dev', access: { model: 'roles' }, backup: { enabled: true },
      // #816: the page has no module switches and no payroll controls any more, so it sends neither.
      modules: ['accounting', 'not-a-switch-of-the-page'],
      payroll: { payFrequency: 'weekly', engine: 'bg', socialSecurityRate: 18, healthInsuranceRate: 7.5, pensionRate: 18 },
    })
  })
})

describe('what a save writes', () => {
  it('one switch of a block leaves the block\'s other switches', async () => {
    const { put, settings, plant } = await scene()
    await plant({ 'settings.cashRegister.requireConnectedDevice': false, 'settings.payroll.engine': 'bg' })

    expect((await put({ settings: { cashRegister: { allowNegativeStock: false }, payroll: { payFrequency: 'weekly' }, taxConfig: { vatEnabled: false } } })).status).toBe(200)

    const stored = await settings()
    expect(stored.cashRegister).toEqual({ requireConnectedDevice: false, allowNegativeStock: false })
    expect(stored.payroll).toMatchObject({ payFrequency: 'weekly', engine: 'bg', pensionRate: 18 })
    expect(stored.taxConfig).toMatchObject({ vatEnabled: false, defaultVatRate: 18, taxIdLabel: 'VAT ID' })
    expect(stored.taxConfig.vatRates).toHaveLength(3)
  })

  it('a list sent replaces the stored list', async () => {
    const { put, settings } = await scene()
    const person = new Types.ObjectId()

    expect((await put({
      settings: {
        modules: ['accounting'],
        taxConfig: { vatRates: [{ name: 'Only', rate: 20 }] },
        dailyDigest: { recipients: [{ userId: String(person) }] },
      },
    })).status).toBe(200)

    const stored = await settings()
    expect(stored.modules).toEqual(['accounting'])
    expect(stored.taxConfig.vatRates).toEqual([{ name: 'Only', rate: 20 }])
    expect(stored.taxConfig.defaultVatRate).toBe(18)
    expect(stored.dailyDigest.recipients).toEqual([{ userId: String(person) }])

    // And an empty one empties it.
    expect((await put({ settings: { taxConfig: { vatRates: [] }, dailyDigest: { recipients: [] } } })).status).toBe(200)
    const emptied = await settings()
    expect(emptied.taxConfig.vatRates).toEqual([])
    expect(emptied.dailyDigest.recipients).toEqual([])
  })

  it('a block sent empty names nothing, and a save with no settings changes none', async () => {
    const { put, settings } = await scene()
    const before = await settings()

    expect((await put({ settings: { taxConfig: {}, inventory: {}, cashRegister: {}, payroll: {}, dailyDigest: { sections: {} } } })).status).toBe(200)
    expect(await settings()).toEqual(before)

    expect((await put({ settings: {} })).status).toBe(200)
    expect((await put({ name: 'Test Org' })).status).toBe(200)
    expect(await settings()).toEqual(before)
  })

  it('the digest\'s language is stored, kept by a save that does not name it, and removed by one that sends it empty', async () => {
    const { put, settings } = await scene()

    expect((await put({ settings: { dailyDigest: { locale: 'bg' } } })).status).toBe(200)
    expect((await settings()).dailyDigest.locale).toBe('bg')

    expect((await put({ settings: { dailyDigest: { enabled: true } } })).status).toBe(200)
    expect(await settings()).toMatchObject({ dailyDigest: { locale: 'bg', enabled: true, hour: 7 } })

    // "Use the org's language": the digest then reads like one that never chose its own.
    expect((await put({ settings: { dailyDigest: { locale: '' } } })).status).toBe(200)
    const digest = (await settings()).dailyDigest
    expect('locale' in digest).toBe(false)
    expect(digest).toMatchObject({ enabled: true, hour: 7 })
  })

  it('a section key that could not be a setting\'s name is not written, and the rest of the save is', async () => {
    const { put, settings } = await scene()
    const before = (await settings()).dailyDigest.sections

    // The last is a name, but of no section the digest has: the model takes no such key.
    const res = await put({ settings: { dailyDigest: { sections: { kpis: false, 'stock.x': true, $set: true, '': true, notASection: true } } } })
    expect(res.status).toBe(200)

    const sections = (await settings()).dailyDigest.sections
    expect(sections).toEqual({ ...before, kpis: false })
  })
})

/** The page's form as a person leaves it: an org with nothing filled in, changed by `over`. */
function pageForm(over: Partial<OrgSaveForm> = {}): OrgSaveForm {
  return {
    name: 'Test Org', description: '',
    taxNumber: '', vatNumber: '', email: '', phone: '', website: '',
    representative: '', placeOfIssue: '', activityCode: '',
    addresses: [], bankDetails: [],
    baseCurrency: 'EUR', defaultLocale: 'en',
    vatEnabled: true, vatRates: vatRowsOf([{ name: 'Standard', rate: 18 }, { name: 'Zero', rate: 0 }], 18),
    defaultCostingMethod: 'wac', allowNegativeStock: false,
    cashRegister: {}, requireConnectedDevice: true,
    digestEnabled: false, digestHour: 7, digestLocale: '', digestRecipients: [],
    digestSections: Object.fromEntries(PAGE_SECTIONS.map(s => [s, true])),
    ...over,
  }
}

/** Made-up company data. */
const COMPANY = {
  taxNumber: '000000000', vatNumber: 'XX000000000', email: 'office@example.test', phone: '+000 0 000 000', website: 'https://example.test',
}

/**
 * #816: what the page lets a person change, and answered "Saved" for, without storing it. Each case saves through the
 * page's own payload (`web/src/modules/portal/views/settings/org-save-payload.ts`) and reads the stored document.
 */
describe('what the page changes is stored (#816)', () => {
  it('the Default box: the ticked row\'s rate becomes the org\'s default rate; no tick keeps the stored one', async () => {
    const { put, settings } = await scene()
    const rows = vatRowsOf([{ name: 'Standard', rate: 18 }, { name: 'Reduced', rate: 9 }, { name: 'Zero', rate: 0 }], 18)
    expect(rows.map(r => r.default)).toEqual([true, false, false])

    tickDefaultRate(rows, 1, true)
    const res = await put(orgSavePayload(pageForm({ vatRates: rows })))
    expect(res.status).toBe(200)
    // The rows are stored as a name and a rate; the tick is the org's default rate.
    expect((await settings()).taxConfig).toMatchObject({
      defaultVatRate: 9,
      vatRates: [{ name: 'Standard', rate: 18 }, { name: 'Reduced', rate: 9 }, { name: 'Zero', rate: 0 }],
    })
    expect(res.json.org.settings.taxConfig.defaultVatRate).toBe(9)

    // Reloaded, the page ticks that row again. Unticked, the save names no default rate, and the stored one stays.
    const reloaded = vatRowsOf(res.json.org.settings.taxConfig.vatRates, res.json.org.settings.taxConfig.defaultVatRate)
    expect(reloaded.map(r => r.default)).toEqual([false, true, false])
    tickDefaultRate(reloaded, 1, false)
    expect((await put(orgSavePayload(pageForm({ vatRates: reloaded })))).status).toBe(200)
    expect((await settings()).taxConfig.defaultVatRate).toBe(9)
  })

  it('a company field emptied is removed; one the save does not name is kept', async () => {
    const { put, stored } = await scene()
    expect((await put(COMPANY)).status).toBe(200)
    expect(await stored()).toMatchObject(COMPANY)

    // Not named: kept.
    expect((await put({ name: 'Test Org' })).status).toBe(200)
    expect(await stored()).toMatchObject(COMPANY)

    // Emptied on the page (spaces only is empty too): the org reads like one that never set them.
    const res = await put(orgSavePayload(pageForm({ vatNumber: '   ' })))
    expect(res.status).toBe(200)
    const org = await stored()
    for (const field of Object.keys(COMPANY)) expect(field in org, field).toBe(false)
    for (const field of Object.keys(COMPANY)) expect(res.json.org[field] ?? '', field).toBe('')
  })

  it('the last address and the last bank account removed: the empty lists are stored', async () => {
    const { put, stored } = await scene()
    const address = { type: 'billing', street: 'Street 1', city: 'Town', state: '', postalCode: '1000', country: 'XX', isDefault: true }
    const bank = { bankName: 'A Bank', accountNumber: '', iban: 'XX00TEST00000000000000', swift: 'TESTXXXX', currency: 'EUR', isDefault: true }
    expect((await put(orgSavePayload(pageForm({ addresses: [address], bankDetails: [bank] })))).status).toBe(200)
    expect((await stored()).addresses).toHaveLength(1)
    expect((await stored()).bankDetails).toHaveLength(1)

    // Not named: kept.
    expect((await put({ name: 'Test Org' })).status).toBe(200)
    expect((await stored()).addresses).toHaveLength(1)

    expect((await put(orgSavePayload(pageForm({ addresses: [], bankDetails: [] })))).status).toBe(200)
    const org = await stored()
    expect(org.addresses).toEqual([])
    expect(org.bankDetails).toEqual([])
  })
})
