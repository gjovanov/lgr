import { cashSaleLineAmounts } from 'config/line-amounts'
import { computePosTotals } from 'config/pos-totals'
import { POSSession } from 'db/models'
import { getRepos } from 'services/context'
import { deviceTotals } from 'services/biz/cash-register/receipt-lines'
import {
  RegisterRefusal, insertRegisterDocument, originOf, runSaleSteps, settleKeyedDocument, type RegisterContext,
} from 'services/biz/cash-register/register.service'
import type { CashSaleRequest, CashSaleTill, CreateCtx } from 'services/biz/document/create-document.service'
import { statusEntry } from 'services/biz/document/document-checks'
import { refuse } from 'services/biz/document/refused'
import { syncOrderForInvoice } from 'services/biz/reservation.service'
import { upsertTags } from 'services/biz/tag.service'
import { assertJoinedSaleTender, assertOperatorFor, assertPrinterConnected, assertSaleMayOpen, noOpenSession, openSessionOf, tillContext, tillSettings } from './cash-register-till.js'

/**
 * FR-32.21 (#797): the cash-register part of `POST /invoices`, which `services/biz/document#createDocument` hands a cash
 * sale to once it is checked. It joins its author's drawer and prints on the session's device, so it stays beside the
 * till (`services` does not reach a device). Moved whole from the route.
 */

/**
 * FR-21 (D-4): a back-office cash sale is a cash-register document, written by the one service
 * that writes the till's. It brings its own work after the dispatch, the order the sale consumes, and
 * its request flags. The transfers the cash-sale form asked for (FR-21.24) go on the document.
 *
 * FR-21.31 (D-13): when its author has an open session, it joins it. The session's drawer takes the
 * money (its totals, its close JE) and, when the request asks for a receipt, the session's device
 * prints it as the till's would, as the device says (`decideSaleMode`). `tillContext` may refuse (a device in
 * error), so a joined sale's context is built before its document is.
 */
async function cashSaleContext(c: CreateCtx): Promise<RegisterContext> {
  const till = c.joined ? await tillContext(c.orgId, c.user, c.joined, { needsOperator: false }) : null
  return {
    ...(till ? { session: till.session, printer: c.receipt ? till.printer : null } : {}),
    orgId: c.orgId,
    user: c.user,
    allowNegative: c.allowNegativeStock,
    skipStock: c.skipStockMovement,
    audit: { module: 'invoicing', entityType: 'invoice' },
    afterStock: async (doc: any) => syncOrderForInvoice(c.orgId, doc, c.user.id),
  }
}

/** A cash sale's answer, or the service's refusal, as the route answers it. */
async function cashSaleAnswer(c: CreateCtx, run: () => Promise<any>) {
  try {
    const doc = await run()
    return { invoice: await getRepos().invoices.findOne({ id: String(doc._id), orgId: c.orgId }) }
  } catch (e: any) {
    if (e instanceof RegisterRefusal) return refuse(e.statusCode, e.body)
    throw e
  }
}

/** A keyed cash sale a crash interrupted: the cash-register service finishes it. */
async function resumeCashSale(existing: any, hash: string, c: CreateCtx) {
  // FR-21.31: a joined sale resumes in ITS session, with the receipt it asked for.
  const reg = existing.register || {}
  const resume: CreateCtx = reg.joinedFrom && reg.sessionId
    ? { ...c, joined: await POSSession.findOne({ _id: reg.sessionId, orgId: c.orgId }).lean().exec(), receipt: reg.fiscal?.mode }
    : c
  return cashSaleAnswer(c, () => settleKeyedDocument(existing, hash, async () => cashSaleContext(resume), runSaleSteps))
}

/**
 * A new cash sale. It keeps the route's contract — the payload, the answer, the key — and leaves by the service's
 * failure rule: no device and no drawer here, so a failure before it completes removes it.
 * ⚠ A keyed one is INSERTED under a placeholder before its CS number is drawn: a legal
 * sequence, where every losing duplicate of a racing retry would otherwise burn a number.
 */
