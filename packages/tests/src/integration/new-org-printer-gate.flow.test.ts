import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Glob } from 'bun'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestFiscalDevice, createTestOrg, createTestWarehouse } from '../helpers/factories'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { draftOf, send, raw, receiptsOf } from '../helpers/receipt-world'
import { FiscalDevice, Org, OrgHome } from 'db/models'
import { mongoose } from 'db/connection'
import { forgetAllHomes } from 'db/home/home'
import { defaultOrgSettings, register } from 'services/biz/auth.service'
import { createOrgForPerson } from 'services/biz/identity/account.service'
import { registerWithOAuth, type OAuthUserInfo } from 'services/biz/oauth.service'
import { tillSettings } from 'invoicing-api/src/lib/cash-register-till'
import { NEVER, ALWAYS_OFF, planGateOff, printerGateOff, writeGateOff } from '../../../../scripts/printer-gate-off'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-23 (owner, 2026-11-01): LGR prints where an org opted in.
 *
 * Every path that creates an org writes the printer gate OFF, explicitly, and the reading of an unset
 * value stays ON, because a real till depends on it: `regal`'s gate is unset, and a default flipped
 * under it would let it sell with no fiscal receipt. Existing orgs are a data step
 * (`scripts/printer-gate-off.ts`), and that script may never touch `regal`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const REPO = resolve(import.meta.dir, '..', '..', '..', '..')
const gateOf = async (slug: string) => ((await Org.findOne({ slug }).lean().exec()) as any)?.settings?.cashRegister?.requireConnectedDevice

let app: any
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); forgetAllHomes(); await clearCollections() }, 30_000)

