import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { authController } from './controllers/auth.controller.js'
import { oauthController } from './controllers/oauth.controller.js'
import { inviteController } from './controllers/invite.controller.js'
import { stripeController } from './controllers/stripe.controller.js'
import { orgController } from './controllers/org.controller.js'
import { userController } from './controllers/user.controller.js'
import { fileController } from './controllers/file.controller.js'
import { exportController } from './controllers/export.controller.js'
import { notificationController } from './controllers/notification.controller.js'
import { appHubController } from './controllers/app-hub.controller.js'

// WebSocket
import { setupWebSocket } from './websocket/ws.server.js'

await connectDB()
logger.info('Connected to MongoDB')

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      set.status = 404
      return { message: 'Not found' }
    }
    logger.error(err)
    set.status = 500
    return { message: err.message || 'Internal server error' }
  })
  .use(
    swagger({
      documentation: {
        info: { title: 'LGR Portal API', version: '0.1.0', description: 'Portal: Auth, Tenant, App Hub' },
        tags: [
          { name: 'Auth', description: 'Authentication & OAuth' },
          { name: 'Org', description: 'Organization management' },
          { name: 'Users', description: 'User management' },
          { name: 'Invites', description: 'Invitation management' },
          { name: 'Apps', description: 'App Hub — activate/deactivate apps' },
          { name: 'Billing', description: 'Stripe subscription & billing' },
          { name: 'Files', description: 'File management' },
          { name: 'Notifications', description: 'User notifications' },
        ],
      },
    }),
  )

  // All Portal routes under /api
  .group('/api', (app) =>
    app
      .use(authController)
      .use(oauthController)
      .use(inviteController)
      .use(stripeController)
      .use(orgController)
      .use(userController)
      .use(fileController)
      .use(exportController)
      .use(notificationController)
      .use(appHubController),
  )

// WebSocket
setupWebSocket(app as any)

// Static files (Portal UI build)
try {
  app.use(
    staticPlugin({
      assets: '../portal-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for Portal routes
  const spaPaths = [
    '/',
    '/landing',
    '/dashboard',
    '/apps',
    '/settings/*',
    '/admin/*',
    '/auth/*',
    '/invite/*',
    '/privacy',
    '/terms',
  ]
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../portal-ui/dist/index.html'))
  }
} catch {
  logger.info('Portal UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: config.port })

logger.info(`LGR Portal running at http://${config.host}:${config.port}`)
logger.info(`Swagger docs at http://${config.host}:${config.port}/swagger`)

export type App = typeof app
