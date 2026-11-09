import { mongoose } from 'db/connection'
import { AccessShadowDiff, Org } from 'db/models'
import { logger } from '../../logger/logger.js'
import { permissionRefusal } from '../route-permission'
import { accessRefusal, type AccessCaller } from './evaluate'

/**
 * FR-27 §4 step 2 (#529) — shadow mode. For an org whose `settings.access.model` is `shadow`, the legacy rules still
 * decide every request, and the new evaluator runs beside them: each answer it would give differently is counted in
 * `access_shadow_diffs`. An org moves to `roles` only after a day with none (`scripts/access-model.ts --report`).
 *
 * ⚠ Never in the request's way: the auth plugins call `shadowAccess` and do not wait. The org's model is cached per
 * process for a minute, the differences are counted in memory and written once a minute.
 */

export type AccessModel = 'legacy' | 'shadow' | 'roles'

const MODEL_TTL_MS = 60_000
const models = new Map<string, { at: number; model: AccessModel }>()

/**
 * The org's access model, cached for a minute. Unset, or an org not found, is `legacy`.
 * ⚠ Through the driver, not the model: a request's own queries are what the query budgets count
 * (`products-supply-list.flow`), and this read is the plugin's, once a minute per org.
 */
export async function accessModelOf(orgId: string): Promise<AccessModel> {
  const hit = models.get(orgId)
  if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.model
  const id = mongoose.isValidObjectId(orgId) ? new mongoose.Types.ObjectId(orgId) : null
  const org: any = id
    ? await mongoose.connection.db!.collection(Org.collection.collectionName)
        .findOne({ _id: id }, { projection: { 'settings.access.model': 1 } })
        .catch(() => null)
    : null
  const model: AccessModel = org?.settings?.access?.model ?? 'legacy'
  if (models.size >= 10_000) models.clear()
  models.set(orgId, { at: Date.now(), model })
  return model
}

/** Drop the cached model of an org whose switch just changed in this process. */
export function forgetAccessModel(orgId: string): void {
  models.delete(String(orgId))
}

interface Pending {
  org: string; day: string; method: string; route: string; role: string
  legacy: 'allow' | 'refuse'; evaluator: 'allow' | 'refuse'; count: number; lastAt: Date
}
const pending = new Map<string, Pending>()

/** Count one answer the evaluator would give differently. */
export function recordShadowDiff(d: { orgId: string; method: string; route: string; role?: string; legacyRefused: boolean }): void {
  const day = new Date().toISOString().slice(0, 10)
  const legacy = d.legacyRefused ? 'refuse' : 'allow'
  const role = d.role ?? ''
  const key = `${d.orgId}|${day}|${d.method}|${d.route}|${role}|${legacy}`
  const row = pending.get(key)
  if (row) {
    row.count++
    row.lastAt = new Date()
  } else {
    pending.set(key, { org: d.orgId, day, method: d.method, route: d.route, role, legacy, evaluator: d.legacyRefused ? 'allow' : 'refuse', count: 1, lastAt: new Date() })
  }
}

/** Write the counted differences; returns how many rows. Called once a minute, and by tests. */
export async function flushShadowDiffs(): Promise<number> {
  if (!pending.size) return 0
  const rows = [...pending.values()]
  pending.clear()
  await AccessShadowDiff.bulkWrite(rows.map(r => ({
    updateOne: {
      filter: { org: new mongoose.Types.ObjectId(r.org), day: r.day, method: r.method, route: r.route, role: r.role, legacy: r.legacy },
      update: { $inc: { count: r.count }, $set: { evaluator: r.evaluator, lastAt: r.lastAt } },
      upsert: true,
    },
  })), { ordered: false })
  return rows.length
}

let timer: ReturnType<typeof setInterval> | null = null
function ensureFlushing(): void {
  if (timer) return
  timer = setInterval(() => {
    flushShadowDiffs().catch(err => logger.warn({ err }, 'access shadow: could not write the differences'))
  }, 60_000)
  ;(timer as any).unref?.()
}

/**
 * The other model's answer, against the one that just decided. Returns at once; the comparison runs after.
 *   - `shadow`: the legacy rules decided; the evaluator is asked beside them.
 *   - `roles` (FR-27.5): the evaluator decided on the role's grant; the legacy rules are asked on the role's
 *     projection, so a role a release that reads no roles would serve differently shows up here.
 * `decidedRefused` is whether the deciding model refused.
 */
export function shadowAccess(user: AccessCaller | null | undefined, orgId: string | undefined, method: string, route: string, decidedRefused: boolean): void {
  if (!user || !orgId || mongoose.connection.readyState !== 1) return
  void accessModelOf(orgId).then(model => {
    let legacyRefused: boolean
    let evaluatorRefused: boolean
    if (model === 'shadow') {
      legacyRefused = decidedRefused
      evaluatorRefused = accessRefusal(user, method, route) !== null
    } else if (model === 'roles' && user.access) {
      evaluatorRefused = decidedRefused
      legacyRefused = permissionRefusal(user as any, method, route) !== null
    } else {
      return
    }
    if (evaluatorRefused === legacyRefused) return
    recordShadowDiff({ orgId, method: method.toUpperCase(), route: route.replace(/\/+$/, ''), role: user.role, legacyRefused })
    ensureFlushing()
  }).catch(err => logger.warn({ err }, 'access shadow: could not compare'))
}