describe('every path that creates an org writes the gate off', () => {
  const founder = (n: string) => ({
    orgName: `Org ${n}`, orgSlug: `org-${n}`, email: `${n}@gate.test`, username: n, password: 'secure123', firstName: 'A', lastName: 'B',
  })

  it('password registration', async () => {
    await register(founder('reg'))
    expect(await gateOf('org-reg')).toBe(false)
  })

  it('an OAuth sign-up', async () => {
    const info: OAuthUserInfo = { provider: 'google', providerId: 'g-gate-1', email: 'oauth@gate.test', name: 'O Auth', avatarUrl: '', emailVerified: true }
    await registerWithOAuth(info, 'OAuth Org', 'oauth-gate-org', 'oauthgate')
    expect(await gateOf('oauth-gate-org')).toBe(false)
  })

  it('a person founding another org (POST /auth/orgs)', async () => {
    const { user } = await register(founder('first'))
    await createOrgForPerson(user.identityId, { name: 'Second', slug: 'second-org' })
    expect(await gateOf('second-org')).toBe(false)
  })

  /** Each file that creates an org, and what makes it write the gate. */
  const CREATORS: Record<string, string> = {
    'packages/services/src/biz/auth.service.ts': 'settings: defaultOrgSettings(',
    'packages/services/src/biz/identity/account.service.ts': 'settings: defaultOrgSettings(',
    'packages/services/src/biz/oauth.service.ts': 'settings: defaultOrgSettings(',
    'packages/tests/src/helpers/seed.ts': 'cashRegister: { requireConnectedDevice: false }',
    'scripts/import-regal-pz.ts': 'cashRegister: { requireConnectedDevice: false }',
  }
  // Not an org's creation: fixtures, which leave it unset to stand for an org from before.
  const FIXTURES = /^packages\/tests\/src\/(integration|unit|two-node|dal)\/|^packages\/tests\/src\/helpers\/factories\.ts$/
  const CREATES = /\bOrg\.create\(|\bnew Org\(|\bOrg\.insertMany\(|\borgs\.create\(|\borgDao\.create\(|collection\(['"]orgs['"]\)\s*\.insert/g

  it('no path creates one that is not named here, and each one named writes it', () => {
    const found = new Map<string, number>()
    for (const pattern of ['packages/*/src/**/*.{ts,vue}', 'scripts/**/*.ts']) {
      for (const file of new Glob(pattern).scanSync({ cwd: REPO })) {
        const path = file.split('\\').join('/')
        if (FIXTURES.test(path) || path.includes('/node_modules/')) continue
        const n = (readFileSync(join(REPO, path), 'utf8').match(CREATES) ?? []).length
        if (n) found.set(path, n)
      }
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(CREATORS).sort())
    for (const [path, count] of found) {
      const text = readFileSync(join(REPO, path), 'utf8')
      expect(text.split(CREATORS[path]).length - 1).toBeGreaterThanOrEqual(count)
    }
  })

  it('and the one definition says it', () => {
    expect(defaultOrgSettings().cashRegister).toEqual({ requireConnectedDevice: false })
  })
})

describe('what the gate reads', () => {
  it('⚠ unset stays on: an org from before does not lose its gate', async () => {
    const org = await createTestOrg()
    expect(((await Org.findById(org._id).lean().exec()) as any).settings?.cashRegister?.requireConnectedDevice).toBeUndefined()
    expect((await tillSettings(String(org._id))).requireConnectedDevice).toBe(true)
  })

  it('a new org issues a cash invoice with no session and no device, and nothing prints', async () => {
    const w = await tillWorld(app, { device: false })
    const d = await draftOf(w, { method: 'cash', lines: [{ description: 'Услуга', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }] })

    expect((await send(w, d.id, undefined, w.clerkToken)).status).toBe(200)

    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 12 })
    expect(await receiptsOf(d.id)).toHaveLength(0)
  })
})

describe('both refusals say where the switch is', () => {
  for (const locale of ['en', 'bg', 'de', 'mk']) {
    it(`${locale}: no session, not connected, none set up`, () => {
      const s = JSON.parse(readFileSync(join(REPO, 'packages/ui-shared/src/locales', `${locale}.json`), 'utf8'))
      const switchName = s.settings.cashRegister.requireConnectedDevice
      const where = `${s.nav.settings} → ${s.settings.organization} → ${s.settings.cashRegister.title}`
      for (const refusal of [s.cashRegister.receipt.noSession, s.pos.printerRequired.notConnected, s.pos.printerRequired.notConfigured]) {
        expect(refusal).toContain(switchName)
        expect(refusal).toContain(where)
      }
    })
  }

  it('and so does the API, for a client with no catalogue', async () => {
    const w = await tillWorld(app, { requireDevice: true })
    const d = await draftOf(w)

    const noSession = await send(w, d.id, undefined, w.clerkToken)

    expect(noSession.json).toMatchObject({ code: 'fiscal_device_not_connected', noSession: true })
    expect(noSession.json.message).toContain('Settings → Organization → Cash register')

    forgetDevices()
    const notConnected = await send(w, d.id)
    expect(notConnected.json.code).toBe('fiscal_device_not_connected')
    expect(notConnected.json.noSession).toBeUndefined()
    expect(notConnected.json.message).toContain('Settings → Organization → Cash register')
  })
})

describe('scripts/printer-gate-off', () => {
  const db = () => mongoose.connection.db!
  const gate = (value?: boolean) => (value === undefined ? {} : { settings: { cashRegister: { requireConnectedDevice: value } } } as any)
  const stored = (slug: string) => Org.collection.findOne({ slug }) as Promise<any>

  /** One org of each kind the script meets. `regal` has a device, as on prod, unless told. */
  async function theOrgs(o: { regalDevice?: boolean } = {}) {
    const empty = await createTestOrg({ slug: 'no-device' } as any)
    const on = await createTestOrg({ slug: 'no-device-on', ...gate(true) } as any)
    const already = await createTestOrg({ slug: 'already-off', ...gate(false) } as any)
    const gone = await createTestOrg({ slug: 'device-gone' } as any)
    const gonePlace = await createTestWarehouse(gone._id as any)
    await createTestFiscalDevice(gone._id as any, gonePlace._id as any, { isActive: false } as any)
    const live = await createTestOrg({ slug: 'real-till' } as any)
    await createTestFiscalDevice(live._id as any, (await createTestWarehouse(live._id as any))._id as any)
    const pz = await createTestOrg({ slug: 'regal-pz' } as any)
    await createTestFiscalDevice(pz._id as any, (await createTestWarehouse(pz._id as any))._id as any)
    const regal = await createTestOrg({ slug: 'regal' } as any)
    if (o.regalDevice !== false) await createTestFiscalDevice(regal._id as any, (await createTestWarehouse(regal._id as any))._id as any)
    return { empty, on, already, gone, live, pz, regal }
  }

  it('reads the collections the models write', () => {
    expect(Org.collection.name).toBe('orgs')
    expect(FiscalDevice.collection.name).toBe('fiscaldevices')
  })

  it('a dry run says what it would do, and writes nothing', async () => {
    await theOrgs()

    const run = await printerGateOff(db(), { execute: false })

    expect(run.off.map(x => x.org.slug).sort()).toEqual(['device-gone', 'no-device', 'no-device-on', 'regal-pz'])
    expect(run.written).toBe(0)
    expect(await gateOf('no-device')).toBeUndefined()
    expect(await gateOf('no-device-on')).toBe(true)
    expect(await gateOf('regal-pz')).toBeUndefined()
  })

  it('off on every org with no active device, and on regal-pz by name, device and all', async () => {
    await theOrgs()

    const run = await printerGateOff(db(), { execute: true })

    expect(run.written).toBe(4)
    for (const slug of ['no-device', 'no-device-on', 'device-gone', 'regal-pz']) expect(await gateOf(slug)).toBe(false)
    expect(run.off.find(x => x.org.slug === 'regal-pz')!.why).toBe('named')
    expect(run.already).toEqual(['already-off'])
  })

  it('an org with an active device keeps what it has: it may be a real till', async () => {
    await theOrgs()
    await printerGateOff(db(), { execute: true })
    expect(await gateOf('real-till')).toBeUndefined()
  })

  it('⚠ regal is never touched: not with a device, not with none', async () => {
    await theOrgs({ regalDevice: false })

    const run = await printerGateOff(db(), { execute: true })

    expect(run.off.map(x => x.org.slug)).not.toContain(NEVER)
    expect(run.kept).toContain(NEVER)
    expect(await gateOf('regal')).toBeUndefined()
  })

  it('⚠ and naming it stops the script before anything is read or written', async () => {
    await theOrgs()

    const refused = await captureRejection(printerGateOff(db(), { execute: true, only: ['no-device', NEVER] }))

    expect(String(refused)).toContain('Refusing to touch regal')
    expect(await gateOf('no-device')).toBeUndefined()
    expect(await gateOf('regal')).toBeUndefined()
  })

  it('⚠ the write refuses it too, whatever a plan says', async () => {
    const regal = await createTestOrg({ slug: 'regal' } as any)
    const forged = planGateOff([{ _id: regal._id, slug: 'regal' }], new Set())
    expect(forged.off).toHaveLength(0)
    expect(ALWAYS_OFF).not.toContain(NEVER)

    expect(await writeGateOff(db(), regal._id)).toBe(0)
    expect(await gateOf('regal')).toBeUndefined()
  })

  it('touches that one path, only where it differs: the rest of the org is as it was, and a second run writes nothing', async () => {
    await theOrgs()
    await Org.collection.updateOne({ slug: 'no-device' }, { $set: { 'settings.cashRegister.allowNegativeStock': true } })
    const before = await stored('no-device')
    const untouched = await stored('already-off')

    await printerGateOff(db(), { execute: true })

    const after = await stored('no-device')
    expect(after.settings.cashRegister).toEqual({ allowNegativeStock: true, requireConnectedDevice: false })
    delete after.settings.cashRegister.requireConnectedDevice
    expect(after).toEqual(before)
    expect(await stored('already-off')).toEqual(untouched)

    expect((await printerGateOff(db(), { execute: true })).written).toBe(0)
  })

  it('an org homed elsewhere is left to its home', async () => {
    const { empty } = await theOrgs()
    await OrgHome.create({ orgId: empty._id, home: 'node-shop-1', epoch: 1 } as any)
    await Org.updateOne({ _id: empty._id }, { $set: { homeEpochHighWater: 1 } }).exec()
    forgetAllHomes()

    await printerGateOff(db(), { execute: true })

    expect(await gateOf('no-device')).toBeUndefined()
  })
})
