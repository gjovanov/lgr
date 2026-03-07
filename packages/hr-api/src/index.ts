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
import { departmentController } from './controllers/department.controller.js'
import { leaveController } from './controllers/leave.controller.js'
import { leaveTypeController } from './controllers/leave-type.controller.js'
import { leaveBalanceController } from './controllers/leave-balance.controller.js'
import { businessTripController } from './controllers/business-trip.controller.js'
import { employeeDocumentController } from './controllers/employee-document.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const repos = await createMongoRepositories({ backend: 'mongo' })
initServiceContext(repos)

const PORT = 4050

// Pre-read index.html as text to avoid Bun's HTML module resolution
let indexHtml: string | null = null
try {
  indexHtml = await Bun.file('../hr-ui/dist/index.html').text()
} catch {
  logger.info('HR UI dist not found, serving API only')
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
        info: { title: 'LGR HR API', version: '0.1.0', description: 'HR: Departments, Leave Management, Business Trips, Documents' },
        tags: [
          { name: 'Departments', description: 'Department management' },
          { name: 'Leave', description: 'Leave requests' },
          { name: 'LeaveTypes', description: 'Leave type configuration' },
          { name: 'LeaveBalances', description: 'Leave balance tracking' },
          { name: 'BusinessTrips', description: 'Business trip management' },
          { name: 'Documents', description: 'Employee documents' },
        ],
      },
    }),
  )

  // All HR routes under /api
  .group('/api', (app) =>
    app
      .use(departmentController)
      .use(leaveController)
      .use(leaveTypeController)
      .use(leaveBalanceController)
      .use(businessTripController)
      .use(employeeDocumentController),
  )

// Static files (HR UI build)
if (indexHtml) {
  try {
    app.use(
      staticPlugin({
        assets: '../hr-ui/dist',
        prefix: '/hr',
        indexHTML: false,
      }),
    )
  } catch {
    logger.info('Static plugin failed for HR UI')
  }
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR HR running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
