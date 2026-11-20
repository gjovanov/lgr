import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import {
  ProductGroupReviewError,
  confirmProductGroup,
  goodsGroupList,
  reviewQueue,
  setProductGroup,
  withdrawProductGroup,
} from 'services/biz/accounting-books/product-group-review.service'

/**
 * FR-25 R3, slice 2: the review queue of the product → accounting group map (`ProductGroupMap`). Reading it is the
 * chart's (`accounts.view`); the accountant's decisions are `accounts.edit` (`config/access/routes.ts`). Only a books
 * org has one: any other answers 409 `not_a_books_org` before anything is read. Every write names the row the queue
 * showed (`expected`: its `updatedAt`, or null for none) and answers 409 `row_changed`, with the row as it is now,
 * when it is no longer that one.
 */

const Id = t.String({ pattern: '^[a-fA-F0-9]{24}$' })
/** A row's `updatedAt` as the queue showed it. */
const Expected = t.String({ minLength: 1, maxLength: 40 })

function refused(e: unknown, status: any) {
  if (e instanceof ProductGroupReviewError) {
    return status(e.statusCode, { message: e.message, code: e.code, ...(e.stored !== undefined ? { stored: e.stored } : {}) })
  }
  throw e
}

export const productGroupController = new Elysia({ prefix: '/org/:orgId/accounting/product-groups' })
  .use(AppAuthService)
  // The queue: `from`, `to`, `state`, `search`, `sortBy` (value | lines | name), `sortOrder`, `page` (0-based), `size`.
  .get('/review', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await reviewQueue(orgId, query as Record<string, unknown>)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
  // The goods groups a product may be given: the picker's.
  .get('/groups', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await goodsGroupList(orgId)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
  // The accountant's group for a product (`source: 'accountant'`).
  .put('/:productId', async ({ params: { orgId, productId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await setProductGroup(orgId, productId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, body: t.Object({ analyticId: Id, expected: t.Union([Expected, t.Null()]) }) })
  // A learning run's group, confirmed as it is.
  .post('/:productId/confirm', async ({ params: { orgId, productId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await confirmProductGroup(orgId, productId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, body: t.Object({ expected: Expected }) })
  // The accountant's decision withdrawn: their own row removed, or a confirmed one's review cleared.
  .delete('/:productId/review', async ({ params: { orgId, productId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await withdrawProductGroup(orgId, productId, { expected: query.expected }, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, query: t.Object({ expected: Expected }) })
