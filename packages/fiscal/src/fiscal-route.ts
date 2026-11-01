import { Elysia } from 'elysia'
import { mongoose } from 'db/connection'
import { FiscalDevice, Invoice, POSSession } from 'db/models'
import { isDeviceConnected } from './fiscal-device.service.js'
import { POD_ID, livePresence } from 'services/biz/fiscal-presence.service'
import { logger } from 'services/logger'

/**
 * FR-24.50–24.52: the request goes to the printer.
 *
 * A route that reaches a fiscal device declares it, `{ fiscalDevice: <resolver> }`, and the resolver
 * names the device from `{ user, params, body }`. Before the handler, after authentication:
 *
 *  - held by THIS process, or by nobody anywhere: the handler runs here (nobody: as today, which is
 *    `getFiscalContext`'s rule for a device that is not connected);
 *  - held by another pod (a live `fiscal_presence` row): the request is forwarded there as a hop and
 *    its answer is this answer. Nothing has been written here, because the check runs before the
 *    handler, and the raw body travels as it came, never re-encoded;
 *  - that pod cannot be reached: 503 `fiscal_holder_unreachable`, nothing written. The terminal
 *    retries under the sale's idempotency key;
 *  - a hop that arrives where the device has just left: 409 `fiscal_holder_moved`, and the client
 *    retries once. ⚠ A hop is never forwarded again.
 *
 * On one pod, and on a master, the row always names this process: nothing is ever forwarded.
 *
 * ⚠ The forwarding itself (`forwardHttp` + the hop's HMAC) lives in portal-api; `unified.ts` hands it
 * in with `setFiscalForwarding`. Without it (a test app, a script) every request runs locally.
 */

export interface FiscalTarget {
  orgId: string
  deviceId: string
  deviceNumber: string
}

export type FiscalResolver = (ctx: { user: any; params: any; body: any }) => Promise<FiscalTarget | null> | FiscalTarget | null

export interface FiscalForwarding {
  /** Send `request` to `podAddr` as a fiscal hop; null when that pod cannot be reached. */
  forward(podAddr: string, request: Request, client: string | null): Promise<Response | null>
  /** This request is a fiscal hop from another pod (verified). */
  isHop(request: Request): boolean
  /** The browser's address, for the hop. */
  clientIp(request: Request): string | null
}

let forwarding: FiscalForwarding | null = null

export function setFiscalForwarding(f: FiscalForwarding | null): void {
  forwarding = f
}

/** The raw JSON body of a declared route, kept so a forward carries it byte for byte. */
const rawBodies = new WeakMap<Request, string>()

/** Every resolver a route declares, by name: what the route-table test reads. */
export const FISCAL_RESOLVERS = new WeakSet<FiscalResolver>()

export type FiscalDecision =
  | { run: 'here' }
  | { run: 'there'; podAddr: string }
  | { refuse: 503; code: 'fiscal_holder_unreachable' }
  | { refuse: 409; code: 'fiscal_holder_moved' }

/** Where a request for this device runs (exported for the tests; the macro is its only caller). */
export async function decideFiscal(target: FiscalTarget | null, opts: { hop: boolean }): Promise<FiscalDecision> {
  if (!target) return { run: 'here' }
  if (isDeviceConnected(target.deviceId)) return { run: 'here' }
  const row = await livePresence({ orgId: target.orgId, deviceNumber: target.deviceNumber })
  if (!row || row.podId === POD_ID) {
    // Nobody holds it anywhere: the handler's own rule applies. A hop finding it gone moved on.
    return opts.hop && row?.podId !== POD_ID ? { refuse: 409, code: 'fiscal_holder_moved' } : { run: 'here' }
  }
  if (opts.hop) return { refuse: 409, code: 'fiscal_holder_moved' } // a hop is never forwarded again
  if (!row.podAddr) return { refuse: 503, code: 'fiscal_holder_unreachable' }
  return { run: 'there', podAddr: row.podAddr }
}

const MESSAGES = {
  fiscal_holder_unreachable: 'The fiscal device is held by another server process that cannot be reached right now. Nothing was done; try again.',
  fiscal_holder_moved: 'The fiscal device moved to another server process while this request was on its way. Nothing was done; try again.',
} as const

/**
 * The plugin a controller that reaches a fiscal device uses: `.use(FiscalRoute)`, then
 * `{ fiscalDevice: <resolver> }` on each such route. Its auth plugin must be used before it.
 */
