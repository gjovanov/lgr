import { describe, it, expect } from 'bun:test'
import { createApiApp } from '../../../portal-api/src/api.js'

/**
 * FR-32.19 (#797): every write route says what it accepts. Over the real route table: a POST, PUT or PATCH that reads
 * a body declares a body schema, and an array in a schema declares its elements. A write route with no schema is on
 * READS_NO_BODY with the reason, and the check holds the list to the code: a listed handler that takes `body` fails it.
 *
 * Why: Elysia drops what a schema does not declare and answers 200 (`CLAUDE.md`, "a route's body schema is a
 * whitelist"), and a route with no schema took anything, so a value the model does not allow reached it unseen.
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** A DELETE names its record in the URL. */
const DELETE_REASON = 'a DELETE names its record in the URL and reads no body'
/** An action on the record the URL names: the route decides everything itself. */
const ACTION = 'an action on the record the URL names; it reads no body'
/**
 * A multipart upload: its files are read from `request.formData()` and checked by hand, because Elysia's `t.Files()`
 * validator refused real uploads (see the handlers' comments).
 */
const MULTIPART = 'a multipart upload: the handler reads and checks its files from the form itself'

const READS_NO_BODY: Record<string, string> = {
  'POST /api/auth/oauth-code/redeem': 'the code is in the query string',
  'POST /api/auth/logout': 'it ends the session the request carries',
  'POST /api/invite/:code/accept': 'the invite is the URL\'s code, the person the session',
  'POST /api/stripe/portal': 'it opens the billing portal of the session\'s org',
  'POST /api/stripe/webhook': 'Stripe\'s raw payload, read as text and verified by its signature',
  'POST /api/org/:orgId/logo/': MULTIPART,
  'POST /api/org/:orgId/backup/test-email': ACTION,
  'POST /api/org/:orgId/backup/upload': MULTIPART,
  'PUT /api/org/:orgId/notification/:id/read': ACTION,
  'PUT /api/org/:orgId/notification/read-all': 'it marks every notification of the session\'s user',
  'POST /api/org/:orgId/apps/:appId/activate': ACTION,
  'POST /api/org/:orgId/apps/:appId/deactivate': ACTION,
  'POST /api/org/:orgId/accounting/journal/:id/post': ACTION,
  'POST /api/org/:orgId/accounting/journal/:id/void': ACTION,
  'POST /api/org/:orgId/accounting/journal/postings/:id/retry': ACTION,
  'POST /api/org/:orgId/invoices/:id/receipt': ACTION,
  'POST /api/org/:orgId/invoices/:id/void': ACTION,
  'POST /api/org/:orgId/invoicing/number-clashes/:id/prepare': ACTION,
  'POST /api/org/:orgId/invoicing/orders/:id/send': ACTION,
  'POST /api/org/:orgId/invoicing/orders/:id/cancel': ACTION,
  'POST /api/org/:orgId/invoicing/orders/:id/complete': ACTION,
  'POST /api/org/:orgId/invoicing/internal-orders/:id/confirm': ACTION,
  'POST /api/org/:orgId/invoicing/internal-orders/:id/complete': ACTION,
  'POST /api/org/:orgId/invoicing/internal-orders/:id/cancel': ACTION,
  'POST /api/org/:orgId/invoicing/internal-orders/:id/convert': ACTION,
  'POST /api/org/:orgId/bills/import/extract': MULTIPART,
  'POST /api/org/:orgId/doc-import/extract': MULTIPART,
  'POST /api/org/:orgId/invoicing/payment-order/:id/execute': ACTION,
  'POST /api/org/:orgId/warehouse/opening-stock/': MULTIPART,
  'POST /api/org/:orgId/warehouse/inventory-count/:id/complete': ACTION,
  'POST /api/org/:orgId/warehouse/cost-layer/initialize/:productId': ACTION,
  'POST /api/org/:orgId/payroll/run/:id/approve': ACTION,
  'POST /api/org/:orgId/trade/pos/session/:id/report/print': ACTION,
  'POST /api/org/:orgId/files/upload': MULTIPART,
  'POST /api/org/:orgId/files/:id/ocr': ACTION,
  'POST /api/org/:orgId/files/:id/compare': ACTION,
  'POST /api/org/:orgId/files/:id/analyze': ACTION,
  'POST /api/org/:orgId/files/:id/reconcile': ACTION,
  'POST /api/org/:orgId/files/archives/:id': ACTION,
  'POST /api/org/:orgId/files/archives/:id/unarchive': ACTION,
  'POST /api/org/:orgId/fiscal/device/:id/connect': ACTION,
  'POST /api/org/:orgId/fiscal/device/:id/disconnect': ACTION,
  'POST /api/org/:orgId/fiscal/device/:id/x-report': ACTION,
  'POST /api/org/:orgId/desktops/:id/rotate-key': ACTION,
  'POST /api/org/:orgId/desktops/:id/update': ACTION,
  'POST /api/org/:orgId/desktops/update-all': 'it updates every desktop of the org the URL names',
  'POST /api/org/:orgId/desktops/enrollment-codes': 'it mints a code for the org the URL names',
  'POST /api/org/:orgId/nodes/enrollment-codes': 'it mints a code for the org the URL names',
  'PUT /api/node/v1/moves/:id/fenced-export': 'the export\'s bytes, streamed and checked by the move itself',
  'POST /api/org/:orgId/moves/promote/preflight': 'it reads the state of the org the URL names',
  'POST /api/org/:orgId/moves/reseed/preflight': 'it reads the state of the org the URL names',
  'POST /api/org/:orgId/moves/fenced-exports/:exportId/import': ACTION,
  'POST /api/org/:orgId/moves/:id/abort': ACTION,
  'POST /api/org/:orgId/server/kept/:moveId/import': ACTION,
  'POST /api/admin/nodes/held/after-restore': 'it releases what the restore held, all of it',
  'POST /api/org/:orgId/address/': 'it asks lgrai.app for the org\'s address; nothing is chosen by the caller',
  'POST /api/admin/addresses/:id/approve': ACTION,
  'POST /api/admin/addresses/:id/retire': ACTION,
}

