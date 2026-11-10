import { mongoose } from 'db/connection'
import { Contact, InternalOrder, Order, Org, Product, StockLevel, Warehouse } from 'db/models'
import { reorderPosition, suggestedOrderQuantity } from 'config/reorder-quantity'
import { getRepos } from '../context.js'
import type { AccessCaller } from './access/evaluate.js'
import { createAuditEntry } from './audit-log.service.js'
import { addLineToSupplierGroup } from './order-builder.js'
import { getNextInternalOrderNumber, getNextOrderNumber } from './order-numbering.js'
import { productIdsMatching } from './product-list-filter.js'
import { resolveProductListFilter, type ProductListQuery } from './product-list-query.js'
import { getProductsSupplyTotals } from './product-supply.service.js'
import { getRecordedSupplierNames } from './recorded-suppliers.service.js'
import {
  SUPPLIER_FACTS_PER_PRODUCT,
  canSeeSupplierFacts,
  canSeeSupplierPrices,
  getDefaultSuppliers,
  getSupplierFacts,
} from './product-suppliers.service.js'

const { Types } = mongoose

/**
 * FR-28.16 to .18 — orders from the Products list: a preview with server-computed defaults, and the two creates
 * (one DRAFT supplier order, one DRAFT customer order). Nothing here sends, confirms or reserves anything.
 *
 * Every id in a request is checked against the organization of the route: a product, supplier, client or warehouse of
 * ANOTHER organization is "not found", exactly as one that does not exist (nothing says it exists elsewhere).
 */

/** D-12: the most articles an action works on. */
export const MAX_ORDER_ITEMS = 500
const OBJECT_ID = /^[0-9a-f]{24}$/i
const MAX_REQUEST_ID = 100

export class OrdersFromProductsError extends Error {
  constructor(public statusCode: number, message: string, public details: { code: string } & Record<string, unknown>) {
    super(message)
  }
}

export interface SkippedItem {
  productId: string
  reason: string
}

const idStr = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => Number(v) || 0
const nameOfContact = (c: any): string => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''

async function baseCurrencyOf(orgId: string): Promise<string> {
  const org: any = await Org.findOne({ _id: orgId } as any, { 'settings.baseCurrency': 1 }).lean().exec()
  return org?.settings?.baseCurrency || 'EUR'
}

/** The warehouse a row's allocation goes to unless the dialog says otherwise: the chosen one, else the organization's default. */
async function defaultWarehouseId(orgId: string, chosen?: string): Promise<string | undefined> {
  if (chosen) {
    const wh: any = OBJECT_ID.test(chosen) ? await Warehouse.findOne({ _id: chosen, orgId } as any, { _id: 1 }).lean().exec() : null
    if (!wh) throw new OrdersFromProductsError(422, 'Warehouse not found', { code: 'warehouse_not_found' })
    return String(wh._id)
  }
  const dflt: any = await Warehouse.findOne({ orgId, isDefault: true, isActive: { $ne: false } } as any, { _id: 1 }).lean().exec()
  if (dflt) return String(dflt._id)
  const first: any = await Warehouse.findOne({ orgId, isActive: { $ne: false } } as any, { _id: 1 }).sort({ createdAt: 1, _id: 1 }).lean().exec()
  return first ? String(first._id) : undefined
}

// ── the preview ─────────────────────────────────────────────────────────────────────────────────────

export interface PreviewInput {
  /** The articles ticked on the list. */
  productIds?: string[]
  /** "All that match": the list's own query (`GET /warehouse/product`), resolved with the list's own builder. */
  filter?: ProductListQuery
  /** The warehouse the figures are scoped to and the rows start allocated to; else the filter's, else the organization's default. */
  warehouseId?: string
  /** `customer`: the rows of a customer order (no suppliers or costs, a quantity of 1). Default `supplier`. */
  kind?: 'supplier' | 'customer'
}

export interface PreviewSupplier {
  supplierId: string
  name: string
  lastUnitPrice?: number
  currency?: string
}

export interface PreviewRow {
  productId: string
  sku: string
  name: string
  unit: string
  trackInventory: boolean
  onHand: number
  reserved: number
  onOrder: number
  minStockLevel: number
  maxStockLevel: number
  suggestedQuantity: number
  /** Absent for a caller who may not read bills (FR-28.21): the keys are not in the answer, not hidden by the UI. */
  suppliers?: PreviewSupplier[]
  supplierId?: string
  expectedUnitPrice?: number
  warehouseId?: string
}

