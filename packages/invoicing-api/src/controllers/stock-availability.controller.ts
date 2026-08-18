import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { checkCrossWarehouseAvailability, createTransferMovements } from 'services/biz/stock-transfer.service'

export const stockAvailabilityController = new Elysia({ prefix: '/org/:orgId/invoicing/stock-availability' })
  .use(AppAuthService)
  .post(
    '/check',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      return checkCrossWarehouseAvailability(orgId, body.lines)
    },
    {
      isSignIn: true,
      body: t.Object({
        lines: t.Array(t.Object({
          productId: t.String(),
          warehouseId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          // Reservation-backed lines consume their own hold — exempted (capped at the
          // reservation's open quantity) instead of reported as a false shortfall.
          reservationId: t.Optional(t.String()),
        })),
      }),
    },
  )
  .post(
    '/create-transfers',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const transferIds = await createTransferMovements(orgId, body.proposals, user.id)
      return { transferIds }
    },
    {
      isSignIn: true,
      body: t.Object({
        proposals: t.Array(t.Any()),
      }),
    },
  )
