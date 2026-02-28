import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { File } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const fileController = new Elysia({ prefix: '/org/:orgId/file' })
  .use(AuthService)
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // For now, handle metadata only - actual file upload in Phase 9
      const file = await File.create({
        orgId,
        uploadedBy: user.id,
        originalName: body.originalName,
        storagePath: body.storagePath || '',
        storageProvider: body.storageProvider || 'local',
        mimeType: body.mimeType,
        size: body.size,
        module: body.module,
        entityType: body.entityType,
        entityId: body.entityId,
        tags: body.tags,
      })

      return file
    },
    {
      isSignIn: true,
      body: t.Object({
        originalName: t.String({ minLength: 1 }),
        storagePath: t.Optional(t.String()),
        storageProvider: t.Optional(t.String()),
        mimeType: t.String(),
        size: t.Number(),
        module: t.String(),
        entityType: t.Optional(t.String()),
        entityId: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.module) filter.module = query.module
    if (query.entityType) filter.entityType = query.entityType
    if (query.entityId) filter.entityId = query.entityId

    const result = await paginateQuery(File, filter, query)
    return { files: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const file = await File.findOne({ _id: id, orgId }).exec()
    if (!file) return status(404, { message: 'File not found' })

    return file
  }, { isSignIn: true })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const file = await File.findOneAndDelete({ _id: id, orgId }).exec()
    if (!file) return status(404, { message: 'File not found' })

    // TODO: Delete actual file from storage in Phase 9

    return { message: 'File deleted' }
  }, { isSignIn: true })