async function createCashSale(sale: CashSaleRequest) {
  const { createCtx, body, lines, dueDate, exchangeRate, taxTotal, totalBase, pendingTransferIds, discardRequested, key, hash } = sale
  const { orgId, user } = createCtx
  const origin = originOf(body)
  // #573: each line's VAT and gross are the server's, from its terms, as the cash-sale form computes
  // them. They are what the total is shared out by per rate, on a joined sale's receipt and in the
  // VAT it books, and the request's could be anything. An imported day keeps its file's.
  const saleLines = origin === 'import' ? lines : lines.map((l: any) => ({ ...l, ...cashSaleLineAmounts(l) }))
  // FR-21.30: a cash sale entered here is totalled as the till totals one — the same function,
  // the same tolerance — and stored with the server's figures, so a joined sale's receipt
  // and its document agree to the cent. An imported day keeps the totals of its file.
  const pos = origin === 'import'
    ? null
    : computePosTotals(saleLines.map((l: any) => ({
        quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0,
        taxRate: Number(l.taxRate) || 0, discount: Number(l.discount) || 0,
      })))
  if (pos && Math.abs(pos.total - Number(body.total)) > 0.02) {
    await discardRequested()
    return refuse(422, {
      code: 'cash_sale_total_mismatch',
      message: `Total mismatch: calculated ${pos.total.toFixed(2)}, received ${Number(body.total).toFixed(2)}`,
    })
  }
  // #554: its VAT and net as the device books them, out of the gross per rate its lines give it.
  if (pos) Object.assign(pos, deviceTotals({ total: pos.total, discountTotal: pos.discountTotal, lines: saleLines }))
  // FR-21.31 (D-13): a sale entered here by someone with an open session joins it. An imported
  // till day never does: it is a day's takings, not one drawer's sale.
  createCtx.joined = origin === 'backoffice' ? await openSessionOf(orgId, user.id) : null
  const { requireConnectedDevice } = await tillSettings(orgId)
  // #492 (owner, 2026-11-08, option 2): where LGR prints, every cash sale goes through a drawer. One entered
  // here by someone with no open session is refused as a cash invoice at the counter is (FR-23 R1), before
  // anything is written. Before, it went through printing nothing, its money in no drawer. An imported till
  // day joins nothing and is not refused; where LGR prints nothing, a sale with no session is a back-office
  // document, as it always was.
  if (origin === 'backoffice' && !createCtx.joined && requireConnectedDevice) {
    const refusal = await noOpenSession(orgId, user.id, 'a cash sale prints its receipt')
    await discardRequested()
    return refuse(refusal.statusCode, refusal.body)
  }
  // ⚠ Where LGR prints, a sale that joins a drawer prints. With no `receipt` one got past the gate with the
  // device gone: 200, paid, in the drawer, and nothing on the device. An imported day joins nothing, so it
  // never comes this far, and where LGR prints nothing it still takes asking.
  createCtx.receipt = body.receipt ?? (createCtx.joined && requireConnectedDevice ? 'fiscal' : undefined)
  let context: RegisterContext
  try {
    context = await cashSaleContext(createCtx)
    // A sale that asked its session's device for a receipt is refused when nothing would
    // print it, as the till's is — before anything is written.
    if (createCtx.joined && createCtx.receipt) {
      await assertPrinterConnected(orgId, String(createCtx.joined.warehouseId), context)
      await assertOperatorFor(user, context.printer)
      assertJoinedSaleTender(body.paymentMethod || 'cash', context.printer)
      // FR-20.49 — Прил. 29 т. 8, as at the till: no receipt opens on a device not reached in two hours. A NEW
      // sale only: a keyed retry was settled above, and refusing it now would strand its receipt.
      await assertSaleMayOpen(orgId, createCtx.joined.warehouseId)
    }
  } catch (e: any) {
    if (e instanceof RegisterRefusal) {
      await discardRequested()
      return refuse(e.statusCode, e.body)
    }
    throw e
  }
  const joined = createCtx.joined
  const printer = context.printer ?? null
  const fields = {
    ...body,
    lines: saleLines,
    dueDate,
    orgId,
    direction: 'outgoing',
    status: 'paid',
    statusHistory: [statusEntry('paid', undefined, user.id, 'cash_sale_created')],
    taxTotal: pos ? pos.taxTotal : taxTotal,
    ...(pos ? { subtotal: pos.subtotal, discountTotal: pos.discountTotal, total: pos.total } : {}),
    totalBase: pos ? +(pos.total * exchangeRate).toFixed(2) : totalBase,
    billingAddress: body.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
    amountPaid: pos ? pos.total : body.total,
    amountDue: 0,
    paidAt: new Date(),
    createdBy: user.id,
    // §3.2: a PlusMinus till day (the CLI import tags it, its reference names the day) or a sale
    // entered here.
    register: {
      ...(pendingTransferIds?.length ? { transfersToConfirm: pendingTransferIds } : {}),
      ...(joined
        ? {
            // FR-21.31: the drawer's sale, as the till's are: its totals, its close JE, SUPTO, a
            // storno through a till of that session's warehouse. Its lines keep their own
            // warehouses for stock (§6 edge 14).
            origin: 'pos',
            joinedFrom: 'backoffice',
            sessionId: joined._id,
            warehouseId: joined.warehouseId,
            cashierId: user.id,
            ...(user.operatorCode ? { operatorCode: user.operatorCode } : {}),
            ...(printer ? { fiscalDeviceNumber: printer.deviceNumber } : {}),
            // Until its turn on the device, which decides (`decideSaleMode`).
            isFiscal: !!printer,
            fiscal: printer ? { state: 'pending', mode: 'fiscal' } : { state: 'none' },
            changeDue: 0,
          }
        : { origin }),
    },
    // The drawer counts payments: a joined sale sent with its header method only gets its row.
    ...(joined && !body.payments?.length
      ? { payments: [{ date: new Date(), method: body.paymentMethod || 'cash', amount: pos ? pos.total : body.total }] }
      : {}),
  }
  return cashSaleAnswer(createCtx, async () => {
    const outcome = await insertRegisterDocument(orgId, fields, key ? { key, hash: hash! } : undefined)
    // A racing duplicate of this keyed request won the insert: answer as it does.
    if ('existing' in outcome) return settleKeyedDocument(outcome.existing, hash!, async () => context, runSaleSteps)
    await upsertTags(orgId, 'invoice', body.tags)
    return runSaleSteps(context, String(outcome.inserted._id))
  })
}

/** The till `createDocument` hands a cash sale to, and a keyed one a crash interrupted. */
export function cashSaleTill(): CashSaleTill {
  return {
    create: sale => createCashSale(sale),
    resume: (existing, hash, c) => resumeCashSale(existing, hash, c),
  }
}