export interface PreviewResult {
  rows: PreviewRow[]
  total: number
  /** What the prices are in: the organization's base currency, which the order is created in. */
  currency: string
}

/** The articles a selection names, in the order of the selection and then of the filter, active ones only. */
async function resolveSelection(orgId: string, user: AccessCaller | null | undefined, input: PreviewInput): Promise<string[]> {
  const explicit = [...new Set((input.productIds ?? []).map((i) => idStr(i).trim().toLowerCase()))]
  if (explicit.length > MAX_ORDER_ITEMS) {
    throw new OrdersFromProductsError(422, `At most ${MAX_ORDER_ITEMS} articles at a time.`, { code: 'selection_too_large', total: explicit.length, max: MAX_ORDER_ITEMS })
  }
  const hasFilter = !!input.filter && typeof input.filter === 'object'
  if (!explicit.length && !hasFilter) throw new OrdersFromProductsError(422, 'Select at least one article.', { code: 'no_selection' })

  let matched: string[] = []
  if (hasFilter) {
    const resolved = await resolveProductListFilter(orgId, input.filter as ProductListQuery, user)
    if (resolved.refusal) throw new OrdersFromProductsError(resolved.refusal.statusCode, resolved.refusal.body.message, resolved.refusal.body)
    // A deactivated article is never in an order, whatever the list's Status filter said.
    const active = { ...resolved.filter, isActive: { $ne: false } }
    matched = await productIdsMatching(getRepos().products, active)
  }
  const union = [...explicit.filter((i) => OBJECT_ID.test(i)), ...matched.filter((i) => !explicit.includes(i))]
  if (union.length > MAX_ORDER_ITEMS) {
    throw new OrdersFromProductsError(422, `At most ${MAX_ORDER_ITEMS} articles at a time: narrow the filter.`, { code: 'selection_too_large', total: union.length, max: MAX_ORDER_ITEMS })
  }
  return union
}

/** Active suppliers of the organization among these contacts, with their names. */
async function activeSuppliers(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const valid = [...new Set(ids.filter((i) => OBJECT_ID.test(i)))]
  if (!valid.length) return new Map()
  const rows: any[] = await Contact.find(
    { orgId, _id: { $in: valid }, type: { $in: ['supplier', 'both'] }, isActive: { $ne: false } } as any,
    { companyName: 1, firstName: 1, lastName: 1 },
  ).lean().exec()
  return new Map(rows.map((c) => [String(c._id), nameOfContact(c)]))
}

