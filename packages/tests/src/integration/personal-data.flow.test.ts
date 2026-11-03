import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { createTestEmployee, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { AuditLog, Employee, PersonalDataKey } from 'db/models'
import { clearVaultCache, checkPersonalDataKeys, forOrg, keyRowOpens, rewrapKeyRows } from 'services/biz/personal-data/personal-data.service'
import { openEmployeePersonal, sealPlainEmployees } from 'services/biz/personal-data/employee-personal'
import { planPersonalDataRestore } from 'services/biz/personal-data/restore'
import { generateKey, isSealed } from 'services/biz/personal-data/crypto'

/**
 * FR-25 §3.12: personal data is sealed at rest, shown masked, read only through a recorded call, and
 * a missing key is loud. Over HTTP, against the real route table, and against the raw collections:
 * the assertion that matters is what is stored, not what an API chooses to return.
 *
 * Made-up people only. The ЕГН passes the checksum, and month 13 means it can be nobody's.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */
const FAKE_EGN = '7513020014'
const FAKE_IBAN = 'BG80BNBG96611020345678'

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const realKek = config.personalData.kek

let app: Elysia
let orgId: string
let otherOrgId: string
let adminToken: string
let hrToken: string
let readerToken: string

async function tokenFor(user: any, role: string, permissions: string[], org: string) {
  const self = signer as any
  return self.decorator.jwt.sign({ id: String(user._id), email: user.email, username: user.username, firstName: 'A', lastName: 'B', role, orgId: org, permissions })
}

function call(method: string, path: string, token: string, body?: unknown) {
  return app.handle(new Request(`http://localhost/api/org/${orgId}/payroll/employee${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

const newEmployee = (over: Record<string, unknown> = {}) => ({
  employeeNumber: `E-${Math.random().toString(36).slice(2, 9)}`,
  firstName: 'Jane',
  lastName: 'Example',
  department: 'Sales',
  position: 'Clerk',
  employmentType: 'full_time',
  contractStartDate: '2026-01-01',
  salary: { baseSalary: 1000, currency: 'EUR', frequency: 'monthly' },
  ...over,
})

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg()
  const other = await createTestOrg()
  orgId = String(org._id)
  otherOrgId = String(other._id)
  const user = await createTestUser(org._id)
  adminToken = await tokenFor(user, 'admin', [], orgId)
  hrToken = await tokenFor(user, 'hr_manager', ['payroll.read', 'payroll.write', 'payroll.approve', 'payroll.personal'], orgId)
  readerToken = await tokenFor(user, 'member', ['payroll.read'], orgId)
})

afterEach(() => {
  ;(config.personalData as any).kek = realKek
  ;(config.personalData as any).previousKek = undefined
  clearVaultCache()
})

afterAll(async () => {
  await teardownTestDB()
})

async function createSealed() {
  const res = await call('POST', '/', hrToken, newEmployee({ personal: { nationalId: FAKE_EGN, iban: FAKE_IBAN, address: { city: 'Town' } } }))
  expect(res.status).toBe(200)
  return (await res.json()).employee
}

describe('what is stored', () => {
  it('holds nothing of the values in the raw document, and the response only a mask', async () => {
    const employee = await createSealed()
    const raw: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    const stored = JSON.stringify(raw)
    expect(stored).not.toContain(FAKE_EGN)
    expect(stored).not.toContain(FAKE_IBAN)
    expect(stored).not.toContain('Town')
    expect(isSealed(raw.personal)).toBe(true)
    expect(raw.nationalIdMask).toBe('••••••0014')

    const text = JSON.stringify(employee)
    expect(text).not.toContain(FAKE_EGN)
    expect(text).not.toContain(FAKE_IBAN)
    expect(text).not.toContain('pd1.')
    expect(text).not.toContain('nationalIdHmac')
    expect(employee.nationalIdMask).toBe('••••••0014')
    expect(employee.hasPersonal).toBe(true)
  })

  it('a list and a read show the mask and never the record', async () => {
    const employee = await createSealed()
    for (const path of ['/', `/${employee._id ?? employee.id}`]) {
      const res = await call('GET', path, hrToken)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(FAKE_EGN)
      expect(text).not.toContain('pd1.')
      expect(text).toContain('••••••0014')
    }
  })

  it('an exact ЕГН finds its person without opening anything', async () => {
    const employee = await createSealed()
    const res = await call('GET', `/?search=${FAKE_EGN}`, hrToken)
    const { employees } = await res.json()
    expect(employees.map((e: any) => e.employeeNumber)).toContain(employee.employeeNumber)
  })
})

describe('reading a value', () => {
  it('needs the permission: a run\'s totals are not a person', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    expect((await call('GET', '/', readerToken)).status).toBe(403)
    expect((await call('POST', `/${id}/reveal`, readerToken, { fields: ['nationalId'], reason: 'audit' })).status).toBe(403)
  })

  it('answers only the fields asked for, and writes the row first, without the value', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    const res = await call('POST', `/${id}/reveal`, hrToken, { fields: ['nationalId'], reason: 'declaration' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ personal: { nationalId: FAKE_EGN } })

    const rows: any[] = await AuditLog.find({ entityName: employee.employeeNumber, action: 'reveal' }).lean()
    expect(rows).toHaveLength(1)
    expect(rows[0].changes.map((c: any) => c.field)).toEqual(['personal.nationalId'])
    expect(rows[0].changes[0].oldValue).toBe('declaration')
    expect(JSON.stringify(rows[0])).not.toContain(FAKE_EGN)
  })

  it('no audit row anywhere names the values or the person', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    await call('PUT', `/${id}`, adminToken, { personal: { iban: 'BG80BNBG96611020300000' }, salary: { baseSalary: 2222 } })
    await Bun.sleep(100) // the update's audit row is fire-and-forget
    const rows: any[] = await AuditLog.find({ entityName: employee.employeeNumber }).lean()
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const secret of [FAKE_EGN, FAKE_IBAN, 'BG80BNBG96611020300000', '2222', 'pd1.', 'Example']) expect(text).not.toContain(secret)
  })
})

describe('changing a value', () => {
  it('merges, and null clears', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    const res = await call('PUT', `/${id}`, adminToken, { personal: { iban: null, taxId: '123' } })
    expect(res.status).toBe(200)
    const doc: any = await Employee.findOne({ _id: id }).lean()
    const opened = await openEmployeePersonal(orgId, doc)
    expect(opened.nationalId).toBe(FAKE_EGN)
    expect(opened.taxId).toBe('123')
    expect(opened.iban).toBeUndefined()
  })

  it('takes a new ЕГН with a new mask and lookup', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    await call('PUT', `/${id}`, adminToken, { personal: { nationalId: '7513020000' } })
    const doc: any = await Employee.findOne({ _id: id }).lean()
    expect(doc.nationalIdMask).toBe('••••••0000')
    const { employees } = await (await call('GET', '/?search=7513020000', hrToken)).json()
    expect(employees.map((e: any) => e.employeeNumber)).toContain(employee.employeeNumber)
  })

  it('refuses an unknown key rather than storing it', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    await call('PUT', `/${id}`, adminToken, { personal: { nationalId: FAKE_EGN, shoeSize: 44 } })
    const doc: any = await Employee.findOne({ _id: id }).lean()
    expect((await openEmployeePersonal(orgId, doc) as any).shoeSize).toBeUndefined()
  })
})

describe('who may change a person', () => {
  const grantedBoth = () => tokenFor({ _id: orgId, email: 'a@e.st', username: 'a' }, 'accountant', ['payroll.read', 'payroll.write', 'payroll.personal'], orgId)
  const writeOnly = () => tokenFor({ _id: orgId, email: 'b@e.st', username: 'b' }, 'accountant', ['payroll.read', 'payroll.write'], orgId)

  it('is a permission, never a role name: an accountant granted it edits and removes', async () => {
    const employee = await createSealed()
    const token = await grantedBoth()
    const id = employee._id ?? employee.id

    expect((await call('PUT', `/${id}`, token, { notes: 'moved desk', personal: { address: { city: 'Elsewhere' } } })).status).toBe(200)
    expect((await call('DELETE', `/${id}`, token)).status).toBe(200)
    expect((await Employee.collection.findOne({ employeeNumber: employee.employeeNumber }) as any).status).toBe('terminated')
  })

  it('needs both permissions: payroll.write alone touches nobody, sealed fields or not', async () => {
    const employee = await createSealed()
    const token = await writeOnly()
    const id = employee._id ?? employee.id

    expect((await call('POST', '/', token, newEmployee())).status).toBe(403)
    expect((await call('PUT', `/${id}`, token, { notes: 'x' })).status).toBe(403)
    expect((await call('DELETE', `/${id}`, token)).status).toBe(403)

    const stored: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    expect(stored.status).not.toBe('terminated')
    expect(stored.notes).toBeUndefined()
  })

  it('payroll.personal alone writes nothing: the route rule still asks for payroll.write', async () => {
    const employee = await createSealed()
    const token = await tokenFor({ _id: orgId, email: 'c@e.st', username: 'c' }, 'accountant', ['payroll.read', 'payroll.personal'], orgId)

    expect((await call('PUT', `/${employee._id ?? employee.id}`, token, { notes: 'x' })).status).toBe(403)
  })
})

describe('a value cannot be moved', () => {
  it('does not open on another person: nobody redirects a salary by copying a ciphertext', async () => {
    const victim = await createSealed()
    const attacker = await createSealed()
    const attackerRaw: any = await Employee.collection.findOne({ employeeNumber: attacker.employeeNumber })
    await Employee.collection.updateOne({ employeeNumber: victim.employeeNumber }, { $set: { personal: attackerRaw.personal } })
    const moved: any = await Employee.findOne({ employeeNumber: victim.employeeNumber }).lean()
    const refusal = await captureRejection(openEmployeePersonal(orgId, moved))
    expect(String(refusal)).toContain('does not open')
  })

  it('does not open in another org', async () => {
    const employee = await createSealed()
    const raw: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    const refusal = await captureRejection(openEmployeePersonal(otherOrgId, raw))
    expect(String(refusal)).toContain('locked')
  })
})

describe('a missing or wrong key is loud', () => {
  it('without a key: 503 with a name, nothing half-made, and everything else still works', async () => {
    ;(config.personalData as any).kek = undefined
    clearVaultCache()
    const number = `E-locked-${Date.now()}`
    const res = await call('POST', '/', adminToken, newEmployee({ employeeNumber: number, personal: { nationalId: FAKE_EGN } }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('personal_data_locked')
    expect(await Employee.countDocuments({ employeeNumber: number })).toBe(0)

    const plain = await call('POST', '/', adminToken, newEmployee())
    expect(plain.status).toBe(200)
  })

  it('without a key a sealed record is not a blank', async () => {
    const employee = await createSealed()
    const id = employee._id ?? employee.id
    ;(config.personalData as any).kek = undefined
    clearVaultCache()
    const res = await call('POST', `/${id}/reveal`, hrToken, { fields: ['nationalId'], reason: 'edit' })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('personal_data_locked')
    expect((await call('GET', `/${id}`, hrToken)).status).toBe(200)
  })

  it('with the wrong key too, and the startup check names the org', async () => {
    await createSealed()
    ;(config.personalData as any).kek = generateKey().toString('base64')
    clearVaultCache()
    const status = await checkPersonalDataKeys()
    expect(status.unopenable).toContain(orgId)
    const refusal = await captureRejection(forOrg(orgId))
    expect(String(refusal)).toContain('locked')
  })
})

describe('rows from before the sealing', () => {
  it('are sealed at startup, once, and what they held still reads back', async () => {
    const employee = await createTestEmployee((await createTestOrg())._id)
    await Employee.collection.updateOne({ _id: employee._id }, {
      $set: { nationalId: FAKE_EGN, dateOfBirth: new Date('1975-01-02'), 'salary.iban': FAKE_IBAN, address: { city: 'Town', street: 'S', postalCode: '1', country: 'BG' } },
    })
    const first = await sealPlainEmployees()
    expect(first.sealed).toBe(1)
    const raw: any = await Employee.collection.findOne({ _id: employee._id })
    expect(raw.nationalId).toBeUndefined()
    expect(raw.salary.iban).toBeUndefined()
    expect(raw.address).toBeUndefined()
    expect(JSON.stringify(raw)).not.toContain(FAKE_EGN)
    expect(raw.nationalIdMask).toBe('••••••0014')

    const opened = await openEmployeePersonal(raw.orgId, raw)
    expect(opened.nationalId).toBe(FAKE_EGN)
    expect(opened.iban).toBe(FAKE_IBAN)
    expect(opened.dateOfBirth).toBe('1975-01-02')
    expect(opened.address.city).toBe('Town')
    expect((await sealPlainEmployees()).sealed).toBe(0)
  })

  it('without a key are left alone and counted, and no response shows them', async () => {
    const res = await call('POST', '/', adminToken, newEmployee())
    const { employee } = await res.json()
    const id = employee._id ?? employee.id
    await Employee.collection.updateOne({ _id: (await Employee.findOne({ employeeNumber: employee.employeeNumber }).lean() as any)._id }, { $set: { nationalId: FAKE_EGN } })
    ;(config.personalData as any).kek = undefined
    clearVaultCache()
    const swept = await sealPlainEmployees()
    expect(swept.sealed).toBe(0)
    expect(swept.waiting).toBeGreaterThan(0)
    const text = await (await call('GET', `/${id}`, adminToken)).text()
    expect(text).not.toContain(FAKE_EGN)
    ;(config.personalData as any).kek = realKek
    clearVaultCache()
    await sealPlainEmployees()
  })
})

describe('rotating the KEK', () => {
  it('rewraps the rows, touches no data, and everything still opens', async () => {
    const employee = await createSealed()
    const before: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    ;(config.personalData as any).previousKek = realKek
    ;(config.personalData as any).kek = generateKey().toString('base64')
    clearVaultCache()
    const { rewrapped } = await rewrapKeyRows()
    expect(rewrapped).toBeGreaterThan(0)
    ;(config.personalData as any).previousKek = undefined
    clearVaultCache()
    const after: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    expect(after.personal).toBe(before.personal)
    expect((await openEmployeePersonal(orgId, after)).nationalId).toBe(FAKE_EGN)
    // Put the keys back under the suite's own KEK for the tests after this one.
    ;(config.personalData as any).previousKek = (config.personalData as any).kek
    ;(config.personalData as any).kek = realKek
    clearVaultCache()
    await rewrapKeyRows()
  })
})

describe('restoring a bundle', () => {
  async function bundleOf(employee: any) {
    const raw: any = await Employee.collection.findOne({ employeeNumber: employee.employeeNumber })
    const row: any = await PersonalDataKey.collection.findOne({ orgId: raw.orgId })
    return { raw, row, byCollection: new Map<string, any[]>([['Employee', [raw]], ['PersonalDataKey', [row]]]) }
  }

  it('refuses a bundle this server\'s key cannot open, before anything is written', async () => {
    const { byCollection } = await bundleOf(await createSealed())
    ;(config.personalData as any).kek = generateKey().toString('base64')
    clearVaultCache()
    const refusal = await captureRejection(planPersonalDataRestore(byCollection, null))
    expect(String(refusal)).toContain('locked')
  })

  it('refuses sealed values with no keys in the bundle', async () => {
    const { raw } = await bundleOf(await createSealed())
    const refusal = await captureRejection(planPersonalDataRestore(new Map([['Employee', [raw]]]), null))
    expect(String(refusal)).toContain('locked')
  })

  it('re-seals onto a new id and another org\'s keys, and the lookup follows', async () => {
    const { raw, byCollection } = await bundleOf(await createSealed())
    const plan = await planPersonalDataRestore(byCollection, otherOrgId)
    const rewritten = { ...raw, _id: new (raw._id.constructor)(), orgId: (await createTestOrg())._id }
    const [doc] = await plan.prepare('Employee', [raw], [rewritten])
    expect(doc.personal).not.toBe(raw.personal)
    const opened = await (await forOrg(otherOrgId)).open<any>('Employee', String(doc._id), 'personal', doc.personal)
    expect(opened.nationalId).toBe(FAKE_EGN)
    expect(doc.nationalIdHmac).toBe((await forOrg(otherOrgId)).blindIndex('nationalId', FAKE_EGN))
    expect((await plan.applyKeyRow(otherOrgId)).inserted).toBe(0)
  })

  it('brings a lost key row back, and merges keys a replaced row no longer has', async () => {
    const { row, byCollection } = await bundleOf(await createSealed())
    expect(keyRowOpens(row)).toBe(true)
    await PersonalDataKey.collection.deleteOne({ _id: row._id })
    clearVaultCache()
    const plan = await planPersonalDataRestore(byCollection, null)
    expect((await plan.applyKeyRow(orgId)).inserted).toBe(1)
    plan.finished(orgId)

    const live: any = await PersonalDataKey.collection.findOne({ orgId: row.orgId })
    await PersonalDataKey.collection.updateOne({ _id: live._id }, { $set: { keys: [] } })
    expect((await plan.applyKeyRow(orgId)).merged).toBe(row.keys.length)
    await PersonalDataKey.collection.updateOne({ _id: live._id }, { $set: { keys: row.keys } })
    plan.finished(orgId)
  })
})
