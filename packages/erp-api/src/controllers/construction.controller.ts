import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { ConstructionProject } from 'db/models'

export const constructionController = new Elysia({ prefix: '/org/:orgId/erp/construction-project' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.clientId) filter.clientId = query.clientId

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      ConstructionProject.find(filter).sort({ startDate: -1 }).skip(skip).limit(pageSize).exec(),
      ConstructionProject.countDocuments(filter).exec(),
    ])

    return { projects: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const project = await ConstructionProject.create({
        ...body,
        orgId,
        status: 'planning',
        createdBy: user.id,
      })

      return { project: project.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        projectNumber: t.String({ minLength: 1 }),
        name: t.String({ minLength: 1 }),
        clientId: t.String(),
        address: t.Optional(t.Object({
          street: t.String(),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
        })),
        startDate: t.String(),
        expectedEndDate: t.String(),
        budget: t.Object({
          estimated: t.Number(),
          currency: t.String(),
          approved: t.Number(),
          spent: t.Optional(t.Number()),
          remaining: t.Number(),
        }),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const project = await ConstructionProject.findOne({ _id: id, orgId })
      .populate('clientId', 'companyName firstName lastName')
      .lean()
      .exec()
    if (!project) return status(404, { message: 'Construction project not found' })

    return { project }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const project = await ConstructionProject.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!project) return status(404, { message: 'Construction project not found' })

      return { project }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        status: t.Optional(t.Union([
          t.Literal('planning'),
          t.Literal('active'),
          t.Literal('on_hold'),
          t.Literal('completed'),
          t.Literal('cancelled'),
        ])),
        expectedEndDate: t.Optional(t.String()),
        actualEndDate: t.Optional(t.String()),
        budget: t.Optional(t.Object({
          estimated: t.Optional(t.Number()),
          currency: t.Optional(t.String()),
          approved: t.Optional(t.Number()),
          spent: t.Optional(t.Number()),
          remaining: t.Optional(t.Number()),
        })),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const project = await ConstructionProject.findOne({ _id: id, orgId }).exec()
    if (!project) return status(404, { message: 'Construction project not found' })
    if (!['planning', 'cancelled'].includes(project.status))
      return status(400, { message: 'Can only delete planning or cancelled projects' })

    await ConstructionProject.findByIdAndDelete(id).exec()
    return { message: 'Construction project deleted' }
  }, { isSignIn: true })
