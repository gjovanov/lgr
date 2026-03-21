import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import {
  exportSummarizedSales,
  exportPaymentDetails,
  exportItemizedSales,
  exportReversedSales,
  exportCancelledSales,
  exportDeliverySummary,
  exportDeliveryDetails,
  exportStockMovementSummary,
  exportNomenclature,
} from 'services/biz/supto-export.service'
import {
  generateTable181,
  generateTable182,
  generateTable183,
  generateTable184,
  generateTable185,
  generateTable186,
  generateTable187,
  generateTable188,
  generateTable189,
} from 'reporting/excel/supto.excel'

const ALLOWED_ROLES = ['admin', 'nra_auditor']

const TABLE_DESCRIPTIONS: Record<string, string> = {
  '18.1': 'Summarized Sales',
  '18.2': 'Payment Details',
  '18.3': 'Itemized Sales',
  '18.4': 'Reversed (Storno) Sales',
  '18.5': 'Cancelled Sales',
  '18.6': 'Delivery Summary',
  '18.7': 'Delivery Details',
  '18.8': 'Stock Movement Summary',
  '18.9': 'Nomenclature Tables',
}

export const suptoExportController = new Elysia({ prefix: '/org/:orgId/supto/export' })
  .use(AuthService)
  // List available tables
  .get('/tables', async ({ user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!ALLOWED_ROLES.includes(user.role)) return status(403, { message: 'Admin or NRA auditor required' })

    return {
      tables: Object.entries(TABLE_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
    }
  }, { isSignIn: true })
  // Export a specific table
  .get('/:tableId', async ({ params: { orgId, tableId }, query, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!ALLOWED_ROLES.includes(user.role)) return status(403, { message: 'Admin or NRA auditor required' })

    if (!TABLE_DESCRIPTIONS[tableId]) {
      return status(400, { message: `Invalid table: ${tableId}. Valid: ${Object.keys(TABLE_DESCRIPTIONS).join(', ')}` })
    }

    // Period is required for tables 18.1-18.8
    if (tableId !== '18.9' && (!query.dateFrom || !query.dateTo)) {
      return status(400, { message: 'dateFrom and dateTo query parameters are required' })
    }

    const filters = {
      orgId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom as string) : new Date(),
      dateTo: query.dateTo ? new Date(query.dateTo as string) : new Date(),
      warehouseId: query.warehouseId as string | undefined,
      fiscalDeviceNumber: query.fiscalDeviceNumber as string | undefined,
      workstationId: query.workstationId as string | undefined,
      operatorCode: query.operatorCode as string | undefined,
    }

    let buffer: Buffer

    switch (tableId) {
      case '18.1': {
        const { transactions, cashSales } = await exportSummarizedSales(filters)
        buffer = await generateTable181(transactions, cashSales)
        break
      }
      case '18.2': {
        const transactions = await exportPaymentDetails(filters)
        buffer = await generateTable182(transactions)
        break
      }
      case '18.3': {
        const transactions = await exportItemizedSales(filters)
        buffer = await generateTable183(transactions)
        break
      }
      case '18.4': {
        const transactions = await exportReversedSales(filters)
        buffer = await generateTable184(transactions)
        break
      }
      case '18.5': {
        const transactions = await exportCancelledSales(filters)
        buffer = await generateTable185(transactions)
        break
      }
      case '18.6': {
        const { movements, contactMap } = await exportDeliverySummary(filters)
        buffer = await generateTable186(movements, contactMap)
        break
      }
      case '18.7': {
        const { movements, productMap } = await exportDeliveryDetails(filters)
        buffer = await generateTable187(movements, productMap)
        break
      }
      case '18.8': {
        const { stockLevels, movements, productMap } = await exportStockMovementSummary(filters)
        buffer = await generateTable188(stockLevels, movements, productMap)
        break
      }
      case '18.9': {
        const data = await exportNomenclature(orgId)
        buffer = await generateTable189(data)
        break
      }
      default:
        return status(400, { message: 'Invalid table ID' })
    }

    const filename = `supto-${tableId}-${filters.dateFrom.toISOString().split('T')[0]}-${filters.dateTo.toISOString().split('T')[0]}.xlsx`

    set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    set.headers['content-disposition'] = `attachment; filename="${filename}"`

    return buffer
  }, { isSignIn: true })
