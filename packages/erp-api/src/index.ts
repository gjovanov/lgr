import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { initServiceContext } from 'services/context'
import { createMongoRepositories } from 'dal-mongo'
import { logger } from 'services/logger'

// Controllers
import { bomController } from './controllers/production.controller.js'
import { productionOrderController } from './controllers/production.controller.js'
import { constructionController } from './controllers/construction.controller.js'
import { posController } from './controllers/pos.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

const PORT = 4070

// Pre-read index.html as text to avoid Bun's HTML module resolution
let indexHtml: string | null = null
try {
  indexHtml = await Bun.file('../erp-ui/dist/index.html').text()
} catch {
  logger.info('ERP UI dist not found, serving API only')
}

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set, request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      if (indexHtml) {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/api/') && !url.pathname.match(/\.\w{2,}$/)) {
          set.status = 200
          set.headers['content-type'] = 'text/html; charset=utf-8'
          return indexHtml
        }
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
        info: { title: 'LGR ERP API', version: '0.1.0', description: 'ERP: Bill of Materials, Production Orders, Construction Projects, Point of Sale' },
        tags: [
          { name: 'BOM', description: 'Bill of Materials' },
          { name: 'Production', description: 'Production orders' },
          { name: 'Construction', description: 'Construction projects' },
          { name: 'POS', description: 'Point of Sale' },
        ],
      },
    }),
  )

  // All ERP routes under /api
  .group('/api', (app) =>
    app
      .use(bomController)
      .use(productionOrderController)
      .use(constructionController)
      .use(posController),
  )

// Static files (ERP UI build)
if (indexHtml) {
  try {
    app.use(
      staticPlugin({
        assets: '../erp-ui/dist',
        prefix: '/erp',
        indexHTML: false,
      }),
    )
  } catch {
    logger.info('Static plugin failed for ERP UI')
  }
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR ERP running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
