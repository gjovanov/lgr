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

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

const PORT = 4010

// Pre-read index.html as text to avoid Bun's HTML module resolution
let indexHtml: string | null = null
try {
  indexHtml = await Bun.file('../accounting-ui/dist/index.html').text()
} catch {
  logger.info('Accounting UI dist not found, serving API only')
}

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .onError(({ code, error: err, set, request }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: err.message }
    }
    if (code === 'NOT_FOUND') {
      // SPA fallback: serve index.html for non-API, non-file paths
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
if (indexHtml) {
  try {
    app.use(
      staticPlugin({
        assets: '../accounting-ui/dist',
        prefix: '/accounting',
        indexHTML: false,
      }),
    )
  } catch {
    logger.info('Static plugin failed for Accounting UI')
  }
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Accounting running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
