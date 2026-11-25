import { mongoose } from 'db/connection'
import { GroupCostOverride, User } from 'db/models'
import { recordAuditEntry } from '../audit-log.service.js'
import { booksOrgsOf, costOverridesOf, loadGroupCosts } from './group-cost.service.js'
import { assertBooksOrg } from './posting-rule.service.js'
import { goodsGroupOf, goodsGroupsOf, type GoodsGroupRow } from './product-groups.service.js'
import { EUR_CHANGEOVER } from './registry.js'

/**
 * FR-25 R3 (2026-11-25): the accountant's overrides of a goods group's average (`GroupCostOverride`). The shadow's cost
 * of sales is the group's daily average replayed from the books (`group-cost.ts`); the accountant asked for "the daily
 * average price, with an option to override it, for write-offs and other losses the average does not show". An
 * override restates the group's average at the start of its day, and the replay goes on from there.
 *
 * Only the books' HOME keeps them (R7): every org of a split costs a group by its path, so one company has one list. A
 * store of a split answers 409 `not_books_home`, an org that keeps no books 409 `not_a_books_org`.
 *
 * ⚠ An override changes what the shadow books: the next `post-shadow-sales.ts` run reverses the postings it changes on
 * their own days and posts them again. Nothing is written over, and a closed period is left as it is.
 *
 * Every write names the row the page showed (`expected`, its `updatedAt`) and answers 409 `row_changed`, with the row as
 * it is now, when it is no longer that one. Each is in the audit trail.
 */

export class GroupCostOverrideError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly stored?: OverrideView | null) {
    super(message)
    this.name = 'GroupCostOverrideError'
  }
}

export interface OverrideEditor {
  id: string
  operatorCode?: string
}

export interface OverrideView {
  id: string
  analyticId: string
  /** The group's path now; none when its analytic is gone. */
  path?: string
  name?: string
  /** Whether a sale of the group posts at all: an inactive group's documents wait whole (`group_inactive`). */
  active: boolean
  /** `YYYY-MM-DD`: the business day it applies from. */
  from: string
  /** EUR a unit of the group. */
  unitCost: number
  reason: string
  createdBy?: { id: string; name: string }
  updatedBy?: { id: string; name: string }
  createdAt: string
  updatedAt: string
}

/** What the page shows beside a group and a day: what is on hand, and the average an override of that day restates. */
export interface GroupAverage {
  analyticId: string
  path: string
  /** `YYYY-MM-DD` */
  day: string
  /** At the start of the day, every other override applied; none when the books never held the group. */
  quantity?: number
  unitCost?: number
  /** The group's override of that very day, when it has one. */
  override?: OverrideView
}

interface OverrideRow {
  _id: mongoose.Types.ObjectId
  analyticId: mongoose.Types.ObjectId
  from: Date
  unitCost: number
  reason: string
  createdBy?: mongoose.Types.ObjectId
  updatedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const FIELDS = 'analyticId from unitCost reason createdBy updatedBy createdAt updatedAt'
/** The largest unit an override takes, and its decimals: a piece of a fastener costs fractions of a cent. */
export const MAX_UNIT_COST = 10_000_000
export const UNIT_COST_DECIMALS = 6
const REASON_MAX = 500

// ── the checks ───────────────────────────────────────────────────────────────────────────────────

/** The org, when it is the home of its books: the one that keeps the company's overrides. */
async function homeOf(orgId: string): Promise<mongoose.Types.ObjectId> {
  if (!mongoose.isValidObjectId(orgId)) throw new GroupCostOverrideError(404, 'org_not_found', 'No such organisation.')
  await assertBooksOrg(orgId).catch((e: unknown) => {
    if ((e as { code?: string })?.code === 'not_a_books_org') throw new GroupCostOverrideError(409, 'not_a_books_org', 'This organisation keeps no books.')
    throw e
  })
  const { homeOrg } = await booksOrgsOf(orgId)
  if (homeOrg !== orgId) {
    throw new GroupCostOverrideError(409, 'not_books_home', "The company's group costs are kept in the home of its books: open them there.")
  }
  return oid(orgId)
}

/** A business day of the euro: the shadow posts from 2026 on, and the books' amounts before it are leva. */
export function overrideDayOf(v: unknown): Date {
  const s = typeof v === 'string' ? v.trim() : ''
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(NaN)
  if (isNaN(d.getTime()) || isoDay(d) !== s) throw new GroupCostOverrideError(422, 'bad_day', 'The day is not a date (YYYY-MM-DD).')
  if (s < EUR_CHANGEOVER) throw new GroupCostOverrideError(422, 'bad_day', `An override applies from ${EUR_CHANGEOVER} on: the books are in leva before it.`)
  return d
}

/** A unit cost in EUR: not negative, at most `MAX_UNIT_COST`, kept to `UNIT_COST_DECIMALS` decimals. */
export function overrideUnitCostOf(v: unknown): number {
  const n = typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n) || n < 0 || n > MAX_UNIT_COST) {
    throw new GroupCostOverrideError(422, 'bad_unit_cost', `The unit cost is an amount in euro from 0 to ${MAX_UNIT_COST}.`)
  }
  const f = 10 ** UNIT_COST_DECIMALS
  return Math.round(n * f) / f
}

function reasonOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s.length > REASON_MAX) throw new GroupCostOverrideError(422, 'bad_reason', `Say why, in at most ${REASON_MAX} characters: the write-off or loss it stands for.`)
  return s
}

function expectedOf(v: unknown): Date {
  const d = typeof v === 'string' && v.trim() ? new Date(v) : new Date(NaN)
  if (isNaN(d.getTime())) throw new GroupCostOverrideError(422, 'bad_expected', "expected: the override's updatedAt as the page showed it.")
  return d
}

async function activeGoodsGroupOf(home: mongoose.Types.ObjectId, analyticId: string): Promise<GoodsGroupRow> {
  const g = await goodsGroupOf(home, analyticId)
  if (!g?.active) throw new GroupCostOverrideError(422, 'not_a_goods_group', 'Not an active goods group of this organisation.')
  return g
}

const notFound = () => new GroupCostOverrideError(404, 'override_not_found', 'There is no such override.')

// ── the views ────────────────────────────────────────────────────────────────────────────────────

async function viewsOf(home: mongoose.Types.ObjectId, rows: readonly OverrideRow[], groups?: Map<string, GoodsGroupRow>): Promise<OverrideView[]> {
  if (!rows.length) return []
  const byId = groups ?? await goodsGroupsOf(home)
  const userIds = [...new Set(rows.flatMap(r => [r.createdBy, r.updatedBy]).filter(Boolean).map(String))]
  const users = new Map((await User.find({ orgId: home, _id: { $in: userIds.map(oid) } }).select('firstName lastName username').lean<{ _id: unknown; firstName?: string; lastName?: string; username?: string }[]>())
    .map(u => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.username ?? '')]))
  const who = (id: unknown) => (id ? { id: String(id), name: users.get(String(id)) ?? '' } : undefined)
  return rows.map(r => {
    const g = byId.get(String(r.analyticId))
    const createdBy = who(r.createdBy)
    const updatedBy = who(r.updatedBy)
    return {
      id: String(r._id),
      analyticId: String(r.analyticId),
      ...(g ? { path: g.path, name: g.name } : {}),
      active: !!g?.active,
      from: isoDay(new Date(r.from)),
      unitCost: Number(r.unitCost),
      reason: String(r.reason ?? ''),
      ...(createdBy ? { createdBy } : {}),
      ...(updatedBy ? { updatedBy } : {}),
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    }
  })
}

async function viewOf(home: mongoose.Types.ObjectId, row: OverrideRow): Promise<OverrideView> {
  return (await viewsOf(home, [row]))[0]
}

async function currentOf(home: mongoose.Types.ObjectId, id: string): Promise<OverrideRow | null> {
  return GroupCostOverride.findOne({ _id: oid(id), orgId: home }).select(FIELDS).lean<OverrideRow>()
}

async function changed(home: mongoose.Types.ObjectId, id: string): Promise<GroupCostOverrideError> {
  const now = await currentOf(home, id)
  if (!now) return notFound()
  return new GroupCostOverrideError(409, 'row_changed', 'The override was changed meanwhile: the page shows it as it is now.', await viewOf(home, now))
}

// ── the reads ────────────────────────────────────────────────────────────────────────────────────

/** The home's overrides, the latest day first. */
export async function listOverrides(orgId: string): Promise<{ overrides: OverrideView[] }> {
  const home = await homeOf(orgId)
  const rows = await GroupCostOverride.find({ orgId: home }).select(FIELDS).sort({ from: -1, createdAt: -1 }).lean<OverrideRow[]>()
  return { overrides: await viewsOf(home, rows) }
}

/**
 * A group at the start of a day, as the replay has it with every other override applied: what is on hand, and the
 * average the day's own override restates (or would). Read from the books on each call, for one group only.
 */
