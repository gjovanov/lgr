import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

const answerSchema = t.Object({
  question: t.String({ minLength: 1 }),
  answer: t.String(),
  rating: t.Optional(t.Number({ minimum: 0, maximum: 5 })),
})

const goalSchema = t.Object({
  description: t.String({ minLength: 1 }),
  status: t.Optional(t.Union([
    t.Literal('not_started'),
    t.Literal('in_progress'),
    t.Literal('achieved'),
    t.Literal('missed'),
  ])),
})

export const appraisalController = new Elysia({ prefix: '/org/:orgId/hr/appraisals' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('hr.read') && !['admin', 'hr_manager', 'manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.employeeId) filter.employeeId = query.employeeId
    if (query.reviewerId) filter.reviewerId = query.reviewerId

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'dateScheduled'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.appraisals.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { appraisals: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('hr.write') && !['admin', 'hr_manager', 'manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const appraisal = await r.appraisals.create({
        ...body,
        orgId,
        state: 'draft',
        selfEvaluation: body.selfEvaluation || [],
        managerEvaluation: body.managerEvaluation || [],
        goals: body.goals || [],
        overallRating: 0,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'appraisal', entityId: appraisal.id, entityName: `Appraisal for ${(body as any).employeeId}` })

      return { appraisal }
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeId: t.String(),
        reviewerId: t.String(),
        dateScheduled: t.String(),
        selfEvaluation: t.Optional(t.Array(answerSchema)),
        managerEvaluation: t.Optional(t.Array(answerSchema)),
        goals: t.Optional(t.Array(goalSchema)),
        nextAppraisalDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('hr.read') && !['admin', 'hr_manager', 'manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const appraisal = await r.appraisals.findOne({ id, orgId } as any)
    if (!appraisal) return status(404, { message: 'Appraisal not found' })

    return { appraisal }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('hr.write') && !['admin', 'hr_manager', 'manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.appraisals.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Appraisal not found' })
      if ((existing as any).state === 'completed')
        return status(400, { message: 'Cannot edit a completed appraisal' })

      const appraisal = await r.appraisals.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'appraisal', entityId: id, entityName: `Appraisal for ${(existing as any).employeeId}`, changes: diffChanges(existing as any, appraisal as any) })

      return { appraisal }
    },
    {
      isSignIn: true,
      body: t.Object({
        dateScheduled: t.Optional(t.String()),
        selfEvaluation: t.Optional(t.Array(answerSchema)),
        managerEvaluation: t.Optional(t.Array(answerSchema)),
        overallRating: t.Optional(t.Number({ minimum: 0, maximum: 5 })),
        goals: t.Optional(t.Array(goalSchema)),
        nextAppraisalDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('hr.write') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.appraisals.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Appraisal not found' })
    if ((existing as any).state === 'completed')
      return status(400, { message: 'Cannot delete a completed appraisal' })

    await r.appraisals.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'hr', entityType: 'appraisal', entityId: id, entityName: `Appraisal for ${(existing as any).employeeId}` })

    return { message: 'Appraisal deleted' }
  }, { isSignIn: true })
  // Submit self-evaluation: draft/scheduled -> in_progress
  .post(
    '/:id/submit-self',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.appraisals.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Appraisal not found' })

      const state = (existing as any).state
      if (!['draft', 'scheduled'].includes(state))
        return status(400, { message: 'Self-evaluation can only be submitted in draft or scheduled state' })

      const updates: any = {
        state: 'in_progress',
      }
      if (body.selfEvaluation) updates.selfEvaluation = body.selfEvaluation

      const appraisal = await r.appraisals.update(id, updates)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'appraisal', entityId: id, entityName: `Appraisal for ${(existing as any).employeeId}`, changes: [{ field: 'state', before: state, after: 'in_progress' }] })

      return { appraisal }
    },
    {
      isSignIn: true,
      body: t.Object({
        selfEvaluation: t.Optional(t.Array(answerSchema)),
      }),
    },
  )
  // Complete appraisal: in_progress -> completed
  .post(
    '/:id/complete',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('hr.write') && !['admin', 'hr_manager', 'manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.appraisals.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Appraisal not found' })
      if ((existing as any).state !== 'in_progress')
        return status(400, { message: 'Only in-progress appraisals can be completed' })

      const updates: any = {
        state: 'completed',
        dateCompleted: new Date(),
      }
      if (body.managerEvaluation) updates.managerEvaluation = body.managerEvaluation
      if (body.overallRating !== undefined) updates.overallRating = body.overallRating
      if (body.goals) updates.goals = body.goals
      if (body.nextAppraisalDate) updates.nextAppraisalDate = body.nextAppraisalDate

      const appraisal = await r.appraisals.update(id, updates)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'appraisal', entityId: id, entityName: `Appraisal for ${(existing as any).employeeId}`, changes: [{ field: 'state', before: 'in_progress', after: 'completed' }] })

      return { appraisal }
    },
    {
      isSignIn: true,
      body: t.Object({
        managerEvaluation: t.Optional(t.Array(answerSchema)),
        overallRating: t.Optional(t.Number({ minimum: 0, maximum: 5 })),
        goals: t.Optional(t.Array(goalSchema)),
        nextAppraisalDate: t.Optional(t.String()),
      }),
    },
  )
