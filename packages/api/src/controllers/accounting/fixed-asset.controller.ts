import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { fixedAssetDao } from 'services/dao/accounting/fixed-asset.dao'
import { FixedAsset } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const fixedAssetController = new Elysia({ prefix: '/org/:orgId/accounting/fixed-asset' })
  .use(AuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(FixedAsset, filter, query)
    return { fixedAssets: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await fixedAssetDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await fixedAssetDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await fixedAssetDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await fixedAssetDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
