import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { AbsenceEntry, BackupRun, Employee, EmploymentContract, Org, PayrollRun } from 'db/models'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { applyRestore, inspectBundle, uploadStagingDir } from 'services/biz/backup/backup-restore.service'
import { bundleDir } from 'services/biz/backup/backup-bundle.service'
import { forOrg } from 'services/biz/personal-data/personal-data.service'
import { isSealed } from 'services/biz/personal-data/crypto'
import { openAbsenceDetail, sealAbsenceDetail } from 'services/biz/payroll/bg/absence'
import { openContractPay, sealContractPay } from 'services/biz/payroll/bg/contract-pay'
import { importEmployees, importMonth } from 'services/biz/payroll/bg/import.service'
import { openFiled, openRunItem } from 'services/biz/payroll/bg/run.service'
import type { EmplRow } from 'services/biz/payroll/bg/files/empl2021'
import type { NraFile } from 'services/biz/payroll/bg/files/nra62007'

/**
 * FR-25 §3.12: a whole org's payroll through a real backup and a real restore into another org, where
 * every document gets a new id. A value is bound to its document, its person and its field, so each
 * must come out re-sealed, and open on the new ids under the target's keys.
 *
 * Made-up people. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */
const FAKE_EGN = '7513020014'
const DAY = '2026-09-10'
let TMP = ''

const row = (): EmplRow => ({
  month: 9, year: 2025, employerId: '999999999', personId: FAKE_EGN, personIdKind: 0, surname: 'ПРИМЕРОВА', initials: 'ИП', insuredType: 1,
  from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, from4: 0, to4: 0, from5: 0, to5: 0,
  totalDays: '2088', workedDays: 20, sickDays: 0, childcareDays: 0, noContributionDays: 0, unpaidLeaveDays: 0, employerSickDays: 0,
  hoursWorked: 160, overtimeHours: 0, qualificationGroup: 5, kid: '4690', mainActivityRow: 58, summedTimeCode: '0000',
  zoBaseSick: 0, zoRateSick: 0, insurableIncome: 2000, dooRateEmployer: 10.92, dooRateEmployee: 8.38, zoRateEmployer: 4.8, zoRateEmployee: 3.2,
  tzpbRate: 0.5, uchpfRate: 0, ppfRate: 0, upfRateEmployer: 2.8, upfRateEmployee: 2.2, healthOnlyBase: 0, healthOnlyRate: 0,
  grossPay: 2000, gvrsRate: 0, taxableIncome: 2000, tax: 172.44, netPay: 1551.96, kasaCode: 0, correctionCode: 0, developerId: '888888888',
})

const filed = (): NraFile => ({
  ending: 'crlf-eof',
  record: {
    employerId: '999999999', employerName: 'ПРИМЕР', kasaMember: 0, email: 'A@EXAMPLE.COM', phone: '000000000', gsm: '', developerId: '888888888',
    columns: [0, 1, 2, 3].map(() => ({ month: '', year: '', paymentDate: '', changeFlag: '', paymentType: '', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: null, advanceTax: null })),
  },
})

async function orgWithAdmin(slug: string) {
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia' } } as any)
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.payroll.engine': 'bg' } })
  const email = `${slug}@payroll.test`
  const user = await createTestUser(org._id as any, { email, role: 'admin' } as any)
  return { orgId: String(org._id), userId: String(user._id), email }
}

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-payroll-restore-'))
  config.upload.dir = TMP
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  if (TMP) rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe('a restore into another org', () => {
  it('re-seals the payroll, and every value opens on its new id under the target\'s keys', async () => {
    const from = await orgWithAdmin('payroll-from')
    const to = await orgWithAdmin('payroll-to')

    await importEmployees(from.orgId, [{ personId: FAKE_EGN, personIdKind: 0, firstName: 'ИВА', lastName: 'ПРИМЕРОВА', active: true, knownFrom: '2025-09-01' }], { dryRun: false })
    const employee: any = await Employee.findOne({ orgId: from.orgId }).lean()
    const contractId = new (employee._id.constructor)()
    await EmploymentContract.create({
      _id: contractId, orgId: from.orgId, employeeId: employee._id, date: new Date('2025-09-01'), startDate: new Date('2025-09-01'), source: 'import',
      pay: await sealContractPay(from.orgId, String(contractId), { salaries: [{ effectiveFrom: '2025-09-01', amount: 2000, currency: 'BGN' }] }),
    })
    const absenceId = new (employee._id.constructor)()
    await AbsenceEntry.create({
      _id: absenceId, orgId: from.orgId, employeeId: employee._id, from: new Date('2025-09-01'), to: new Date('2025-09-02'), workingDays: 2,
      detail: await sealAbsenceDetail(from.orgId, String(absenceId), { code: 'incapacity' }),
    })
    const report = await importMonth(from.orgId, from.userId, { period: '202509', version: 'v', rows: [row()], filed: filed() }, { dryRun: false })
    expect(report.action).toBe('create')

    const outcome = await runBackupForOrg(from.orgId, DAY, { kind: 'full' })
    expect(outcome?.status).toBe('completed')
    const backup: any = await BackupRun.findOne({ orgId: from.orgId, date: DAY }).lean().exec()
    const staging = uploadStagingDir(to.orgId)
    mkdirSync(staging, { recursive: true })
    const staged = join(staging, 'payroll.ndjson.zst')
    copyFileSync(join(bundleDir(from.orgId), backup.filename), staged)

    const actor = { userId: to.userId, email: to.email }
    const inspection: any = await inspectBundle(to.orgId, { type: 'path', path: staged }, actor)
    const applied: any = await applyRestore(to.orgId, { type: 'path', path: staged }, {
      mode: 'merge', remap: true, inspectionId: String(inspection._id), actor,
    })
    expect(applied.status).toBe('completed')

    const vault = await forOrg(to.orgId)
    const original: any = await PayrollRun.findOne({ orgId: from.orgId }).lean()
    const run: any = await PayrollRun.findOne({ orgId: to.orgId }).lean()
    expect(String(run._id)).not.toBe(String(original._id))
    expect(run.sealedItems[0].sealed).not.toBe(original.sealedItems[0].sealed)
    expect(isSealed(run.sealedItems[0].sealed)).toBe(true)
    const item = openRunItem(vault, String(run._id), run.sealedItems[0])
    expect(item.result.tax).toBe(172.44)
    expect(item.declaration?.personId).toBe(FAKE_EGN)
    expect(openFiled<NraFile>(vault, String(run._id), run.filed).record.email).toBe('A@EXAMPLE.COM')

    const moved: any = await Employee.findOne({ orgId: to.orgId }).lean()
    expect(moved.nationalIdHmac).toBe(vault.blindIndex('nationalId', FAKE_EGN))
    expect(String(run.sealedItems[0].employeeId)).toBe(String(moved._id))

    const contract: any = await EmploymentContract.findOne({ orgId: to.orgId }).lean()
    expect((await openContractPay(to.orgId, contract))?.salaries[0].amount).toBe(2000)
    const absence: any = await AbsenceEntry.findOne({ orgId: to.orgId }).lean()
    expect((await openAbsenceDetail(to.orgId, absence))?.code).toBe('incapacity')
  })
})
