import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

/**
 * Stats endpoints for smart buttons — returns all counts in a single response per entity.
 * Avoids N+1: one API call instead of 4-5 separate count queries from the frontend.
 */
export const statsController = new Elysia({ prefix: '/org/:orgId/stats' })
  .use(AppAuthService)

  // Invoice stats: journal entries, movements, payments
  .get('/invoice/:id', async ({ params }) => {
    const r = getRepos()
    const invoice = await r.invoices.findByIdInOrg(params.id, params.orgId) as any
    if (!invoice) return { stats: {} }

    const payments = invoice.payments || []
    const totalPaid = payments.reduce((s: number, p: any) => s + (p.amount || 0), 0)
    const transferIds = invoice.pendingTransferIds || []

    return {
      stats: {
        hasJournalEntry: !!invoice.journalEntryId,
        journalEntryId: invoice.journalEntryId || null,
        paymentCount: payments.length,
        totalPaid,
        deliveryCount: transferIds.length,
        transferIds,
      },
    }
  }, { isSignIn: true })

  // Product stats: on-hand qty, movement count, invoice count
  .get('/product/:id', async ({ params }) => {
    const r = getRepos()
    const { orgId, id: productId } = params

    // Batch: 3 parallel queries
    const [stockLevelsResult, movementCount, invoiceCount] = await Promise.all([
      r.stockLevels.findAll({ orgId, productId } as any, { page: 0, size: 1000 }),
      r.stockMovements.count({ orgId, 'lines.productId': productId } as any),
      r.invoices.count({ orgId, 'lines.productId': productId } as any),
    ])

    const totalOnHand = stockLevelsResult.items.reduce((s: number, sl: any) => s + (sl.quantity || 0), 0)
    const totalAvailable = stockLevelsResult.items.reduce((s: number, sl: any) => s + (sl.availableQuantity || 0), 0)

    return {
      stats: {
        onHand: totalOnHand,
        available: totalAvailable,
        movementCount,
        invoiceCount,
      },
    }
  }, { isSignIn: true })

  // Contact stats: invoice count, open balance, movement count
  .get('/contact/:id', async ({ params }) => {
    const r = getRepos()
    const { orgId, id: contactId } = params

    // Batch: 3 parallel queries
    const [invoiceResult, movementCount] = await Promise.all([
      r.invoices.findAll({ orgId, contactId } as any, { page: 0, size: 10000 }),
      r.stockMovements.count({ orgId, contactId } as any),
    ])

    const invoiceCount = invoiceResult.total
    const openBalance = invoiceResult.items.reduce((s: number, inv: any) => {
      if (['draft', 'sent', 'partially_paid', 'overdue'].includes(inv.status)) {
        return s + (inv.amountDue || inv.total || 0)
      }
      return s
    }, 0)

    return {
      stats: {
        invoiceCount,
        openBalance: Math.round(openBalance * 100) / 100,
        movementCount,
      },
    }
  }, { isSignIn: true })
