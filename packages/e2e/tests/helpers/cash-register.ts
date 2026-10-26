/**
 * FR-21 — fixtures for the cash-register journal specs, through the API.
 *
 * The seed has back-office cash sales but no till: no POS session and no POS transaction. A spec
 * that needs the till's side of the journal rings a sale here, as a cashier would, in the
 * cashier's own open session (one is opened at the store if they have none).
 *
 * ⚠ CLOSE WHAT YOU OPEN. The POS terminal shows ANY open session in the org, not only its user's
 * (`PosTerminalView.vue#fetchSessions`), so a cashier session left open here hides the "Open
 * Session" button `pos-terminal.spec.ts` expects. Sales are rung as `sales` (never `admin`, whose
 * session that spec opens itself), and every spec closes its session when done
 * (`closeTillSession`). While a spec holds one open, a parallel `pos-terminal.spec.ts` can still
 * see it: run these with `--workers=1` when one of them fails.
 *
 * Native `fetch`, like `helpers/api.ts` (Set-Cookie breaks Playwright's request context in v1.58).
 */
import ExcelJS from 'exceljs'
import { apiLogin, type ApiSession } from './api'

const API = process.env.BASE_URL || 'http://localhost:4001'

export interface TillSale {
  id: string
  number: string
  total: number
  sessionId: string
  productId: string
  sku: string
  warehouseId: string
  /** The product's stock at the till's warehouse before the sale. */
  stockBefore: number
}

async function call(session: ApiSession, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/api/org/${session.orgId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json
}

function userIdOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id
}

/** Half away from zero, to the cent — `config/pos-totals#roundCents`. */
const cents = (n: number) => Math.round(n * 100 * (1 + Number.EPSILON)) / 100

/** The cashier's open session; one is opened at the store if they have none. */
export async function openTillSession(session: ApiSession): Promise<{ id: string; warehouseId: string }> {
  const open = await call(session, 'GET', `/trade/pos/session?status=open&cashierId=${userIdOf(session.token)}&size=1`)
  const existing = open.sessions?.[0]
  if (existing) return { id: existing.id || existing._id, warehouseId: String(existing.warehouseId) }

  const { warehouses } = await call(session, 'GET', '/warehouse/warehouse?size=50')
  const store = warehouses.find((w: any) => w.code === 'ST-01') || warehouses[0]
  const { session: opened } = await call(session, 'POST', '/trade/pos/session', {
    warehouseId: store.id || store._id, openingBalance: 0, currency: 'EUR',
  })
  return { id: opened.id || opened._id, warehouseId: String(opened.warehouseId) }
}

/**
 * One item, paid by card, at the till. The seed has no fiscal device, so it records no receipt.
 * Totals are what the server computes (`computePosTotals`): prices are net, the gross is rounded
 * once and the VAT taken back out of it.
 */
export async function ringTillSale(session?: ApiSession): Promise<TillSale> {
  const cashier = session || await apiLogin('acme-corp', 'sales', 'test123')
  const till = await openTillSession(cashier)
  const { products } = await call(cashier, 'GET', `/trade/pos/catalog?warehouseId=${till.warehouseId}&type=goods&size=100`)
  const product = products.find((p: any) => (p.stockAvailable ?? 0) >= 1 && p.unitPrice > 0)
  if (!product) throw new Error('no product with stock at the till\'s warehouse — is the DB seeded?')

  const rate = product.taxRate || 0
  const net = cents(product.unitPrice)
  const total = cents(net * (1 + rate / 100))
  const taxTotal = cents((total * rate) / (100 + rate))
  const { transaction } = await call(cashier, 'POST', `/trade/pos/session/${till.id}/transaction`, {
    type: 'sale',
    lines: [{
      productId: product.productId, name: product.productName, quantity: 1, unitPrice: product.unitPrice,
      discount: 0, taxRate: rate, taxAmount: cents((net * rate) / 100), lineTotal: net,
    }],
    subtotal: cents(total - taxTotal), discountTotal: 0, taxTotal, total,
    payments: [{ method: 'card', amount: total }],
    changeDue: 0,
  })
  return {
    id: transaction.id || transaction._id, number: transaction.transactionNumber, total, sessionId: till.id,
    productId: product.productId, sku: product.sku, warehouseId: till.warehouseId, stockBefore: product.stockAvailable,
  }
}

