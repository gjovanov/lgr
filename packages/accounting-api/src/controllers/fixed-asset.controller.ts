import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { fixedAssetDao } from 'services/dao/accounting/fixed-asset.dao'

export const fixedAssetController = new Elysia({ prefix: '/org/:orgId/accounting/fixed-asset' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await fixedAssetDao.findByOrgId(params.orgId)
    return { fixedAssets: items }
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