export async function previewOrderFromProducts(orgId: string, user: AccessCaller | null | undefined, input: PreviewInput): Promise<PreviewResult> {
  const kind = input.kind === 'customer' ? 'customer' : 'supplier'
  const ids = await resolveSelection(orgId, user, input)
  const currency = await baseCurrencyOf(orgId)
  if (!ids.length) return { rows: [], total: 0, currency }

  // The figures are scoped as the list is: the warehouse filter, or every warehouse.
  const filterWarehouse = input.filter && typeof input.filter.warehouseId === 'string' ? input.filter.warehouseId : undefined
  const scope = input.warehouseId || filterWarehouse || undefined
  const warehouseId = await defaultWarehouseId(orgId, scope)

  const products: any[] = await Product.find({ orgId, _id: { $in: ids }, isActive: { $ne: false } } as any).lean().exec()
  const productById = new Map(products.map((p) => [String(p._id), p]))
  const present = ids.filter((id) => productById.has(id))

  const org = new Types.ObjectId(orgId)
  const [levels, supply] = await Promise.all([
    StockLevel.aggregate([
      { $match: { orgId: org, productId: { $in: present.map((i) => new Types.ObjectId(i)) }, ...(scope && OBJECT_ID.test(scope) ? { warehouseId: new Types.ObjectId(scope) } : {}) } },
      { $group: { _id: '$productId', quantity: { $sum: '$quantity' } } },
    ]).exec(),
    getProductsSupplyTotals(orgId, present, { warehouseId: scope }),
  ])
  const onHandOf = new Map<string, number>(levels.map((l: any) => [String(l._id), num(l.quantity)]))

  // Who we buy from is incoming-document data (`bills.view`); a cost is a cost (FR-28.21). Neither is in the answer
  // for a caller who may not see it, and neither is looked up for a customer order.
  const wantsSuppliers = kind === 'supplier' && canSeeSupplierFacts(user)
  const wantsCosts = kind === 'supplier' && canSeeSupplierPrices(user)
  const [facts, defaults, recorded] = wantsSuppliers
    ? await Promise.all([getSupplierFacts(orgId, present, { includePrices: wantsCosts }), getDefaultSuppliers(orgId, present), getRecordedSupplierNames(orgId, present)])
    : [{} as Awaited<ReturnType<typeof getSupplierFacts>>, new Map(), new Map<string, Array<{ supplierId: string }>>()]
  const suppliers = wantsSuppliers
    ? await activeSuppliers(orgId, [
      ...Object.values(facts).flatMap((l) => l.map((f) => f.supplierId)),
      ...[...defaults.values()].map((d) => d.supplierId),
      ...[...recorded.values()].flatMap((l) => l.map((r) => r.supplierId)),
    ])
    : new Map<string, string>()

  const rows: PreviewRow[] = []
  for (const id of present) {
    const p = productById.get(id)
    const onHand = onHandOf.get(id) ?? 0
    const t = supply[id] ?? { reserved: 0, incoming: 0 }
    const position = reorderPosition(onHand, t.reserved, t.incoming)
    const row: PreviewRow = {
      productId: id,
      sku: p.sku || '',
      name: p.name || '',
      unit: p.unit || 'pcs',
      trackInventory: p.trackInventory !== false,
      onHand,
      reserved: t.reserved,
      onOrder: t.incoming,
      minStockLevel: num(p.minStockLevel),
      maxStockLevel: num(p.maxStockLevel),
      // A customer order's lines start at one: what a client asks for is not what the shelf is short of.
      suggestedQuantity: kind === 'customer' ? 1 : suggestedOrderQuantity(p, position),
      ...(warehouseId ? { warehouseId } : {}),
    }
    if (wantsSuppliers) {
      const named: PreviewSupplier[] = []
      for (const f of (facts[id] ?? []).slice(0, SUPPLIER_FACTS_PER_PRODUCT)) {
        if (!suppliers.has(f.supplierId)) continue
        named.push({
          supplierId: f.supplierId,
          name: suppliers.get(f.supplierId)!,
          ...(wantsCosts && f.lastUnitPrice != null ? { lastUnitPrice: f.lastUnitPrice, currency: f.currency } : {}),
        })
      }
      // A supplier a person recorded for the article (FR-28.9) is offered too, after the ones the documents name:
      // the default below is chosen by the one rule (`getDefaultSuppliers`), this only completes the choices.
      for (const r of recorded.get(id) ?? []) {
        if (suppliers.has(r.supplierId) && !named.some((s) => s.supplierId === r.supplierId)) named.push({ supplierId: r.supplierId, name: suppliers.get(r.supplierId)! })
      }
      const dflt = defaults.get(id)
      // A supplier named only by an order (no purchase yet) or by a recorded preference has no fact: it still heads the list.
      if (dflt && suppliers.has(dflt.supplierId)) {
        const at = named.findIndex((s) => s.supplierId === dflt.supplierId)
        if (at < 0) named.unshift({ supplierId: dflt.supplierId, name: suppliers.get(dflt.supplierId)! })
        else if (at > 0 && dflt.basis === 'recorded') named.unshift(...named.splice(at, 1))
      }
      row.suppliers = named
      if (dflt && suppliers.has(dflt.supplierId)) row.supplierId = dflt.supplierId
      else if (named[0]) row.supplierId = named[0].supplierId
    }
    if (wantsCosts) {
      // The supplier's last price when it is in the currency the order is made in, else the article's cost price.
      const chosen = row.suppliers?.find((s) => s.supplierId === row.supplierId)
      if (chosen?.lastUnitPrice != null && (!chosen.currency || chosen.currency === currency)) row.expectedUnitPrice = chosen.lastUnitPrice
      else if (num(p.purchasePrice) > 0) row.expectedUnitPrice = num(p.purchasePrice)
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku))
  return { rows, total: rows.length, currency }
}

// ── the creates ─────────────────────────────────────────────────────────────────────────────────────

function requestIdOf(v: unknown): string {
  const id = idStr(v).trim()
  if (!id || id.length > MAX_REQUEST_ID) throw new OrdersFromProductsError(422, 'requestId is required', { code: 'request_id_required' })
  return id
}

