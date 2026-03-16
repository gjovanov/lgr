import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getContactLedger } from 'services/biz/contact-ledger.service'

export const contactLedgerController = new Elysia({ prefix: '/org/:orgId/invoicing/contact-ledger' })
  .use(AppAuthService)
  .get('/:contactId', async ({ params: { orgId, contactId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const options: Record<string, any> = {}
    if (query.dateFrom) options.dateFrom = query.dateFrom
    if (query.dateTo) options.dateTo = query.dateTo
    if (query.documentTypes) {
      options.documentTypes = (query.documentTypes as string).split(',').filter(Boolean)
    }
    options.page = Math.max(0, Number(query.page) || 0)
    options.size = query.size !== undefined ? Number(query.size) : 25

    const result = await getContactLedger(orgId, contactId, options)
    return result
  }, { isSignIn: true })
