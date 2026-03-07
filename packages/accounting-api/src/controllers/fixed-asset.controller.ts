import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const fixedAssetController = new Elysia({ prefix: '/org/:orgId/accounting/fixed-asset' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.fixedAssets.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { fixedAssets: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.fixedAssets.findById(params.id)
    return { fixedAsset: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.fixedAssets.create({ ...body, orgId: params.orgId } as any)
    return { fixedAsset: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.fixedAssets.update(params.id, body as any)
    return { fixedAsset: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.fixedAssets.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
