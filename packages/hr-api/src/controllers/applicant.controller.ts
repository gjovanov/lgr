import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const VALID_TRANSITIONS: Record<string, string[]> = {
  new: ['initial_review', 'refused', 'withdrawn'],
  initial_review: ['interview', 'refused', 'withdrawn'],
  interview: ['offer', 'refused', 'withdrawn'],
  offer: ['hired', 'refused', 'withdrawn'],
}

export const applicantController = new Elysia({ prefix: '/org/:orgId/hr/applicants' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.read') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'email', 'notes'])
      Object.assign(filter, searchFilter)
    }
    if (query.state) filter.state = query.state
    if (query.jobPositionId) filter.jobPositionId = query.jobPositionId
    if (query.source) filter.source = query.source

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.applicants.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { applicants: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('recruitment.write') && !['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      // Verify job position exists and is published
      const position = await r.jobPositions.findOne({ id: body.jobPositionId, orgId } as any)
      if (!position) return status(404, { message: 'Job position not found' })
      if ((position as any).state === 'closed')
        return status(400, { message: 'Cannot add applicant to a closed position' })

      if (body.rating !== undefined && (body.rating < 0 || body.rating > 5))
        return status(400, { message: 'Rating must be between 0 and 5' })

      const applicant = await r.applicants.create({
        ...body,
        orgId,
        state: 'new',
        stageName: 'New',
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'applicant', entityId: applicant.id, entityName: (applicant as any).name })

      return { applicant }
    },
    {
      isSignIn: true,
      body: t.Object({
        jobPositionId: t.String(),
        name: t.String({ minLength: 1 }),
        email: t.String({ format: 'email' }),
        phone: t.Optional(t.String()),
        source: t.Optional(t.Union([
          t.Literal('website'),
          t.Literal('referral'),
          t.Literal('linkedin'),
          t.Literal('agency'),
          t.Literal('job_board'),
          t.Literal('other'),
        ])),
        referrerId: t.Optional(t.String()),
        resumeFileId: t.Optional(t.String()),
        rating: t.Optional(t.Number({ minimum: 0, maximum: 5 })),
        interviewDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        salary: t.Optional(t.Number({ minimum: 0 })),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.read') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const applicant = await r.applicants.findOne({ id, orgId } as any)
    if (!applicant) return status(404, { message: 'Applicant not found' })

    return { applicant }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('recruitment.write') && !['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.applicants.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Applicant not found' })

      if (body.rating !== undefined && (body.rating < 0 || body.rating > 5))
        return status(400, { message: 'Rating must be between 0 and 5' })

      const applicant = await r.applicants.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'applicant', entityId: id, entityName: (applicant as any).name, changes: diffChanges(existing as any, applicant as any) })

      return { applicant }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        stageName: t.Optional(t.String()),
        source: t.Optional(t.String()),
        referrerId: t.Optional(t.String()),
        resumeFileId: t.Optional(t.String()),
        rating: t.Optional(t.Number({ minimum: 0, maximum: 5 })),
        interviewDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        salary: t.Optional(t.Number({ minimum: 0 })),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.manage') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.applicants.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Applicant not found' })

    await r.applicants.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'hr', entityType: 'applicant', entityId: id, entityName: (existing as any).name })

    return { message: 'Applicant deleted' }
  }, { isSignIn: true })
  .post(
    '/:id/transition',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('recruitment.manage') && !['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.applicants.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Applicant not found' })

      const currentState = (existing as any).state
      const allowed = VALID_TRANSITIONS[currentState]
      if (!allowed || !allowed.includes(body.targetState))
        return status(400, { message: `Cannot transition from '${currentState}' to '${body.targetState}'` })

      const updates: any = { state: body.targetState }
      if (body.targetState === 'initial_review') updates.stageName = 'Initial Review'
      if (body.targetState === 'interview') updates.stageName = 'Interview'
      if (body.targetState === 'offer') updates.stageName = 'Offer'
      if (body.targetState === 'hired') updates.stageName = 'Hired'
      if (body.targetState === 'refused') updates.stageName = 'Refused'
      if (body.targetState === 'withdrawn') updates.stageName = 'Withdrawn'

      // On hire, increment the job position's hiredCount
      if (body.targetState === 'hired') {
        const position = await r.jobPositions.findOne({ id: (existing as any).jobPositionId, orgId } as any)
        if (!position) return status(400, { message: 'Associated job position not found' })
        if ((position as any).state === 'closed')
          return status(400, { message: 'Cannot hire for a closed position' })
        const newCount = ((position as any).hiredCount || 0) + 1
        await r.jobPositions.update((existing as any).jobPositionId, { hiredCount: newCount } as any)
      }

      const applicant = await r.applicants.update(id, updates)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'applicant', entityId: id, entityName: (applicant as any).name, changes: [{ field: 'state', before: currentState, after: body.targetState }] })

      return { applicant }
    },
    {
      isSignIn: true,
      body: t.Object({
        targetState: t.Union([
          t.Literal('initial_review'),
          t.Literal('interview'),
          t.Literal('offer'),
          t.Literal('hired'),
          t.Literal('refused'),
          t.Literal('withdrawn'),
        ]),
      }),
    },
  )
