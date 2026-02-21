import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { employeeController } from './controllers/employee.controller.js'
import { payrollRunController } from './controllers/run.controller.js'
import { payslipController } from './controllers/payslip.controller.js'
import { timesheetController } from './controllers/timesheet.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const PORT = 4040

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
try {
  app.use(
    staticPlugin({
      assets: '../payroll-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for payroll routes
  const spaPaths = [
    '/',
    '/payroll/*',
  ]
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../payroll-ui/dist/index.html'))
  }
} catch {
  logger.info('Payroll UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Payroll running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
