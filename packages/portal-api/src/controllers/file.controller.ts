import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { File } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { normalizeStored } from 'services/biz/files/stored-path'

export const fileController = new Elysia({ prefix: '/org/:orgId/file' })
  .use(AuthService)
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // FR-20.24: a local path is stored relative to the upload root, and only ever one of the
      // caller's own org. Another provider's key is not a path and is kept as it is.
      const storageProvider = body.storageProvider || 'local'
      let storagePath = body.storagePath || ''
      if (storageProvider === 'local' && storagePath) {
        try { storagePath = normalizeStored(storagePath) } catch (e) { return status(422, { message: (e as Error).message }) }
        if (storagePath.split('/')[0] !== String(orgId)) return status(422, { message: 'storagePath is not in this organization' })
      }

      const file = await File.create({
        orgId,
        uploadedBy: user.id,
        originalName: body.originalName,
        storagePath,
        storageProvider,
        mimeType: body.mimeType,
        size: body.size,
        module: body.module,
        entityType: body.entityType,
        entityId: body.entityId,
        tags: body.tags,
      })

      return { file: file.toJSON() }
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

    return { file: file.toJSON() }
  }, { isSignIn: true })
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const file = await File.findOneAndDelete({ _id: id, orgId }).exec()
    if (!file) return status(404, { message: 'File not found' })

    return { message: 'File deleted' }
  }, { isSignIn: true })
