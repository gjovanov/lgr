import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { BackgroundTask, BackupRun, OrgHome } from 'db/models'
import { NODE_STATE_MODELS } from 'db/home/node-state'
import { forgetAllHomes } from 'db/home/home'
import { bundleDir, bundleExclusion, tenantCollections } from 'services/biz/backup/backup-bundle.service'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { applyRestore, inspectBundle } from 'services/biz/backup/backup-restore.service'

/**
 * Bundles exclude FR-20 state (FR-20.3, plan step P0b-10; AC 55 in part).
 *
 * A bundle is how an org's data moves between nodes, so it must carry the org's data and nothing
 * that describes a node: not who the org's home is (`OrgHome`), not which process owns a job
 * (`BackgroundTask`). And a restore must not write such a section back from an older bundle that
 * still has one.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

/**
 * Every model with an `orgId` that IS the org's data. The code includes a model by default (a
 * forgotten one is still backed up); this list is what makes a new model fail here until someone
 * decides which of the three it is.
 */
const ORG_DATA = [
  'Account', 'ArchiveUnit', 'AuditLog', 'BankAccount', 'BankReconciliation', 'CashOrder', 'Code',
  'Contact', 'CostLayer', 'Desktop', 'DesktopEnrollmentCode', 'DesktopEnrollmentKey',
  'DesktopEnrollmentKeyUse', 'DocFile', 'EmailLog', 'Employee', 'ExchangeRate', 'File',
  'FiscalDevice', 'FiscalPeriod', 'FiscalPosition', 'FiscalYear', 'FixedAsset', 'InternalOrder',
  'InventoryCount', 'Invite', 'Invoice', 'Journal', 'JournalEntry', 'Notification', 'OAuthHandoff',
  'OperationType', 'Order', 'OrgApp', 'OrgLogo', 'POSPaymentMethod', 'POSSession', 'POSTransaction',
  'PaymentOrder', 'PaymentTerm', 'PayrollRun', 'Payslip', 'PermissionSet', 'PriceList', 'Product',
  'ProductCategory', 'Reservation', 'Sequence', 'StockLevel', 'StockLocation', 'StockLot',
  'StockMovement', 'SupplierProductAlias', 'Tag', 'TaxReturn', 'Timesheet', 'User', 'Warehouse',
  'Workstation',
]

let TMP = ''
const DAY = '2026-09-10'

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-node-state-'))
  config.upload.dir = TMP
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)
afterEach(async () => {
  ;(NODE_STATE_MODELS as Set<string>).add('BackgroundTask')
  config.backup.sysAdmins = []
  await clearCollections()
  forgetAllHomes()
}, 30_000)

const orgModels = () =>
  Object.keys(mongoose.models).filter(n => !!mongoose.models[n].schema.path('orgId')).sort()

async function seeded() {
  const org = await createTestOrg({ settings: { timezone: 'UTC' } } as any)
  const orgId = String(org._id)
  const user = await createTestUser(org._id as any, { role: 'admin', email: `a-${orgId}@ns.test` } as any)
  await createTestContact(org._id as any)
  await BackgroundTask.create({ orgId: org._id, userId: user._id, type: 'probe', status: 'completed' } as any)
  return { org, orgId, user }
}

async function bundleFor(orgId: string) {
  const outcome = await runBackupForOrg(orgId, DAY, { kind: 'full' })
  expect(outcome?.status).toBe('completed')
  const run: any = await BackupRun.findOne({ orgId, date: DAY }).lean().exec()
  return { run, absolutePath: join(bundleDir(orgId), run.filename) }
}

describe('every model with an orgId is classified', () => {
  it('as the org\'s data, operational, or node state, and as exactly one', () => {
    const unclassified = orgModels().filter(n => !ORG_DATA.includes(n) && !bundleExclusion(n))
    expect(unclassified).toEqual([])
    const both = ORG_DATA.filter(n => bundleExclusion(n))
    expect(both).toEqual([])
  })

  it('the list names no model that is gone', () => {
    const models = new Set(orgModels())
    expect(ORG_DATA.filter(n => !models.has(n))).toEqual([])
    expect([...NODE_STATE_MODELS].filter(n => !models.has(n))).toEqual([])
  })

  it('the bundle takes exactly the org data', () => {
    expect(tenantCollections()).toEqual([...ORG_DATA].sort())
    for (const n of NODE_STATE_MODELS) expect(bundleExclusion(n)).toBe('node_state')
  })
})

describe('a bundle carries no node state', () => {
  it('a seeded org\'s bundle has no OrgHome or BackgroundTask section', async () => {
    const { org, orgId } = await seeded()
    await OrgHome.create({ orgId: org._id, home: 'global', epoch: 0 })

    const { run } = await bundleFor(orgId)
    const names: string[] = (run.collections ?? []).map((c: any) => c.name)

    expect(names).toContain('Contact')
    for (const n of NODE_STATE_MODELS) expect(names).not.toContain(n)
  })

  it('a restore leaves node state alone, even from an older bundle that carries it', async () => {
    const { org, orgId, user } = await seeded()
    // An older bundle: built while BackgroundTask was still bundled.
    ;(NODE_STATE_MODELS as Set<string>).delete('BackgroundTask')
    const { run } = await bundleFor(orgId)
    ;(NODE_STATE_MODELS as Set<string>).add('BackgroundTask')
    expect((run.collections ?? []).map((c: any) => c.name)).toContain('BackgroundTask')

    // Live state moved on: the bundled task is gone, another one runs.
    await BackgroundTask.deleteMany({ orgId }).exec()
    const live = await BackgroundTask.create({ orgId, userId: user._id, type: 'live', status: 'processing' } as any)

    config.backup.sysAdmins = [String((user as any).email)]
    const actor = { userId: String(user._id), email: String((user as any).email) }
    const source = { type: 'run' as const, runId: String(run._id) }
    const inspection: any = await inspectBundle(orgId, source, actor)
    expect(inspection.collections.map((c: any) => c.name)).not.toContain('BackgroundTask')

    const applied: any = await applyRestore(orgId, source, { mode: 'replace', inspectionId: String(inspection._id), actor, confirmSlug: (org as any).slug })

    const tasks: any[] = await BackgroundTask.find({ orgId }).lean().exec()
    expect(tasks.map(t => String(t._id))).toEqual([String(live._id)])
    expect(applied.warnings.join(' ')).toContain('BackgroundTask: 1 documents in the bundle are node state and were not restored')
  })
})
