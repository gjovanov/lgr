import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'
import {
  createApprovalRequest,
  approveStep,
  rejectStep,
  cancelApprovalRequest,
} from 'services/biz/approval.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'state', 'entityType', 'requestedDate']

export const approvalRequestController = new Elysia({ prefix: '/org/:orgId/approvals/requests' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.entityType) filter.entityType = query.entityType
    if (query.requesterId) filter.requesterId = query.requesterId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.approvalRequests.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      approvalRequests: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'approvals.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const req = await r.approvalRequests.findOne({ id, orgId } as any)
    if (!req) return status(404, { message: 'Approval request not found' })
    return req
  }, { access: { permission: 'approvals.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const request = await createApprovalRequest(
      orgId,
      body.entityType,
      body.entityId,
      user.id,
    )

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'approvals',
      entityType: 'ApprovalRequest', entityId: request.id,
      entityName: `${body.entityType}:${body.entityId}`,
    })

    return request
  }, {
    access: { permission: 'approvals.write' },
    body: t.Object({
      entityType: t.String(),
      entityId: t.String(),
    }),
  })

  // ── APPROVE ──
  .post('/:id/approve', async ({ params: { orgId, id }, body, user, status }) => {
    const result = await approveStep(id, orgId, user.id, body?.comment)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'approvals',
      entityType: 'ApprovalRequest', entityId: id,
      changes: [{ field: 'decision', oldValue: 'pending', newValue: 'approved' }],
    })

    return result
  }, {
    access: { permission: 'approvals.write' },
    body: t.Optional(t.Object({
      comment: t.Optional(t.String()),
    })),
  })

  // ── REJECT ──
  .post('/:id/reject', async ({ params: { orgId, id }, body, user, status }) => {
    const result = await rejectStep(id, orgId, user.id, body?.comment)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'approvals',
      entityType: 'ApprovalRequest', entityId: id,
      changes: [{ field: 'decision', oldValue: 'pending', newValue: 'rejected' }],
    })

    return result
  }, {
    access: { permission: 'approvals.write' },
    body: t.Optional(t.Object({
      comment: t.Optional(t.String()),
    })),
  })

  // ── CANCEL ──
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    const result = await cancelApprovalRequest(id, orgId)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'approvals',
      entityType: 'ApprovalRequest', entityId: id,
      changes: [{ field: 'state', oldValue: 'pending', newValue: 'cancelled' }],
    })

    return result
  }, { access: { permission: 'approvals.write' } })
