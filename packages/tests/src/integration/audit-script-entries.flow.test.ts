import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { AuditLog } from 'db/models'
import { queryAuditLogs, recordAuditEntry } from 'services/biz/audit-log.service'

/**
 * FR-27 (#529): the sys-admin scripts are audited. `scripts/access-model.ts` (an org's access model) and
 * `scripts/restore-administrator.ts` act as nobody in the org: their entry names the script (`via`), with no person.
 * They passed `userId: ''`, which the audit cast refused, so neither was ever written (seen on production,
 * 2026-11-11: "Audit log write failed: input must be a 24 character hex string").
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

let orgId = ''
let userId = ''

beforeAll(async () => {
  await setupTestDB()
  const org = await createTestOrg({ slug: 'audit-scripts' } as any)
  orgId = String(org._id)
  userId = String((await createTestUser(org._id, { role: 'admin' } as any))._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('an entry a script writes', () => {
  it('is stored with no person, naming the script', async () => {
    const ok = await recordAuditEntry({
      orgId, userId: '', action: 'update', module: 'admin', entityType: 'org', entityId: orgId, entityName: 'audit-scripts',
      changes: [{ field: 'settings.access.model', oldValue: 'legacy', newValue: 'shadow' }], via: 'scripts/access-model.ts',
    })
    expect(ok).toBe(true)
    const stored: any = await AuditLog.findOne({ orgId, entityType: 'org' }).lean().exec()
    expect(stored).toMatchObject({ via: 'scripts/access-model.ts', action: 'update' })
    expect(stored.userId).toBeUndefined()
  })

  it('reads back with the script as who did it', async () => {
    const { auditLogs } = await queryAuditLogs(orgId, { entityType: 'org' })
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]).toMatchObject({ userId: null, userName: 'scripts/access-model.ts' })
  })

  it('anything else still needs a person', async () => {
    const before = await AuditLog.countDocuments({ orgId })
    expect(await recordAuditEntry({ orgId, userId: '', action: 'update', module: 'admin', entityType: 'user', entityId: userId })).toBe(false)
    expect(await recordAuditEntry({ orgId, userId: '', action: 'update', module: 'admin', entityType: 'user', entityId: userId, via: 'tunnel' })).toBe(false)
    expect(await AuditLog.countDocuments({ orgId })).toBe(before)
    expect(await recordAuditEntry({ orgId, userId, action: 'update', module: 'admin', entityType: 'user', entityId: userId })).toBe(true)
  })
})
