import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { accountController } from './controllers/account.controller.js'
import { journalController } from './controllers/journal.controller.js'
import { fiscalYearController } from './controllers/fiscal-year.controller.js'
import { fiscalPeriodController } from './controllers/fiscal-period.controller.js'
import { fixedAssetController } from './controllers/fixed-asset.controller.js'
import { bankAccountController } from './controllers/bank-account.controller.js'
import { reconciliationController } from './controllers/reconciliation.controller.js'
import { taxReturnController } from './controllers/tax-return.controller.js'
import { exchangeRateController } from './controllers/exchange-rate.controller.js'
import { reportController } from './controllers/report.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const PORT = 4010

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
        info: { title: 'LGR Accounting API', version: '0.1.0', description: 'Accounting: Chart of Accounts, Journal Entries, Financial Reports' },
        tags: [
          { name: 'Accounts', description: 'Chart of accounts' },
          { name: 'Journal', description: 'Journal entries' },
          { name: 'Fiscal', description: 'Fiscal years & periods' },
          { name: 'Assets', description: 'Fixed assets' },
          { name: 'Banking', description: 'Bank accounts & reconciliation' },
          { name: 'Tax', description: 'Tax returns' },
          { name: 'Exchange', description: 'Exchange rates' },
          { name: 'Reports', description: 'Financial reports' },
        ],
      },
    }),
  )

  // All Accounting routes under /api
  .group('/api', (app) =>
    app
      .use(accountController)
      .use(journalController)
      .use(fiscalYearController)
      .use(fiscalPeriodController)
      .use(fixedAssetController)
      .use(bankAccountController)
      .use(reconciliationController)
      .use(taxReturnController)
      .use(exchangeRateController)
      .use(reportController),
  )

// Static files (Accounting UI build)
try {
  app.use(
    staticPlugin({
      assets: '../accounting-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for accounting routes
  const spaPaths = [
    '/',
    '/accounting/*',
  ]
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../accounting-ui/dist/index.html'))
  }
} catch {
  logger.info('Accounting UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Accounting running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
