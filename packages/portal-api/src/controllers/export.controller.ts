import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'

export const exportController = new Elysia({ prefix: '/org/:orgId/export' })
  .use(AuthService)
  .get('/:module/excel', async ({ params: { orgId, module }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const validModules = [
      'accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp',
    ]

    if (!validModules.includes(module)) {
      return status(400, { message: `Invalid module: ${module}. Valid: ${validModules.join(', ')}` })
    }

    return {
      message: `Excel export for ${module} module - not yet implemented`,
      module,
      orgId,
      format: 'xlsx',
      filters: query,
    }
  }, { isSignIn: true })
  .get('/:module/pdf', async ({ params: { orgId, module }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const validModules = [
      'accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp',
    ]

    if (!validModules.includes(module)) {
      return status(400, { message: `Invalid module: ${module}. Valid: ${validModules.join(', ')}` })
    }

    return {
      message: `PDF export for ${module} module - not yet implemented`,
      module,
      orgId,
      format: 'pdf',
      filters: query,
    }
  }, { isSignIn: true })