/**
 * Close the cashier's session. Every sale here is paid by card, so the drawer holds the opening
 * balance (0); the seed has no fiscal device, so no Z-report runs (`fiscalStatus: 'skipped'`).
 */
export async function closeTillSession(sessionId: string, cashier?: ApiSession): Promise<void> {
  const session = cashier || await apiLogin('acme-corp', 'sales', 'test123')
  await call(session, 'POST', `/trade/pos/session/${sessionId}/close`, { closingBalance: 0 })
}

/**
 * The cash-register export (`POST /invoicing/export/kind/cash_register`) as rows of cell values:
 * the document list, or with `aggregated: true` the per-product pivot. Read whole, never through
 * ExcelJS's stream reader, which corrupts Cyrillic.
 */
export async function cashRegisterExport(session: ApiSession, body: Record<string, unknown>): Promise<unknown[][]> {
  const res = await fetch(`${API}/api/org/${session.orgId}/invoicing/export/kind/cash_register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ format: 'xlsx', mode: 'compact', ...body }),
  })
  if (!res.ok) throw new Error(`export → ${res.status} ${await res.text()}`)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()) as any)
  const rows: unknown[][] = []
  workbook.eachSheet(sheet => sheet.eachRow(row => { rows.push((row.values as unknown[]).slice(1)) }))
  return rows
}

/** The sold product's stock at the till's warehouse now. */
export async function stockOf(session: ApiSession, sale: TillSale): Promise<number | null> {
  const { products } = await call(session, 'GET', `/trade/pos/catalog?warehouseId=${sale.warehouseId}&search=${encodeURIComponent(sale.sku)}&size=50`)
  return products.find((p: any) => p.productId === sale.productId)?.stockAvailable ?? null
}

/**
 * A back-office cash sale (`POST /invoices`, as the invoicing terminal saves one), of one item
 * from the main warehouse, paid in cash. An invoice line's `lineTotal` is gross (FR-21.5).
 */
export async function createBackOfficeCashSale(session?: ApiSession): Promise<{ id: string; number: string }> {
  const admin = session || await apiLogin()
  const { warehouses } = await call(admin, 'GET', '/warehouse/warehouse?size=50')
  const main = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
  const warehouseId = main.id || main._id
  const { products } = await call(admin, 'GET', `/trade/pos/catalog?warehouseId=${warehouseId}&type=goods&size=100&sortOrder=desc`)
  const product = products.find((p: any) => (p.stockAvailable ?? 0) >= 1 && p.unitPrice > 0)
  if (!product) throw new Error('no product with stock in the main warehouse — is the DB seeded?')

  const rate = product.taxRate || 0
  const net = cents(product.unitPrice)
  const tax = cents((net * rate) / 100)
  const { invoice } = await call(admin, 'POST', '/invoices', {
    type: 'cash_sale', direction: 'outgoing', issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{
      productId: product.productId, description: product.productName, quantity: 1, unit: product.unit || 'pcs',
      unitPrice: product.unitPrice, discount: 0, taxRate: rate, taxAmount: tax, lineTotal: cents(net + tax), warehouseId,
    }],
    subtotal: net, taxTotal: tax, total: cents(net + tax), paymentMethod: 'cash',
  })
  return { id: invoice.id || invoice._id, number: invoice.invoiceNumber }
}

/**
 * At least one till sale and one back-office sale in the journal, for specs that only need rows.
 * ⚠ `fullyParallel` runs a describe's `beforeAll` once per TEST, so this adds only what is missing.
 */
export async function ensureJournalRows(): Promise<void> {
  const admin = await apiLogin()
  if (!(await journal(admin, 'origin=pos&size=1')).total) {
    const sale = await ringTillSale()
    await closeTillSession(sale.sessionId)
  }
  if (!(await journal(admin, 'origin=backoffice&size=1')).total) await createBackOfficeCashSale(admin)
}

/** One page of the journal, as the API answers it. */
export async function journal(session: ApiSession, query = ''): Promise<{ rows: any[]; total: number }> {
  return call(session, 'GET', `/cash-register/documents${query ? `?${query}` : ''}`)
}