export const FiscalRoute = new Elysia({ name: 'Service.FiscalRoute' }).macro({
  fiscalDevice(resolve: FiscalResolver) {
    FISCAL_RESOLVERS.add(resolve)
    return {
      // The raw body, kept for a forward. JSON only: every declared route takes JSON or nothing.
      async parse({ request, contentType }: any) {
        if (!String(contentType ?? '').includes('application/json')) return
        const text = await request.text()
        rawBodies.set(request, text)
        return text ? JSON.parse(text) : {}
      },
      async beforeHandle({ user, params, body, request, status }: any) {
        if (!user) return // the auth plugin answers 401
        const hop = !!forwarding?.isHop(request)
        let target: FiscalTarget | null = null
        try {
          target = await resolve({ user, params, body })
        } catch (e: any) {
          logger.warn({ error: e?.message, path: new URL(request.url).pathname }, 'Fiscal route: the device could not be resolved; running here')
          return
        }
        if (!forwarding) return
        const decision = await decideFiscal(target, { hop })
        if ('refuse' in decision) return status(decision.refuse, { code: decision.code, message: MESSAGES[decision.code] })
        if (decision.run === 'here') return
        const raw = rawBodies.get(request)
        const forwarded = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          ...(raw !== undefined && request.method !== 'GET' && request.method !== 'HEAD' ? { body: raw } : {}),
        })
        const res = await forwarding.forward(decision.podAddr, forwarded, forwarding.clientIp(request))
        if (!res) {
          return status(503, { code: 'fiscal_holder_unreachable', message: MESSAGES.fiscal_holder_unreachable })
        }
        return res
      },
    }
  },
})

// ── Resolvers: which device a route reaches ─────────────────────────────────────────────────

const oid = (id: unknown) => (typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null)

/** A device by its id in the URL (`/fiscal/device/:id/...`). */
export const deviceFromParams: FiscalResolver = async ({ params }) => {
  const _id = oid(params?.id)
  if (!_id) return null
  const d: any = await FiscalDevice.findOne({ _id, orgId: params.orgId }, { deviceNumber: 1, orgId: 1 }).lean().exec()
  return d ? { orgId: String(d.orgId), deviceId: String(d._id), deviceNumber: String(d.deviceNumber) } : null
}

/**
 * The device of a warehouse that a sale there would print on: the one this process holds, else
 * the one a live row holds on another pod, else none (the sale's own rule then applies).
 */
export async function deviceForWarehouse(orgId: string, warehouseId: unknown): Promise<FiscalTarget | null> {
  const wh = oid(String(warehouseId ?? ''))
  if (!wh) return null
  const devices: any[] = await FiscalDevice.find({ orgId, warehouseId: wh, isActive: true }, { deviceNumber: 1 }).lean().exec()
  const local = devices.find(d => isDeviceConnected(String(d._id)))
  const pick = local ?? (await firstHeld(orgId, devices))
  return pick ? { orgId, deviceId: String(pick._id), deviceNumber: String(pick.deviceNumber) } : null
}

async function firstHeld(orgId: string, devices: any[]): Promise<any | null> {
  for (const d of devices) if (await livePresence({ orgId, deviceNumber: String(d.deviceNumber) })) return d
  return null
}

/** Opening a session: the warehouse in the body. */
export const deviceFromBodyWarehouse: FiscalResolver = ({ params, body }) => deviceForWarehouse(params.orgId, body?.warehouseId)

/** A session's routes (`/session/:id/...`): the session's warehouse. */
export const deviceFromSession: FiscalResolver = async ({ params }) => {
  const _id = oid(params?.id)
  if (!_id) return null
  const s: any = await POSSession.findOne({ _id, orgId: params.orgId }, { warehouseId: 1 }).lean().exec()
  return s ? deviceForWarehouse(params.orgId, s.warehouseId) : null
}

/** The journal's storno: the session named in the body, else the document's own session or warehouse. */
export const deviceFromJournalDocument: FiscalResolver = async ({ params, body }) => {
  const sessionId = oid(body?.sessionId)
  if (sessionId) {
    const s: any = await POSSession.findOne({ _id: sessionId, orgId: params.orgId }, { warehouseId: 1 }).lean().exec()
    return s ? deviceForWarehouse(params.orgId, s.warehouseId) : null
  }
  const _id = oid(params?.id)
  if (!_id) return null
  const doc: any = await Invoice.findOne({ _id, orgId: params.orgId }, { 'register.sessionId': 1, 'register.warehouseId': 1, warehouseId: 1 }).lean().exec()
  if (!doc) return null
  if (doc.register?.sessionId) {
    const s: any = await POSSession.findOne({ _id: doc.register.sessionId, orgId: params.orgId }, { warehouseId: 1 }).lean().exec()
    if (s) return deviceForWarehouse(params.orgId, s.warehouseId)
  }
  return deviceForWarehouse(params.orgId, doc.register?.warehouseId ?? doc.warehouseId)
}

/**
 * `POST /invoices`: a back-office cash sale joins its author's open session (FR-21.31) and prints
 * on that session's device. The device follows from the author, not from the path, which is why
 * a resolver gets `user` and `body`. Any other document reaches no device.
 */
export const deviceFromAuthorSession: FiscalResolver = async ({ params, user, body }) => {
  if (body?.type !== 'cash_sale') return null
  const cashierId = oid(String(user?.id ?? ''))
  if (!cashierId) return null
  const s: any = await POSSession.findOne({ orgId: params.orgId, cashierId, status: 'open' }, { warehouseId: 1 }).sort({ openedAt: -1 }).lean().exec()
  return s ? deviceForWarehouse(params.orgId, s.warehouseId) : null
}
