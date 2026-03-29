import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { orgDao } from 'services/dao/org.dao'
import { createAuditEntry } from 'services/biz/audit-log.service'

export const orgController = new Elysia({ prefix: '/org/:orgId' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(orgId)
    if (!org) return status(404, { message: 'Organization not found' })

    return { org: org.toJSON() }
  }, { isSignIn: true })
  .put(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const org = await orgDao.update(orgId, body)
      if (!org) return status(404, { message: 'Organization not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'admin', entityType: 'organization', entityId: orgId, entityName: org.name })

      return { org: org.toJSON() }
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
          taxConfig: t.Optional(t.Object({
            vatEnabled: t.Optional(t.Boolean()),
            defaultVatRate: t.Optional(t.Number()),
            vatRates: t.Optional(t.Array(t.Object({
              name: t.String(),
              rate: t.Number(),
              default: t.Optional(t.Boolean()),
            }))),
            taxIdLabel: t.Optional(t.String()),
          })),
          inventory: t.Optional(t.Object({
            defaultCostingMethod: t.Optional(t.String()),
            allowNegativeStock: t.Optional(t.Boolean()),
          })),
          payroll: t.Optional(t.Object({
            payFrequency: t.Optional(t.String()),
          })),
        })),
      }),
    },
  )
