import { Elysia } from 'elysia'
import cors from '@elysiajs/cors'
import swagger from '@elysiajs/swagger'
import staticPlugin from '@elysiajs/static'
import { config } from 'config'
import { connectDB } from 'db/connection'
import { logger } from 'services/logger'

// Controllers
import { productController } from './controllers/product.controller.js'
import { warehouseController } from './controllers/warehouse.controller.js'
import { movementController } from './controllers/movement.controller.js'
import { stockLevelController } from './controllers/stock-level.controller.js'
import { inventoryCountController } from './controllers/inventory-count.controller.js'
import { priceListController } from './controllers/price-list.controller.js'

await connectDB()
logger.info('Connected to MongoDB')

const PORT = 4030

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
        return Bun.file('../warehouse-ui/dist/index.html')
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
        info: { title: 'LGR Warehouse API', version: '0.1.0', description: 'Warehouse: Products, Stock Levels, Movements, Inventory' },
        tags: [
          { name: 'Products', description: 'Product catalog' },
          { name: 'Warehouses', description: 'Warehouse locations' },
          { name: 'Stock', description: 'Stock levels' },
          { name: 'Movements', description: 'Stock movements' },
          { name: 'Inventory', description: 'Inventory counts' },
          { name: 'PriceLists', description: 'Price lists' },
        ],
      },
    }),
  )

  // All Warehouse routes under /api
  .group('/api', (app) =>
    app
      .use(productController)
      .use(warehouseController)
      .use(movementController)
      .use(stockLevelController)
      .use(inventoryCountController)
      .use(priceListController),
  )

// Static files (Warehouse UI build)
try {
  app.use(
    staticPlugin({
      assets: '../warehouse-ui/dist',
      prefix: '',
    }),
  )

  // SPA fallback for root and direct module paths (non-file routes
  // are also handled by onError NOT_FOUND above)
  const spaPaths = ['/', '/warehouse/*']
  for (const path of spaPaths) {
    app.get(path, () => Bun.file('../warehouse-ui/dist/index.html'))
  }
} catch {
  logger.info('Warehouse UI dist not found, serving API only')
}

app.listen({ hostname: config.host, port: PORT })

logger.info(`LGR Warehouse running at http://${config.host}:${PORT}`)
logger.info(`Swagger docs at http://${config.host}:${PORT}/swagger`)

export type App = typeof app
