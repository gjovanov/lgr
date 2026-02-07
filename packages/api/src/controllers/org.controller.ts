import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { orgDao } from 'services/dao/org.dao'

export const orgController = new Elysia({ prefix: '/org/:orgId' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(orgId)
    if (!org) return error(404, { message: 'Organization not found' })

    return org
  }, { isSignIn: true })
  .put(
    '/',
    async ({ params: { orgId }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return error(403, { message: 'Admin only' })

      const org = await orgDao.update(orgId, body)
      if (!org) return error(404, { message: 'Organization not found' })

      return org
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        logo: t.Optional(t.String()),
        settings: t.Optional(t.Object({
          baseCurrency: t.Optional(t.String()),
          fiscalYearStart: t.Optional(t.Number()),
          dateFormat: t.Optional(t.String()),
          timezone: t.Optional(t.String()),
          locale: t.Optional(t.String()),
          modules: t.Optional(t.Array(t.String())),
        })),
      }),
    },
  )