interface Route { method: string; path: string; handler: unknown; hooks?: { body?: unknown } }

const routes = ((createApiApp() as any).routes as Route[]).filter(r => !READ_METHODS.has(r.method))
const key = (r: Route) => `${r.method} ${r.path}`

/** Does the handler take the request body? Its first parameter destructures `body`, or it reads `ctx.body`. */
function readsBody(r: Route): boolean {
  const src = String(r.handler)
  const arrow = src.indexOf('=>')
  const head = src.slice(0, arrow > 0 ? arrow : 200)
  return /\bbody\b/.test(head) || /\b(ctx|c|context)\.body\b/.test(src)
}

/** Every array in a schema, by its path, whose elements are "anything". */
function untypedArrays(schema: any, path = ''): string[] {
  if (!schema || typeof schema !== 'object') return []
  const out: string[] = []
  if (schema.type === 'array') {
    const items = schema.items
    const kind = items?.[Symbol.for('TypeBox.Kind')]
    if (!items || kind === 'Any' || kind === 'Unknown' || (!kind && Object.keys(items).length === 0)) out.push(path || '(root)')
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'items' || k === 'properties' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
      if (Array.isArray(v)) v.forEach((s, i) => out.push(...untypedArrays(s, `${path}[${i}]`)))
      else if (k === 'properties') for (const [p, s] of Object.entries(v as object)) out.push(...untypedArrays(s, path ? `${path}.${p}` : p))
      else out.push(...untypedArrays(v, `${path}[]`))
    }
  }
  return out
}

describe('every write route says what it accepts (FR-32.19)', () => {
  it('a POST, PUT or PATCH without a body schema is on the list, with its reason', () => {
    const missing = routes
      .filter(r => r.method !== 'DELETE' && !r.hooks?.body)
      .map(key)
      .filter(k => !(k in READS_NO_BODY))
    expect(missing).toEqual([])
  })

  it('a DELETE without a body schema reads no body', () => {
    const reading = routes.filter(r => r.method === 'DELETE' && !r.hooks?.body && readsBody(r)).map(key)
    expect(reading).toEqual([])
    expect(DELETE_REASON.length).toBeGreaterThan(10)
  })

  it('a listed route still has no schema, and reads no body unless it is a multipart upload', () => {
    const byKey = new Map(routes.map(r => [key(r), r]))
    const stale = Object.keys(READS_NO_BODY).filter(k => !byKey.has(k) || byKey.get(k)!.hooks?.body)
    expect(stale).toEqual([])
    const reading = Object.entries(READS_NO_BODY)
      .filter(([k, why]) => why !== MULTIPART && readsBody(byKey.get(k)!))
      .map(([k]) => k)
    expect(reading).toEqual([])
  })

  it('an array in a body schema declares its elements', () => {
    const loose = routes.filter(r => r.hooks?.body).flatMap(r => untypedArrays(r.hooks!.body).map(p => `${key(r)} ${p}`))
    expect(loose).toEqual([])
  })
})
