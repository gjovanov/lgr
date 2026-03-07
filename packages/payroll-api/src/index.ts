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
import { employeeController } from './controllers/employee.controller.js'
import { payrollRunController } from './controllers/run.controller.js'
import { payslipController } from './controllers/payslip.controller.js'
import { timesheetController } from './controllers/timesheet.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

const PORT = 4040

// Pre-read index.html as text to avoid Bun's HTML module resolution
let indexHtml: string | null = null
try {
  indexHtml = await Bun.file('../payroll-ui/dist/index.html').text()
} catch {
  logger.info('Payroll UI dist not found, serving API only')
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
        info: { title: 'LGR Payroll API', version: '0.1.0', description: 'Payroll: Employees, Payroll Runs, Payslips, Timesheets' },
        tags: [
          { name: 'Employees', description: 'Employee management' },
          { name: 'PayrollRuns', description: 'Payroll run processing' },
          { name: 'Payslips', description: 'Employee payslips' },
          { name: 'Timesheets', description: 'Time tracking' },
        ],
      },
    }),
  )

  // All Payroll routes under /api
  .group('/api', (app) =>
    app
      .use(employeeController)
      .use(payrollRunController)
      .use(payslipController)
      .use(timesheetController),
  )

// Static files (Payroll UI build)
if (indexHtml) {
  try {
    app.use(
      staticPlugin({
        assets: '../payroll-ui/dist',
        prefix: '/payroll',
        indexHTML: false,
      }),
    )
  } catch {
    logger.info('Static plugin failed for Payroll UI')
  }
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Payroll running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
