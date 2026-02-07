import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { File } from 'db/models'

export const fileController = new Elysia({ prefix: '/org/:orgId/file' })
  .use(AuthService)
  .post(
    '/',
    async ({ params: { orgId }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })

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
  .get('/', async ({ params: { orgId }, query, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.module) filter.module = query.module
    if (query.entityType) filter.entityType = query.entityType
    if (query.entityId) filter.entityId = query.entityId

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      File.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).exec(),
      File.countDocuments(filter).exec(),
    ])

    return { files: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .get('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const file = await File.findOne({ _id: id, orgId }).exec()
    if (!file) return error(404, { message: 'File not found' })

    return file
  }, { isSignIn: true })
  .delete('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const file = await File.findOneAndDelete({ _id: id, orgId }).exec()
    if (!file) return error(404, { message: 'File not found' })

    // TODO: Delete actual file from storage in Phase 9

    return { message: 'File deleted' }
  }, { isSignIn: true })
