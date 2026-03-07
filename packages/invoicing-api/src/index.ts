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
import { contactController } from './controllers/contact.controller.js'
import { invoiceController } from './controllers/invoice.controller.js'
import { paymentOrderController } from './controllers/payment-order.controller.js'
import { cashOrderController } from './controllers/cash-order.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

const PORT = 4020

// Pre-read index.html as text to avoid Bun's HTML module resolution
let indexHtml: string | null = null
try {
  indexHtml = await Bun.file('../invoicing-ui/dist/index.html').text()
} catch {
  logger.info('Invoicing UI dist not found, serving API only')
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
        info: { title: 'LGR Invoicing API', version: '0.1.0', description: 'Invoicing: Contacts, Invoices, Payment Orders, Cash Orders' },
        tags: [
          { name: 'Contacts', description: 'Customer and supplier contacts' },
          { name: 'Invoices', description: 'Invoices, proformas, credit/debit notes' },
          { name: 'PaymentOrders', description: 'Payment orders' },
          { name: 'CashOrders', description: 'Cash orders' },
        ],
      },
    }),
  )

  // All Invoicing routes under /api
  .group('/api', (app) =>
    app
      .use(contactController)
      .use(invoiceController)
      .use(paymentOrderController)
      .use(cashOrderController),
  )

// Static files (Invoicing UI build)
if (indexHtml) {
  try {
    app.use(
      staticPlugin({
        assets: '../invoicing-ui/dist',
        prefix: '/invoicing',
        indexHTML: false,
      }),
    )
  } catch {
    logger.info('Static plugin failed for Invoicing UI')
  }
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Invoicing running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
