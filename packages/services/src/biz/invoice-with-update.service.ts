import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { DuplicateError } from 'dal'
import { GRValidationError, sanitizeProductUpdates, applyProductUpdates, type ProductUpdateInput } from './product-update.service.js'

/**
 * Atomically create a purchase bill AND apply inline product-master updates.
 * Mirror of createMovementWithProductUpdates: one Mongo transaction (requires replica set),
 * full rollback on any failure. Never touches stock — bills move stock only via /receive.
 *
 * The caller passes the fully-computed invoice document (numbering, statusHistory, totals);
 * number allocation and the duplicate-retry loop stay in the controller.
 */
export async function createInvoiceWithProductUpdates(
  invoiceDoc: Record<string, any>,
  productUpdates: ProductUpdateInput[],
): Promise<{ invoiceId: string; updatedProductIds: string[] }> {
  const allowedProductIds = new Set<string>(
    (invoiceDoc.lines || []).filter((l: any) => l?.productId).map((l: any) => String(l.productId)),
  )
  const safeUpdates = sanitizeProductUpdates(productUpdates, allowedProductIds, 'invoice')

  const session = await mongoose.startSession()
  let invoiceId: string | null = null
  let updatedProductIds: string[] = []

  try {
    await session.withTransaction(async () => {
      updatedProductIds = await applyProductUpdates(session, String(invoiceDoc.orgId), safeUpdates)
      const doc = new Invoice(invoiceDoc)
      await doc.save({ session })
      invoiceId = String(doc._id)
    })
  } catch (e: any) {
    // Normalise Mongo 11000 to the DAL DuplicateError so the controller's
    // allocate-number retry loop treats both create paths identically.
    if (e?.code === 11000) throw new DuplicateError('Invoice', e.keyValue || { invoiceNumber: invoiceDoc.invoiceNumber })
    throw e
  } finally {
    await session.endSession()
  }

  if (!invoiceId) throw new Error('Transaction did not produce an invoice id')
  return { invoiceId, updatedProductIds }
}

/**
 * Atomically apply a bill edit ($set) AND inline product-master updates.
 *
 * ⚠ No status or posting check, matching the plain PUT path: a bill is editable in every
 * status, including after a JournalEntry has been posted against it. That JE is NOT updated
 * here, so the ledger keeps the pre-edit amounts — see the note in `invoice.controller.ts`'s
 * PUT handler for the full consequence and why it was chosen.
 */
export async function updateInvoiceWithProductUpdates(params: {
  orgId: string
  invoiceId: string
  update: Record<string, any>
  productUpdates: ProductUpdateInput[]
}): Promise<{ updatedProductIds: string[] }> {
  const { orgId, invoiceId, update, productUpdates } = params

  const existing: any = await Invoice.findOne({ _id: invoiceId, orgId } as any).lean()
  if (!existing) throw new GRValidationError('Invoice not found')

  const lines: any[] = (update.lines ?? existing.lines ?? []) as any[]
  const allowedProductIds = new Set<string>(lines.filter(l => l?.productId).map(l => String(l.productId)))
  const safeUpdates = sanitizeProductUpdates(productUpdates, allowedProductIds, 'invoice')

  const session = await mongoose.startSession()
  let updatedProductIds: string[] = []

  try {
    await session.withTransaction(async () => {
      updatedProductIds = await applyProductUpdates(session, orgId, safeUpdates)
      await Invoice.findOneAndUpdate({ _id: invoiceId, orgId } as any, { $set: update }, { new: true, session })
    })
  } finally {
    await session.endSession()
  }

  return { updatedProductIds }
}
