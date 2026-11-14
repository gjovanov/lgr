import { Elysia, t } from 'elysia'
import { can } from 'services/biz/access/evaluate'
import { AuthService } from '../auth/auth.service.js'
import { orgDao } from 'services/dao/org.dao'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { orgForClient } from 'db/models'
import {
  ACTIVITY_CODE_PATTERN, MAX_ACTIVITY_CODE_LENGTH, MAX_PLACE_OF_ISSUE_LENGTH, MAX_REPRESENTATIVE_LENGTH,
  ORG_IDENTITY_FIELDS, orgIdentityUpdate,
} from 'config/party-identity'

/**
 * FR-25a: the company's activity code, or `''` to clear it. The `error` is what a rejected value is told: a union's own
 * message is TypeBox's "Expected union value", which says nothing about the code.
 */
const optionalActivityCode = t.Optional(t.Union(
  [t.Literal(''), t.String({ pattern: ACTIVITY_CODE_PATTERN, maxLength: MAX_ACTIVITY_CODE_LENGTH })],
  { error: `Expected an activity code of digits joined by dots, such as 47.52, up to ${MAX_ACTIVITY_CODE_LENGTH} characters (or leave it empty)` },
))

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
      if (!can(user, 'org-settings.edit')) return status(403, { message: 'Admin only' })

      // Each settings block sent replaces that block, and only that one. A whole `settings` in the
      // update replaced every block the page never sends — the org's time zone (the digest's days,
      // the cash register's) and the cash register's switches among them.
      // ⚠ Payroll's block goes field by field: a page that saves `payFrequency` must not take
      // `engine` with it, which would put a Bulgarian org's next run on the generic calculation.
      const { settings, ...given } = body as any
      const { payroll, ...blocks } = settings ?? {}
      // FR-25a: the company's three fields are stored trimmed, and one sent empty is cleared, so the company reads
      // exactly like one that never set it (its documents print as before). One not sent keeps what is stored.
      const identity = orgIdentityUpdate(given)
      const fields = Object.fromEntries(Object.entries(given).filter(([k]) => !(ORG_IDENTITY_FIELDS as readonly string[]).includes(k)))
      const org = await orgDao.update(orgId, {
        ...fields,
        ...identity.set,
        ...Object.fromEntries(Object.entries(blocks).map(([k, v]) => [`settings.${k}`, v])),
        ...Object.fromEntries(Object.entries(payroll ?? {}).map(([k, v]) => [`settings.payroll.${k}`, v])),
        ...(identity.unset.length ? { $unset: Object.fromEntries(identity.unset.map(f => [f, 1])) } : {}),
      })
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
        // FR-25a: the rest of what a document prints of its issuer. ⚠ Named, or `t.Object` drops it with a 200.
        // `''` clears one (see the handler); the bounds are `config/party-identity`'s, which the settings form says too.
        representative: t.Optional(t.String({ maxLength: MAX_REPRESENTATIVE_LENGTH })),
        placeOfIssue: t.Optional(t.String({ maxLength: MAX_PLACE_OF_ISSUE_LENGTH })),
        activityCode: optionalActivityCode,
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
          // The cash register: selling below zero (FR-21.16) and selling with no printer connected.
          cashRegister: t.Optional(t.Object({
            allowNegativeStock: t.Optional(t.Boolean()),
            requireConnectedDevice: t.Optional(t.Boolean()),
          })),
          payroll: t.Optional(t.Object({
            payFrequency: t.Optional(t.String()),
            // FR-25 §6.4. There is no way back through here: an org that holds sealed runs stays on it.
            engine: t.Optional(t.Literal('bg')),
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
