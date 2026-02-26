import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { contactController } from './controllers/contact.controller.js'
import { invoiceController } from './controllers/invoice.controller.js'
import { paymentOrderController } from './controllers/payment-order.controller.js'
import { cashOrderController } from './controllers/cash-order.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const PORT = 4020

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
        return Bun.file('../invoicing-ui/dist/index.html')
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
try {
  app.use(
    staticPlugin({
      assets: '../invoicing-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for root and direct module paths (non-file routes
  // are also handled by onError NOT_FOUND above)
  const spaPaths = ['/', '/invoicing/*']
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../invoicing-ui/dist/index.html'))
  }
} catch {
  logger.info('Invoicing UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Invoicing running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
