import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getProductSupply } from 'services/biz/product-supply.service'
import { Product } from 'db/models'
import { holdsArea } from 'config/constants'

/**
 * #203: what the product page's „Наличност" tab shows besides the shelf — the holds, the goods on
 * their way on outgoing orders, and how much of those clients already have. Read by the inventory
 * app too (`route-permission.ts`: `invoicing/product-supply`).
 */
export const productSupplyController = new Elysia({ prefix: '/org/:orgId/invoicing/product-supply' })
  .use(AppAuthService)
  .get('/:productId', async ({ params: { orgId, productId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const product = await Product.exists({ _id: productId, orgId } as any).exec()
    if (!product) return status(404, { message: 'Product not found' })
    const supply = await getProductSupply(orgId, productId)
    // FR-26.6: without `orders` the quantities stay, and no order or reservation is named.
    if (!holdsArea(user, 'orders')) return { supply: { warehouses: supply.warehouses, incoming: [], reservations: [] } }
    return { supply }
  }, { isSignIn: true })
