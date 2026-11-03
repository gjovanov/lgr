import { PermissionSet, User } from 'db/models'
import { ROLE_TO_PERMISSION_SET } from './permission-set.seed.js'

const PAYROLL_READ = 'payroll.read'

/**
 * What a default member's permissions have been, frozen here: `PERMISSIONS` and the seed move on,
 * and this must keep meaning what it meant when it was written (the rule 0005 keeps for `trade.*`).
 *
 * The reads of modules retired on 2026-03-23, and the names retired since. Nothing grants anything
 * on them any more and no screen can tick them, so they say nothing about who edited the list.
 */
const RETIRED_READS = new Set([
  'warehouse.read', 'hr.read', 'crm.read', 'erp.read', 'project.read', 'helpdesk.read', 'sales.read', 'purchase.read',
  'documents.read', 'subscriptions.read', 'approvals.read', 'planning.read', 'recruitment.read', 'fleet.read',
  'maintenance.read', 'knowledge.read', 'field_service.read',
])

/** The seeded set since FR-6.2, once migration 0005 and that release's backfill have run. */
const SEEDED_MEMBER_SET = ['accounting.read', 'inventory.read', 'invoicing.read', 'payroll.read', 'pos.read', 'reports.read']

const OLD_DESCRIPTION = 'Read-only access to all modules'
export const MEMBER_SET_DESCRIPTION = 'Read-only access to every module except payroll'

const live = (permissions: string[]) => permissions.filter(p => !RETIRED_READS.has(p))
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((p, i) => p === [...b].sort()[i])

/**
 * The seeded "Member (Read Only)" set, exactly as a release left it. Anything else about it is an
 * admin's decision: one who took `pos.read` away, or added a write, was looking at this list and
 * left `payroll.read` on it.
 */
function isSeededMemberSet(set: { permissions?: string[] }): boolean {
  return sameList(live(set.permissions ?? []), SEEDED_MEMBER_SET)
}

/**
 * A `member`'s own `permissions`, as registration wrote them from the role's defaults.
 *
 * Reads only, and everything the role has granted since March: 0005 added `pos.read` to a list that
 * held `trade.read`, `reports.read` joined only lists made after FR-6.2 (its backfill wrote sets, not
 * users), and the first releases said `warehouse.read`.
 */
function isDefaultMemberList(permissions: string[]): boolean {
  const known = new Set([...SEEDED_MEMBER_SET, ...RETIRED_READS])
  return permissions.every(p => known.has(p))
    && ['accounting.read', 'invoicing.read', PAYROLL_READ].every(p => permissions.includes(p))
    && (permissions.includes('inventory.read') || permissions.includes('warehouse.read'))
}

export interface MemberPayrollBackfillResult {
  /** The default member sets it took `payroll.read` from (or would, in a dry run). */
  setsChanged: string[]
  /** Sets with the seeded set's identity that an admin changed: they keep it, and someone should look. */
  setsLeftAlone: { name: string; permissions: string[] }[]
  usersChanged: number
  /** Members whose own list holds it and is not a default. They keep it, on an admin's say-so. */
  usersLeftAlone: number
}

/**
 * Take `payroll.read` from one org's default members (FR-25 §3.11), both places it is stored: the
 * seeded set, which outranks the role at sign-in, and a member's own list, which `tokenizeFromRole`
 * merges back over the role's defaults. Idempotent; nothing is written unless `execute`.
 *
 * Each write is guarded on the list it read, as 0005's is, so an edit made meanwhile wins.
 * `beforeWrite` exists for the test that proves it.
 */
export async function backfillMemberPayrollRead(
  orgId: string,
  { execute, beforeWrite }: { execute: boolean; beforeWrite?: () => Promise<void> },
): Promise<MemberPayrollBackfillResult> {
  const result: MemberPayrollBackfillResult = { setsChanged: [], setsLeftAlone: [], usersChanged: 0, usersLeftAlone: 0 }

  const sets = await PermissionSet.find({
    orgId, name: ROLE_TO_PERMISSION_SET.member, isSystem: true, isAdmin: { $ne: true }, permissions: PAYROLL_READ,
  }).lean().exec() as any[]
  const members = await User.find({ orgId, role: 'member', permissions: PAYROLL_READ }, { permissions: 1 }).lean().exec() as any[]

  if (execute) await beforeWrite?.()

  for (const set of sets) {
    if (!isSeededMemberSet(set)) {
      result.setsLeftAlone.push({ name: set.name, permissions: set.permissions })
      continue
    }
    result.setsChanged.push(set.name)
    if (execute) {
      await PermissionSet.updateOne({ _id: set._id, permissions: set.permissions }, {
        $pull: { permissions: PAYROLL_READ },
        ...(set.description === OLD_DESCRIPTION ? { $set: { description: MEMBER_SET_DESCRIPTION } } : {}),
      }).exec()
    }
  }

  const defaults = members.filter(m => isDefaultMemberList(m.permissions))
  result.usersChanged = defaults.length
  result.usersLeftAlone = members.length - defaults.length
  if (execute && defaults.length) {
    await User.bulkWrite(defaults.map(m => ({
      updateOne: { filter: { _id: m._id, orgId, permissions: m.permissions }, update: { $pull: { permissions: PAYROLL_READ } } },
    })) as any)
  }

  return result
}
