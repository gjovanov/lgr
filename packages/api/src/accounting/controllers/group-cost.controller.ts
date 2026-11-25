import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import {
  GroupCostOverrideError,
  createOverride,
  deleteOverride,
  groupAverage,
  listOverrides,
  updateOverride,
} from 'services/biz/accounting-books/group-cost-override.service'

/**
 * FR-25 R3 (2026-11-25): the accountant's overrides of a goods group's average cost (`GroupCostOverride`), which the
 * shadow's cost of sales restates at the start of the override's day. Reading them is the chart's (`accounts.view`);
 * writing them is `accounts.edit` (`config/access/routes.ts`). Only the home of a company's books keeps them: a store of
 * a split answers 409 `not_books_home`, an org without books 409 `not_a_books_org`. A change or a removal names the
 * override as the page showed it (`expected`: its `updatedAt`) and answers 409 `row_changed`, with the row as it is now,
 * when it is no longer that one.
 */

const Id = t.String({ pattern: '^[a-fA-F0-9]{24}$' })
const Day = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
/** EUR a unit; the service bounds and rounds it. */
const UnitCost = t.Number({ minimum: 0 })
const Reason = t.String({ minLength: 1, maxLength: 500 })
/** An override's `updatedAt` as the page showed it. */
const Expected = t.String({ minLength: 1, maxLength: 40 })

function refused(e: unknown, status: any) {
  if (e instanceof GroupCostOverrideError) {
    return status(e.statusCode, { message: e.message, code: e.code, ...(e.stored !== undefined ? { stored: e.stored } : {}) })
  }
  throw e
}

export const groupCostController = new Elysia({ prefix: '/org/:orgId/accounting/group-costs' })
  .use(AppAuthService)
  // The home's overrides, the latest day first.
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await listOverrides(orgId)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
  // A group at the start of a day: what is on hand and the average an override of that day restates.
  .get('/average', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await groupAverage(orgId, query.analyticId, query.day)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, query: t.Object({ analyticId: Id, day: Day }) })
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await createOverride(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, body: t.Object({ analyticId: Id, from: Day, unitCost: UnitCost, reason: Reason }) })
  // The unit and the reason; an override's group and day are never changed (remove it and add another).
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await updateOverride(orgId, id, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, body: t.Object({ unitCost: UnitCost, reason: Reason, expected: Expected }) })
  .delete('/:id', async ({ params: { orgId, id }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await deleteOverride(orgId, id, { expected: query.expected }, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, query: t.Object({ expected: Expected }) })
