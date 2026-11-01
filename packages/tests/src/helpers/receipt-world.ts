import { Invoice, POSSession } from 'db/models'
import { createTestContact } from './factories'
import type { TillWorld } from './till-world'

/**
 * What the FR-23 flow tests drive: a draft as the form saves it, and the doors a person uses.
 */

/** The world's product at `quantity` × `price` net, 20 %: `taxAmount` and `lineTotal` as the form sends them. */
export function line(w: TillWorld, quantity = 2, price = 10, taxRate = 20, extra: Record<string, unknown> = {}) {
  const net = quantity * price
  return {
    productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт DIN 933 М8Х25',
    quantity, unit: 'бр.', unitPrice: price, taxRate,
    taxAmount: +(net * taxRate / 100).toFixed(2), lineTotal: +(net * (1 + taxRate / 100)).toFixed(2), ...extra,
  }
}

export const TODAY = () => new Date().toISOString().slice(0, 10)

export async function draftOf(w: TillWorld, o: { method?: string; lines?: any[]; type?: string; extra?: Record<string, unknown>; as?: string } = {}) {
  const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const lines = o.lines ?? [line(w)]
  const taxTotal = +lines.reduce((s: number, l: any) => s + l.taxAmount, 0).toFixed(2)
  const total = +lines.reduce((s: number, l: any) => s + l.lineTotal, 0).toFixed(2)
  const r = await w.call('POST', '/invoices', {
    type: o.type ?? 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: TODAY(), currency: 'EUR', lines,
    subtotal: +(total - taxTotal).toFixed(2), taxTotal, total, paymentMethod: o.method ?? 'cash', ...o.extra,
  }, undefined, o.as)
  if (r.status !== 200) throw new Error(`draft: ${r.status} ${JSON.stringify(r.json)}`)
  return { id: String(r.json.invoice.id), contactId: String(contact._id), total }
}

export const send = (w: TillWorld, id: string, key?: string, as?: string) => w.call('POST', `/invoices/${id}/send`, {}, key, as)
export const pay = (w: TillWorld, id: string, amount: number, method = 'cash', key?: string, as?: string) =>
  w.call('POST', `/invoices/${id}/payments`, { date: TODAY(), amount, method }, key, as)
export const printIt = (w: TillWorld, id: string, key?: string, as?: string) => w.call('POST', `/invoices/${id}/receipt`, {}, key, as)
export const shown = async (w: TillWorld, id: string) => (await w.call('GET', `/invoices/${id}`)).json.invoice
export const raw = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
export const receiptsOf = (id: string) => Invoice.find({ type: 'payment_receipt', 'register.paidInvoiceId': id }).sort({ _id: 1 }).lean().exec() as Promise<any[]>
export const sessionOf = (w: TillWorld) => POSSession.findById(w.sessionId).lean().exec() as Promise<any>

/** A second cashier's session on the same warehouse and device, which is normal (D-13). */
export async function clerkSession(w: TillWorld): Promise<string> {
  const r = await w.call('POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance: 0, currency: 'EUR' }, undefined, w.clerkToken)
  if (r.status !== 200) throw new Error(`clerk session: ${r.status} ${JSON.stringify(r.json)}`)
  return String(r.json.session.id ?? r.json.session._id)
}

/** A till sale in the clerk's session. */
export const clerkSale = (w: TillWorld, sessionId: string, quantity = 1, key?: string) =>
  w.call('POST', `/trade/pos/session/${sessionId}/transaction`, w.saleBody(quantity), key, w.clerkToken)

/** Wait for what a concurrent request does. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** A promise a test opens by hand: how a device is held mid-command. */
export function gate() {
  let open!: () => void
  const closed = new Promise<void>(resolve => { open = resolve })
  return { closed, open }
}
