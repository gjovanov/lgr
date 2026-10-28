import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { orgDao } from 'services/dao/org.dao'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { orgForClient } from 'db/models'

export const orgController = new Elysia({ prefix: '/org/:orgId' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(orgId)
    if (!org) return status(404, { message: 'Organization not found' })

    return { org: orgForClient(org.toJSON()) }
  }, { isSignIn: true })
  .put(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const org = await orgDao.update(orgId, body)
      if (!org) return status(404, { message: 'Organization not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'admin', entityType: 'organization', entityId: orgId, entityName: org.name })

      return { org: orgForClient(org.toJSON()) }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        logo: t.Optional(t.String()),
        taxNumber: t.Optional(t.String()),
        vatNumber: t.Optional(t.String()),
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        website: t.Optional(t.String()),
        addresses: t.Optional(t.Array(t.Object({
          type: t.String(),
          street: t.String(),
          city: t.String(),
          state: t.Optional(t.String()),
          postalCode: t.String(),
          country: t.String(),
          isDefault: t.Optional(t.Boolean()),
        }))),
        bankDetails: t.Optional(t.Array(t.Object({
          bankName: t.String(),
          accountNumber: t.Optional(t.String()),
          iban: t.Optional(t.String()),
          swift: t.Optional(t.String()),
          currency: t.Optional(t.String()),
          isDefault: t.Optional(t.Boolean()),
        }))),
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
          // FR-11.1 (#21). This whitelist is load-bearing: a settings key that is not
          // listed here is silently STRIPPED by Elysia, and the save appears to succeed.
          dailyDigest: t.Optional(t.Object({
            enabled: t.Optional(t.Boolean()),
            hour: t.Optional(t.Number()),
            recipients: t.Optional(t.Array(t.Object({ userId: t.String() }))),
            sections: t.Optional(t.Record(t.String(), t.Boolean())),
            locale: t.Optional(t.String()),
          })),
        })),
      }),
    },
  )