export async function groupAverage(orgId: string, analyticId: string, dayText: string): Promise<GroupAverage> {
  const home = await homeOf(orgId)
  const group = await goodsGroupOf(home, analyticId)
  if (!group) throw new GroupCostOverrideError(422, 'not_a_goods_group', 'Not a goods group of this organisation.')
  const day = overrideDayOf(dayText)
  const others = (await costOverridesOf(String(home))).filter(o => !(o.path === group.path && o.day === isoDay(day)))
  const costs = await loadGroupCosts(String(home), day, day, { paths: [group.path], overrides: others })
  const state = costs.stateAt(group.id, day)
  const own = await GroupCostOverride.findOne({ orgId: home, analyticId: oid(group.id), from: day }).select(FIELDS).lean<OverrideRow>()
  return {
    analyticId: group.id,
    path: group.path,
    day: isoDay(day),
    ...(state ? { quantity: state.quantity, ...(state.unitCost !== undefined ? { unitCost: state.unitCost } : {}) } : {}),
    ...(own ? { override: await viewOf(home, own) } : {}),
  }
}

// ── the accountant's writes ──────────────────────────────────────────────────────────────────────

/** A new override: one a group and day (409 `override_exists`, with the one there is). */
export async function createOverride(
  orgId: string,
  body: { analyticId: string; from: string; unitCost: number; reason: string },
  by: OverrideEditor,
): Promise<OverrideView> {
  const home = await homeOf(orgId)
  const group = await activeGoodsGroupOf(home, body.analyticId)
  const from = overrideDayOf(body.from)
  const unitCost = overrideUnitCostOf(body.unitCost)
  const reason = reasonOf(body.reason)
  let row: OverrideRow
  try {
    const doc = await GroupCostOverride.create({ orgId: home, analyticId: oid(group.id), from, unitCost, reason, createdBy: oid(by.id) })
    row = doc.toObject() as unknown as OverrideRow
  } catch (e) {
    if ((e as { code?: number })?.code !== 11000) throw e
    const there = await GroupCostOverride.findOne({ orgId: home, analyticId: oid(group.id), from }).select(FIELDS).lean<OverrideRow>()
    throw new GroupCostOverrideError(409, 'override_exists', 'The group has an override from that day already: change that one.', there ? await viewOf(home, there) : null)
  }
  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: 'create', module: 'accounting', entityType: 'group_cost_override', entityId: String(row._id), entityName: group.path,
    changes: { from: { from: null, to: isoDay(from) }, unitCost: { from: null, to: unitCost }, reason: { from: null, to: reason } },
  })
  return viewOf(home, row)
}

/** An override's unit and reason changed; its group and day never are (remove it and add another). */
export async function updateOverride(
  orgId: string,
  id: string,
  body: { unitCost: number; reason: string; expected: string },
  by: OverrideEditor,
): Promise<OverrideView> {
  const home = await homeOf(orgId)
  if (!mongoose.isValidObjectId(id)) throw notFound()
  const at = expectedOf(body.expected)
  const unitCost = overrideUnitCostOf(body.unitCost)
  const reason = reasonOf(body.reason)
  const now = new Date()
  const before = await GroupCostOverride.findOneAndUpdate(
    { _id: oid(id), orgId: home, updatedAt: at },
    { $set: { unitCost, reason, updatedBy: oid(by.id), updatedAt: now } },
    { new: false, timestamps: false },
  ).select(FIELDS).lean<OverrideRow>()
  if (!before) throw await changed(home, id)
  const after: OverrideRow = { ...before, unitCost, reason, updatedBy: oid(by.id), updatedAt: now }
  const view = await viewOf(home, after)
  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: 'update', module: 'accounting', entityType: 'group_cost_override', entityId: id, entityName: view.path ?? String(before.analyticId),
    changes: { unitCost: { from: Number(before.unitCost), to: unitCost }, reason: { from: before.reason, to: reason } },
  })
  return view
}

/** An override removed: the group's average is the replay's own again from that day. */
export async function deleteOverride(orgId: string, id: string, body: { expected: string }, by: OverrideEditor): Promise<{ id: string }> {
  const home = await homeOf(orgId)
  if (!mongoose.isValidObjectId(id)) throw notFound()
  const at = expectedOf(body.expected)
  const current = await currentOf(home, id)
  if (!current) throw notFound()
  if (new Date(current.updatedAt).getTime() !== at.getTime()) throw await changed(home, id)
  const view = await viewOf(home, current)
  const r = await GroupCostOverride.deleteOne({ _id: current._id, orgId: home, updatedAt: at })
  if (!r.deletedCount) throw await changed(home, id)
  await recordAuditEntry({
    orgId, userId: by.id, operatorCode: by.operatorCode,
    action: 'delete', module: 'accounting', entityType: 'group_cost_override', entityId: id, entityName: view.path ?? String(current.analyticId),
    changes: { from: { from: view.from, to: null }, unitCost: { from: view.unitCost, to: null }, reason: { from: view.reason, to: null } },
  })
  return { id }
}
