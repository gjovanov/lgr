import { Elysia } from 'elysia'
import { Org } from 'db/models'

export const tenantMiddleware = new Elysia({ name: 'Middleware.Tenant' })
  .derive({ as: 'scoped' }, async ({ params, status }) => {
    const orgId = (params as any)?.orgId
    if (!orgId) return { org: null }

    const org = await Org.findById(orgId)
    if (!org) return status(404, { message: 'Organization not found' })

    return { org }
  })
