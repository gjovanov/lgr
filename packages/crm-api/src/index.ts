import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { leadController } from './controllers/lead.controller.js'
import { dealController } from './controllers/deal.controller.js'
import { pipelineController } from './controllers/pipeline.controller.js'
import { activityController } from './controllers/activity.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const PORT = 4060

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set, request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      // SPA fallback: serve index.html for non-API, non-file paths
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/') && !url.pathname.match(/\.\w{2,}$/)) {
        set.status = 200
        return Bun.file('../crm-ui/dist/index.html')
      }
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
        info: { title: 'LGR CRM API', version: '0.1.0', description: 'CRM: Leads, Deals, Pipelines, Activities' },
        tags: [
          { name: 'Leads', description: 'Lead management' },
          { name: 'Deals', description: 'Deal management' },
          { name: 'Pipelines', description: 'Pipeline management' },
          { name: 'Activities', description: 'Activity management' },
        ],
      },
    }),
  )

  // All CRM routes under /api
  .group('/api', (app) =>
    app
      .use(leadController)
      .use(dealController)
      .use(pipelineController)
      .use(activityController),
  )

// Static files (CRM UI build)
try {
  app.use(
    staticPlugin({
      assets: '../crm-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for root and direct module paths (non-file routes
  // are also handled by onError NOT_FOUND above)
  const spaPaths = ['/', '/crm/*']
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../crm-ui/dist/index.html'))
  }
} catch {
  logger.info('CRM UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR CRM running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