function isDuplicate(e: any, field: 'requestId' | 'orderNumber'): boolean {
  if (e?.code !== 11000) return false
  const hit = `${e?.message ?? ''} ${JSON.stringify(e?.keyPattern ?? {})}`
  return field === 'requestId' ? /createdFrom/.test(hit) : /orderNumber/.test(hit)
}

export interface SupplierOrderItem {
  productId: string
  quantity: number
  supplierId: string
  warehouseId: string
  expectedUnitPrice?: number
}

export interface CreateSupplierOrderInput {
  requestId: string
  items: SupplierOrderItem[]
  /** A DRAFT supplier order of the organization to add the lines to, instead of making a new one. */
  appendToOrderId?: string
}

export interface CreateOrderResult<T> {
  order: T
  skipped: SkippedItem[]
  /** True when the request had been made before: the order is the one it created. */
  replayed?: boolean
}

const auditOf = (source: string, items: number) => [
  { field: 'source', oldValue: null, newValue: source },
  { field: 'items', oldValue: null, newValue: items },
]

export async function createSupplierOrderFromProducts(
  orgId: string,
  userId: string,
  input: CreateSupplierOrderInput,
): Promise<CreateOrderResult<any>> {
  const requestId = requestIdOf(input.requestId)
  const items = input.items ?? []
  if (!items.length) throw new OrdersFromProductsError(422, 'At least one article is required', { code: 'no_items' })
  if (items.length > MAX_ORDER_ITEMS) throw new OrdersFromProductsError(422, `At most ${MAX_ORDER_ITEMS} articles at a time.`, { code: 'selection_too_large', total: items.length, max: MAX_ORDER_ITEMS })

  // Idempotent: the request has been made before, so its order exists. Nothing is looked at again.
  const before = await Order.findOne({ orgId, 'createdFrom.requestId': requestId } as any).exec()
  if (before) return { order: before, skipped: [], replayed: true }

  // An append needs its draft first: another organization's order is "not found", a sent one is refused.
  let target: any = null
  if (input.appendToOrderId) {
    target = OBJECT_ID.test(input.appendToOrderId) ? await Order.findOne({ _id: input.appendToOrderId, orgId } as any).exec() : null
    if (!target) throw new OrdersFromProductsError(404, 'Outgoing order not found', { code: 'order_not_found' })
    if (target.status !== 'draft') throw new OrdersFromProductsError(422, 'Can only append to a draft outgoing order', { code: 'order_not_draft', orderStatus: target.status })
    if ((target.appendedRequestIds ?? []).includes(requestId)) return { order: target, skipped: [], replayed: true }
  }

  const ids = (field: 'productId' | 'supplierId' | 'warehouseId') => [...new Set(items.map((i) => idStr(i[field])).filter((i) => OBJECT_ID.test(i)))]
  const [products, suppliers, warehouses]: [any[], any[], any[]] = await Promise.all([
    Product.find({ orgId, _id: { $in: ids('productId') } } as any, { name: 1, sku: 1, unit: 1, isActive: 1 }).lean().exec(),
    Contact.find({ orgId, _id: { $in: ids('supplierId') } } as any, { type: 1, isActive: 1 }).lean().exec(),
    Warehouse.find({ orgId, _id: { $in: ids('warehouseId') } } as any, { _id: 1 }).lean().exec(),
  ])
  const productById = new Map(products.map((p) => [String(p._id), p]))
  const supplierById = new Map(suppliers.map((c) => [String(c._id), c]))
  const warehouseIds = new Set(warehouses.map((w) => String(w._id)))

  const skipped: SkippedItem[] = []
  const valid: Array<SupplierOrderItem & { product: any }> = []
  for (const item of items) {
    const productId = idStr(item.productId)
    const product = productById.get(productId)
    const supplier = supplierById.get(idStr(item.supplierId))
    const price = item.expectedUnitPrice
    const reason = !product ? 'product_not_found'
      : product.isActive === false ? 'product_inactive'
        : !(Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0) ? 'invalid_quantity'
          : !idStr(item.supplierId) ? 'supplier_required'
            : !supplier ? 'supplier_not_found'
              : !['supplier', 'both'].includes(supplier.type) ? 'not_a_supplier'
                : supplier.isActive === false ? 'supplier_inactive'
                  : !warehouseIds.has(idStr(item.warehouseId)) ? 'warehouse_not_found'
                    : price != null && !(Number.isFinite(Number(price)) && Number(price) >= 0) ? 'invalid_price'
                      : null
    if (reason) skipped.push({ productId, reason })
    else valid.push({ ...item, product })
  }
  if (!valid.length) {
    throw new OrdersFromProductsError(422, 'None of the articles can be ordered', { code: 'nothing_to_order', skipped })
  }

  const lineOf = (v: SupplierOrderItem & { product: any }) => ({
    supplierId: v.supplierId,
    productId: v.product._id,
    description: v.product.name || '',
    sku: v.product.sku || undefined,
    quantity: Number(v.quantity),
    unit: v.product.unit || 'pcs',
    expectedUnitPrice: v.expectedUnitPrice == null ? undefined : Number(v.expectedUnitPrice),
    warehouseId: v.warehouseId,
  })

  // ── append: ONE conditional update on the draft as it was read, so a draft that was sent or edited meanwhile is
  // never written over, and a replay of the same request adds nothing twice.
  if (target) {
    const readAt = target.updatedAt
    for (const v of valid) addLineToSupplierGroup(target, lineOf(v))
    const groups = target.toObject().supplierGroups
    const res = await Order.updateOne(
      { _id: target._id, orgId, status: 'draft', updatedAt: readAt, appendedRequestIds: { $ne: requestId } } as any,
      { $set: { supplierGroups: groups }, $push: { appendedRequestIds: requestId } },
    ).exec()
    if (res.modifiedCount === 0) {
      const now: any = await Order.findOne({ _id: target._id, orgId } as any).exec()
      if (now && (now.appendedRequestIds ?? []).includes(requestId)) return { order: now, skipped: [], replayed: true }
      throw new OrdersFromProductsError(409, 'The draft changed meanwhile: open it again and retry', { code: 'order_changed' })
    }
    const order = await Order.findOne({ _id: target._id, orgId } as any).exec()
    createAuditEntry({ orgId, userId, action: 'update', module: 'invoicing', entityType: 'order', entityId: String(target._id), entityName: target.orderNumber, changes: auditOf('products', valid.length) })
    return { order, skipped }
  }

  // ── create: one draft, one group per supplier, a line per article, one allocation per line
  const currency = await baseCurrencyOf(orgId)
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderNumber = await getNextOrderNumber(orgId, true)
    const order = new Order({
      orgId,
      orderNumber,
      status: 'draft',
      statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'created_from_products' }],
      numberHistory: [{ number: orderNumber, allocatedAt: new Date(), status: 'draft' }],
      issueDate: new Date(),
      currency,
      exchangeRate: 1,
      supplierGroups: [],
      createdBy: userId,
      createdFrom: { source: 'products', requestId },
    })
    for (const v of valid) addLineToSupplierGroup(order, lineOf(v))
    try {
      await order.save()
      createAuditEntry({ orgId, userId, action: 'create', module: 'invoicing', entityType: 'order', entityId: String(order._id), entityName: orderNumber, changes: auditOf('products', valid.length) })
      return { order, skipped }
    } catch (e: any) {
      lastErr = e
      // A double click: the other request won. Its order is this request's answer.
      if (isDuplicate(e, 'requestId')) {
        const won = await Order.findOne({ orgId, 'createdFrom.requestId': requestId } as any).exec()
        if (won) return { order: won, skipped: [], replayed: true }
      }
      if (!isDuplicate(e, 'orderNumber')) throw e
    }
  }
  throw new OrdersFromProductsError(409, `Could not allocate order number: ${lastErr?.message || 'duplicate'}`, { code: 'number_unavailable' })
}

