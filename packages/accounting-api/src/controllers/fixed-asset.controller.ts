import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { clientCreate, clientUpdate } from 'services/biz/server-owned'
import { isImportedAsset } from 'services/biz/accounting-books/fixed-asset-register'
import { listFixedAssets, nativeAssetMatch } from 'services/biz/fixed-asset.service'
import { ASSET_AS_BOOKED, TAX_FIELDS, inServiceBeforePurchase, taxUpdateOf, type TaxProblem, type TaxUpdate } from 'config/fixed-asset-tax'

/**
 * FR-25a §3.4: an asset the books import made (`sourceModule: 'plusminus'` + `importKey`) is as booked. The next import
 * would overwrite an edit, and a register the accountant keeps must not differ from ours: no change and no delete of one
 * here, with the code the analytics and the chart answer. An asset kept in LGR saves as before, and its tax side by the
 * rules of `config/fixed-asset-tax.ts`.
 */
const AS_BOOKED_ASSET = {
  code: ASSET_AS_BOOKED,
  message: "This fixed asset is as booked in the accountant's program: the books import keeps it, and it is not changed here.",
}

/** FR-25a §3.4: the tax side (ЗКПО) a body may state. `null`, or an empty text, clears a field. */
const taxBody = {
  taxCategory: t.Optional(t.Union([t.Null(), t.Literal(''), t.String({ pattern: '^[1-7]$' }), t.Integer({ minimum: 1, maximum: 7 })])),
  taxDepreciationRate: t.Optional(t.Union([t.Number({ minimum: 0, maximum: 100 }), t.Null()])),
  taxUsefulLifeMonths: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
  taxValue: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
  inServiceDate: t.Optional(t.Union([t.String({ maxLength: 40 }), t.Null()])),
}

// Every other field is the model's to check, as before. What a body may not choose (the fields the server sets, the
// marks of an asset of the books among them) is refused in the handlers: `services/biz/server-owned.ts`.
const createBody = t.Object(taxBody, { additionalProperties: true })
// A PUT never carries `orgId`: a document does not move between orgs (FR-20.7). `updateInOrg` drops it too; this
// answers 422 instead of ignoring it.
const updateBody = t.Object({ orgId: t.Optional(t.Never()), ...taxBody }, { additionalProperties: true })

function taxRefusal(problems: TaxProblem[]) {
  return {
    code: 'fixed_asset_tax_invalid',
    message: `The tax side is not valid: ${problems.map(p => `${p.field} (${p.code})`).join(', ')}`,
    problems,
  }
}

/**
 * The problems of a body's tax side: each field's own, and the in-service date before the purchase date. `held` is what
 * the asset stores now (an edit), and the dates are compared only when the body states one of them, so an edit of
 * something else never trips over what was stored before these rules.
 */
function taxProblemsOf(body: Record<string, any>, update: TaxUpdate, held: Record<string, any> = {}): TaxProblem[] {
  const problems = [...update.problems]
  if ('inServiceDate' in body || 'purchaseDate' in body) {
    const inService = update.unset.includes('inServiceDate') ? undefined : (update.set.inServiceDate ?? held.inServiceDate)
    const purchase = body.purchaseDate !== undefined ? body.purchaseDate : held.purchaseDate
    if (!problems.some(p => p.field === 'inServiceDate') && inServiceBeforePurchase(inService, purchase)) {
      problems.push({ field: 'inServiceDate', code: 'in_service_before_purchase' })
    }
  }
  return problems
}

/** The body with its tax side as the asset stores it: the fields set, never a cleared one. */
function withTaxSide(data: Record<string, any>, update: TaxUpdate) {
  const out = { ...data }
  for (const field of TAX_FIELDS) delete out[field]
  return { ...out, ...update.set }
}

export const fixedAssetController = new Elysia({ prefix: '/org/:orgId/accounting/fixed-asset' })
  .use(AppAuthService)
  // FR-25a §3.4: a page of the register as the grid shows it, without the properties and the schedule, each row saying
  // whether the books import made it; filtered by tax category and by where the asset comes from.
  .get('/', async ({ params, query }) => {
    const result = await listFixedAssets(params.orgId, query as Record<string, unknown>)
    return { fixedAssets: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.fixedAssets.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { fixedAsset: { ...item, imported: isImportedAsset(item as any) } }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user, status }) => {
    const r = getRepos()
    const data = clientCreate('FixedAsset', body, { orgId: params.orgId })
    const tax = taxUpdateOf(data)
    const problems = taxProblemsOf(data, tax)
    if (problems.length) return status(422, taxRefusal(problems))
    const item = await r.fixedAssets.create({ ...withTaxSide(data, tax), orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'fixed_asset', entityId: item.id, entityName: (item as any).name })

    return { fixedAsset: { ...item, imported: false } }
  }, { isSignIn: true, body: createBody })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.fixedAssets.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    // As booked, for everyone and whatever the body holds: nothing of it is LGR's to change.
    if (isImportedAsset(existing as any)) return status(422, AS_BOOKED_ASSET)

    const data = clientUpdate('FixedAsset', body, existing)
    const tax = taxUpdateOf(data)
    const problems = taxProblemsOf(data, tax, existing as any)
    if (problems.length) return status(422, taxRefusal(problems))

    // The guard names an asset kept in LGR: a write never lands on one of the books, even between the read and the write.
    const item = await r.fixedAssets.updateInOrg(params.id, params.orgId, withTaxSide(data, tax) as any, nativeAssetMatch(), { validate: true, unset: tax.unset })
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'fixed_asset', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { fixedAsset: { ...item, imported: false } }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    const existing = await r.fixedAssets.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    if (isImportedAsset(existing as any)) return status(422, AS_BOOKED_ASSET)
    const deleted = await r.fixedAssets.deleteInOrg(params.id, params.orgId, nativeAssetMatch())
    if (!deleted) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'fixed_asset', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
