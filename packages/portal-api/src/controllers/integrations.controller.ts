import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { config } from 'config'
import { syncTimesheets } from 'services/biz/tickytack.service'
import { proxyRequest } from 'services/biz/proxy.service'

export const integrationsController = new Elysia({ prefix: '/org/:orgId/integrations' })
  .use(AuthService)

  // TickyTack timesheet sync
  .post('/tickytack/sync', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings')) return status(403, { message: 'Admin only' })
    if (!config.externalIntegrations?.tickytack?.enabled) return status(503, { message: 'TickyTack not enabled' })

    const result = await syncTimesheets(orgId, body.startDate, body.endDate)
    return result
  }, {
    isSignIn: true,
    body: t.Object({
      startDate: t.String(),
      endDate: t.String(),
    }),
  })

  // TickyTack proxy (for embedding calendar)
  .all('/tickytack/*', async ({ request, params, user, set }) => {
    if (!user) { set.status = 401; return { message: 'Unauthorized' } }
    if (!config.externalIntegrations?.tickytack?.enabled) { set.status = 503; return { message: 'TickyTack not enabled' } }

    const url = new URL(request.url)
    const targetPath = url.pathname.replace(`/api/org/${params.orgId}/integrations/tickytack`, '/api')

    const result = await proxyRequest({
      targetUrl: config.externalIntegrations.tickytack.url,
      method: request.method,
      path: targetPath + url.search,
      headers: {
        'Authorization': request.headers.get('authorization') || '',
        'Content-Type': request.headers.get('content-type') || 'application/json',
      },
      body: ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.text() : undefined,
    })

    set.status = result.status
    return result.body
  }, { isSignIn: true })

  // Analytics proxy (Purestat)
  .get('/analytics/active-users', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings')) return status(403, { message: 'Forbidden' })
    if (!config.externalIntegrations?.purestat?.enabled) return status(503, { message: 'Analytics not enabled' })

    const result = await proxyRequest({
      targetUrl: config.externalIntegrations.purestat.url,
      method: 'GET',
      path: `/api/sites/${config.externalIntegrations.purestat.siteId}/realtime`,
      headers: { 'X-API-Key': config.externalIntegrations.purestat.apiKey || '' },
    })
    return result.body
  }, { isSignIn: true })