export interface CreateCustomerOrderInput {
  requestId: string
  contactId: string
  requestedDeliveryDate: string
  issueDate?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  warehouseId?: string
  items: Array<{ productId: string; quantity: number }>
}

const validDate = (v: unknown): Date | null => {
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export async function createCustomerOrderFromProducts(
  orgId: string,
  userId: string,
  input: CreateCustomerOrderInput,
): Promise<CreateOrderResult<any>> {
  const requestId = requestIdOf(input.requestId)
  const items = input.items ?? []
  if (!items.length) throw new OrdersFromProductsError(422, 'At least one article is required', { code: 'no_items' })
  if (items.length > MAX_ORDER_ITEMS) throw new OrdersFromProductsError(422, `At most ${MAX_ORDER_ITEMS} articles at a time.`, { code: 'selection_too_large', total: items.length, max: MAX_ORDER_ITEMS })

  const before = await InternalOrder.findOne({ orgId, 'createdFrom.requestId': requestId } as any).exec()
  if (before) return { order: before, skipped: [], replayed: true }

  // The client: a customer (or both) of THIS organization.
  const client: any = OBJECT_ID.test(idStr(input.contactId)) ? await Contact.findOne({ _id: input.contactId, orgId } as any, { type: 1, isActive: 1 }).lean().exec() : null
  if (!client) throw new OrdersFromProductsError(404, 'Client not found', { code: 'client_not_found' })
  if (!['customer', 'both'].includes(client.type)) throw new OrdersFromProductsError(422, 'The contact is not a customer', { code: 'not_a_customer' })
  if (client.isActive === false) throw new OrdersFromProductsError(422, 'The client is deactivated', { code: 'client_inactive' })
  const delivery = validDate(input.requestedDeliveryDate)
  if (!delivery) throw new OrdersFromProductsError(422, 'requestedDeliveryDate is required', { code: 'delivery_date_required' })
  const issued = input.issueDate ? validDate(input.issueDate) : new Date()
  if (!issued) throw new OrdersFromProductsError(422, 'issueDate is not a date', { code: 'invalid_issue_date' })
  let warehouseId: string | undefined
  if (input.warehouseId) {
    const wh: any = OBJECT_ID.test(input.warehouseId) ? await Warehouse.findOne({ _id: input.warehouseId, orgId } as any, { _id: 1 }).lean().exec() : null
    if (!wh) throw new OrdersFromProductsError(422, 'Warehouse not found', { code: 'warehouse_not_found' })
    warehouseId = String(wh._id)
  }

  const ids = [...new Set(items.map((i) => idStr(i.productId)).filter((i) => OBJECT_ID.test(i)))]
  const products: any[] = await Product.find({ orgId, _id: { $in: ids } } as any, { name: 1, sku: 1, unit: 1, sellingPrice: 1, isActive: 1 }).lean().exec()
  const productById = new Map(products.map((p) => [String(p._id), p]))
  const skipped: SkippedItem[] = []
  const lines: any[] = []
  for (const item of items) {
    const productId = idStr(item.productId)
    const p = productById.get(productId)
    const reason = !p ? 'product_not_found'
      : p.isActive === false ? 'product_inactive'
        : !(Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0) ? 'invalid_quantity'
          : null
    if (reason) { skipped.push({ productId, reason }); continue }
    lines.push({
      productId: p._id,
      description: p.name || '',
      sku: p.sku || undefined,
      quantity: Number(item.quantity),
      unit: p.unit || 'pcs',
      // The indicative price a customer order shows, as its form starts it: the selling price.
      expectedUnitPrice: num(p.sellingPrice) > 0 ? num(p.sellingPrice) : undefined,
    })
  }
  if (!lines.length) throw new OrdersFromProductsError(422, 'None of the articles can be ordered', { code: 'nothing_to_order', skipped })

  const currency = await baseCurrencyOf(orgId)
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderNumber = await getNextInternalOrderNumber(orgId, true)
    try {
      const order = await InternalOrder.create({
        orgId,
        orderNumber,
        status: 'draft',
        statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'created_from_products' }],
        numberHistory: [{ number: orderNumber, allocatedAt: new Date(), status: 'draft' }],
        contactId: client._id,
        issueDate: issued,
        requestedDeliveryDate: delivery,
        priority: input.priority || 'normal',
        warehouseId,
        currency,
        exchangeRate: 1,
        lines,
        createdBy: userId,
        createdFrom: { source: 'products', requestId },
      } as any)
      createAuditEntry({ orgId, userId, action: 'create', module: 'invoicing', entityType: 'internal_order', entityId: String(order._id), entityName: orderNumber, changes: auditOf('products', lines.length) })
      return { order, skipped }
    } catch (e: any) {
      lastErr = e
      if (isDuplicate(e, 'requestId')) {
        const won = await InternalOrder.findOne({ orgId, 'createdFrom.requestId': requestId } as any).exec()
        if (won) return { order: won, skipped: [], replayed: true }
      }
      if (!isDuplicate(e, 'orderNumber')) throw e
    }
  }
  throw new OrdersFromProductsError(409, `Could not allocate order number: ${lastErr?.message || 'duplicate'}`, { code: 'number_unavailable' })
}
