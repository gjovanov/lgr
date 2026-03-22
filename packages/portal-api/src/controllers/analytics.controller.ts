import { Elysia } from 'elysia'
import { config } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { proxyRequest } from 'services/biz/proxy.service'

export const analyticsController = new Elysia({ prefix: '/org/:orgId/analytics' })
  .use(AuthService)

  // Active users (proxied from Purestat)
  .get('/active-users', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin' && user.role !== 'owner') {
      return status(403, { message: 'Admin access required' })
    }

    const purestat = config.externalIntegrations?.purestat
    if (!purestat?.enabled) {
      return status(503, { message: 'Analytics not enabled' })
    }

    const result = await proxyRequest({
      targetUrl: purestat.url,
      method: 'GET',
      path: `/api/v1/stats/realtime/visitors?site_id=${purestat.siteId}`,
      headers: {
        Authorization: `Bearer ${purestat.apiKey}`,
      },
    })

    return status(result.status, result.body)
  }, { isSignIn: true })

  // Aggregate stats (proxied from Purestat)
  .get('/stats', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin' && user.role !== 'owner') {
      return status(403, { message: 'Admin access required' })
    }

    const purestat = config.externalIntegrations?.purestat
    if (!purestat?.enabled) {
      return status(503, { message: 'Analytics not enabled' })
    }

    const period = query.period || '30d'
    const result = await proxyRequest({
      targetUrl: purestat.url,
      method: 'GET',
      path: `/api/v1/stats/aggregate?site_id=${purestat.siteId}&period=${period}`,
      headers: {
        Authorization: `Bearer ${purestat.apiKey}`,
      },
    })

    return status(result.status, result.body)
  }, { isSignIn: true })
