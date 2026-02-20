import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { Pipeline } from 'db/models'

export const pipelineController = new Elysia({ prefix: '/org/:orgId/crm/pipeline' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const pipelines = await Pipeline.find({ orgId }).sort({ name: 1 }).exec()
    return { pipelines }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'manager'].includes(user.role))
        return status(403, { message: 'Admin or manager only' })

      const pipeline = await Pipeline.create({ ...body, orgId })
      return pipeline.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        stages: t.Array(t.Object({
          name: t.String({ minLength: 1 }),
          order: t.Number(),
          probability: t.Number({ minimum: 0, maximum: 100 }),
          color: t.String(),
        })),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const pipeline = await Pipeline.findOne({ _id: id, orgId }).lean().exec()
    if (!pipeline) return status(404, { message: 'Pipeline not found' })

    return pipeline
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'manager'].includes(user.role))
        return status(403, { message: 'Admin or manager only' })

      const pipeline = await Pipeline.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!pipeline) return status(404, { message: 'Pipeline not found' })

      return pipeline
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        stages: t.Optional(t.Array(t.Object({
          name: t.String({ minLength: 1 }),
          order: t.Number(),
          probability: t.Number({ minimum: 0, maximum: 100 }),
          color: t.String(),
        }))),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role))
      return status(403, { message: 'Admin or manager only' })

    const pipeline = await Pipeline.findOneAndUpdate(
      { _id: id, orgId },
      { isActive: false },
      { new: true },
    ).exec()
    if (!pipeline) return status(404, { message: 'Pipeline not found' })

    return { message: 'Pipeline deactivated' }
  }, { isSignIn: true })
