/**
 * Fiscal Bridge WebSocket Protocol
 *
 * Enables browsers with USB-connected fiscal printers to act as serial proxies.
 * The browser connects via Web Serial API to the printer and via WebSocket to LGR.
 * LGR routes fiscal commands through the WebSocket to the browser, which relays
 * them to the serial port and returns responses.
 *
 * Protocol messages:
 *   Browser → Server:
 *     { type: 'fiscal:bridge:register', deviceNumber, orgId, warehouseId, token, takeover? }
 *     { type: 'fiscal:response', commandId, frame: base64 }
 *     { type: 'fiscal:response:error', commandId, error: string }
 *
 *   Server → Browser:
 *     { type: 'fiscal:bridge:registered', deviceNumber, manufacturer }
 *     { type: 'fiscal:bridge:error', message, code? }
 *     { type: 'fiscal:bridge:evicted', message }     (an admin took the device over)
 *     { type: 'fiscal:command', commandId, frame: base64, protocol?: 'isl', timeoutMs? }
 *     { type: 'fiscal:bridge:info', deviceNumber, device, responding }   (Eltrade, after registration)
 *
 * `protocol`/`timeoutMs` are optional: a relay that predates them ignores both and falls back
 * to its old "stop at 03h/0Ah" heuristic, which an ISL answer also satisfies.
 *
 * ## Authentication (FR-14.25)
 *
 * ⚠ This endpoint used to authenticate **nothing**. A registration named `{deviceNumber, orgId}`
 * and was believed, and a new registration **silently evicted** the till's current bridge. The
 * device number is printed on every fiscal receipt, so it is public knowledge — which made
 * "take a named shop's printer offline from anywhere" a one-line script. Bridges were also keyed
 * by `deviceNumber` alone, so two orgs holding the same number collided.
 *
 * Now:
 *  - the **register message carries a credential** and is refused without a valid one. A socket
 *    that has not authenticated within 10 s is closed. The upgrade itself stays tokenless on
 *    purpose — a credential in a URL ends up in proxy logs (S-05) — so the first message is where
 *    it belongs;
 *  - the **browser relay** authenticates with the user's JWT and needs `pos.write` in the
 *    device's own org;
 *  - bridges are keyed by **(orgId, deviceNumber)**;
 *  - an authenticated bridge is **never silently evicted**. A second opener is refused with
 *    `code: 'bridge_in_use'`; only an `admin.settings` holder asking for it explicitly may take
 *    over, which is audit-logged and tells the evicted bridge why.
 */

import { FiscalDevice } from 'db/models'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import type { IFiscalPrinter, FiscalExchangeOptions } from 'fiscal/types'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { logger } from 'services/logger'
import { randomUUID } from 'crypto'
import { verifyToken } from '../auth/verify-token.js'

const COMMAND_TIMEOUT_MS = 60000 // 60s — device may be physically printing (step-by-step mode)
/** Headroom over a driver-supplied budget, so the browser's own timeout always fires first. */
const COMMAND_TIMEOUT_MARGIN_MS = 15000

/**
 * How long a socket may stay silent before it is closed.
 *
 * The upgrade carries no credential, so until the register message arrives the connection is
 * anonymous. Without this, an unauthenticated socket could sit open forever.
 */
const AUTH_DEADLINE_MS = 10_000

/** The permission a cashier's browser needs to relay for a device. */
const BRIDGE_PERMISSION = 'pos.write'

/**
 * Which `FiscalDevice.connectionType` values a bridge may serve.
 *
 * ⚠ A set rather than a literal, because C18/FR-14.27 adds `'desktop'` — and a device bridged by
 * a desktop must then be served here WITHOUT also being offered to the Web Serial relay. One
 * owner per serial port is the whole point of the native bridge.
 */
const BRIDGEABLE_CONNECTION_TYPES = ['browser'] as const

/**
 * Registered bridge connections: `<orgId>:<deviceNumber>` → ws.
 *
 * ⚠ Keyed by the PAIR. Keyed by `deviceNumber` alone, two orgs that happen to use the same
 * device number shared one slot: registering in org A unregistered org B's printer.
 */
const bridgeConnections = new Map<string, any>()

const bridgeKey = (orgId: string, deviceNumber: string) => `${orgId}:${deviceNumber}`

/** Who is on the other end of an authenticated socket. */
type BridgePrincipal = {
  kind: 'user'
  /** For the audit trail and for telling an evicted bridge who took over. */
  label: string
  userId: string
  orgId: string
  permissions: string[]
  operatorCode?: string
  firstName?: string
  lastName?: string
}

/** Pending command responses: commandId → { resolve, reject, timer, ws } */
const pendingCommands = new Map<string, {
  resolve: (data: Buffer) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** The bridge the command went to — a disconnect must only fail its own commands. */
  ws: any
}>()

/** Device number + org stored per WS connection, keyed by `socketKey` */
const wsDeviceMap = new WeakMap<any, { deviceNumber: string; orgId: string }>()

/**
 * Per-connection authentication state, keyed by `socketKey`.
 *
 * `timer` is the unauthenticated-socket deadline; it is cleared the moment a register message
 * authenticates, and on close. `principal` is set only after a successful authentication, and is
 * what the eviction rules and the audit entry read.
 */
const wsAuthMap = new WeakMap<any, { timer: ReturnType<typeof setTimeout> | null; principal: BridgePrincipal | null }>()

/**
 * The identity of a connection. Elysia hands every event (open, message, close) a NEW
 * `ElysiaWS` wrapper around the same Bun socket, so the wrapper cannot be a map key: keyed by
 * it, the close handler never found the registration it had to undo, and a browser that went
 * away left its printer registered — the next sale then waited out the full bridge timeout.
 */
const socketKey = (ws: any) => ws?.raw ?? ws
const sameSocket = (a: any, b: any) => !!a && !!b && socketKey(a) === socketKey(b)

/**
 * Create a sendCommand function for a specific WS connection.
 * This is injected into the printer drivers.
 */
function createSendCommand(ws: any): (frame: Buffer, opts?: FiscalExchangeOptions) => Promise<Buffer> {
  return (frame: Buffer, opts?: FiscalExchangeOptions): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const commandId = randomUUID()
      const timeoutMs = opts?.timeoutMs ? opts.timeoutMs + COMMAND_TIMEOUT_MARGIN_MS : COMMAND_TIMEOUT_MS

      const timer = setTimeout(() => {
        pendingCommands.delete(commandId)
        reject(new Error(`Fiscal bridge command timeout (${timeoutMs}ms)`))
      }, timeoutMs)

      pendingCommands.set(commandId, { resolve, reject, timer, ws })

      try {
        ws.send(JSON.stringify({
          type: 'fiscal:command',
          commandId,
          frame: frame.toString('base64'),
          ...(opts?.protocol ? { protocol: opts.protocol } : {}),
          ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        }))
      } catch (e: any) {
        clearTimeout(timer)
        pendingCommands.delete(commandId)
        reject(new Error(`Failed to send fiscal command: ${e.message}`))
      }
    })
  }
}

/** Answer a refusal, with a machine-readable `code` the relay can act on. */
function refuse(ws: any, message: string, code?: string): void {
  try {
    ws.send(JSON.stringify({ type: 'fiscal:bridge:error', message, ...(code ? { code } : {}) }))
  } catch {
    /* the socket is already gone; the refusal stands either way */
  }
}

/**
 * Authenticate a register message, or refuse and close.
 *
 * ⚠ An authentication failure **closes the socket**. Answering and leaving it open would let one
 * connection guess repeatedly, and there is nothing else a socket that cannot authenticate is
 * allowed to do.
 *
 * Returns the principal, or `null` when it has already answered.
 */
async function authenticateBridge(ws: any, msg: any): Promise<BridgePrincipal | null> {
  const payload = await verifyToken(msg.token)
  if (!payload) {
    refuse(ws, 'A signed-in session is required to bridge a fiscal device.', 'unauthenticated')
    closeSocket(ws, 'unauthenticated')
    return null
  }

  // ⚠ A DESKTOP token is not a user token. C18/FR-14.26 gives the native bridge its own branch
  // here — it authenticates with the desktop access token and the device must be in that
  // desktop's `fiscalDeviceIds`. Until the `Desktop` row exists to check against (C06), such a
  // token is REFUSED rather than waved through on the user path: a desktop token carries no
  // `permissions`, so it would fail the check below anyway, but relying on that is an accident
  // waiting to be a hole the day the claim set changes.
  if (payload.aud === 'lgr-desktop') {
    refuse(ws, 'The native desktop bridge is not enabled on this server yet.', 'desktop_bridge_unsupported')
    closeSocket(ws, 'desktop_bridge_unsupported')
    return null
  }

  const orgId = payload.orgId ? String(payload.orgId) : ''
  const permissions: string[] = Array.isArray(payload.permissions) ? payload.permissions : []
  if (!orgId || !payload.id) {
    refuse(ws, 'A signed-in session is required to bridge a fiscal device.', 'unauthenticated')
    closeSocket(ws, 'unauthenticated')
    return null
  }

  if (!permissions.includes(BRIDGE_PERMISSION)) {
    refuse(ws, 'You do not have permission to connect a fiscal device.', 'forbidden')
    closeSocket(ws, 'forbidden')
    return null
  }

  const name = [payload.firstName, payload.lastName].filter(Boolean).join(' ')
  const principal: BridgePrincipal = {
    kind: 'user',
    label: name || payload.username || payload.email || 'another user',
    userId: String(payload.id),
    orgId,
    permissions,
    operatorCode: payload.operatorCode,
    firstName: payload.firstName,
    lastName: payload.lastName,
  }

  // Authenticated: the deadline no longer applies.
  const state = wsAuthMap.get(socketKey(ws))
  if (state?.timer) clearTimeout(state.timer)
  wsAuthMap.set(socketKey(ws), { timer: null, principal })
  return principal
}

/**
 * May this principal take a device away from the bridge that holds it?
 *
 * Two conditions, both required: `admin.settings`, and **asking for it explicitly**. Without the
 * flag an admin who merely opens a second POS tab would silently steal the till's port — which is
 * the behaviour this whole change exists to remove, only harder to notice because it would look
 * like a permission working as intended.
 */
function canTakeOver(principal: BridgePrincipal, msg: any): boolean {
  return msg?.takeover === true && principal.permissions.includes('admin.settings')
}

/** Take the device from the bridge that holds it, telling it why, and record that it happened. */
function evict(held: any, taker: BridgePrincipal, device: any, holder: BridgePrincipal | null): void {
  try {
    held.send(JSON.stringify({
      type: 'fiscal:bridge:evicted',
      message: `${taker.label} took over this fiscal device.`,
    }))
  } catch {
    /* it may already be gone — the takeover proceeds */
  }
  unregisterPrinter(String(device._id))
  bridgeConnections.delete(bridgeKey(String(device.orgId), String(device.deviceNumber)))
  closeSocket(held, 'taken_over')

  createAuditEntry({
    orgId: taker.orgId,
    userId: taker.userId,
    operatorCode: taker.operatorCode,
    action: 'update',
    module: 'admin',
    entityType: 'fiscalDevice',
    entityId: String(device._id),
    entityName: String(device.deviceNumber),
    // ⚠ `changes`, not a free-text note: `AuditEntry` has no `notes` field and Mongoose drops
    // unknown keys silently, so a note would have read fine here and recorded nothing.
    changes: [{ field: 'bridge', oldValue: holder?.label ?? null, newValue: taker.label }],
  })
  logger.warn(
    { deviceNumber: device.deviceNumber, orgId: taker.orgId, takenBy: taker.userId, from: holder?.userId },
    'Fiscal bridge taken over by an admin',
  )
}

/** Close a socket without letting a dead one throw out of the caller. */
function closeSocket(ws: any, reason: string): void {
  try {
    ws.close(4401, reason)
  } catch {
    try { ws.close() } catch { /* already gone */ }
  }
}

/**
 * Handle incoming WebSocket messages for the fiscal bridge.
 *
 * ⚠ Exported, with `handleOpen`/`handleClose`, so the authentication and eviction rules can be
 * driven directly from tests with a stand-in `ws` (`{ raw, send, close }`). That exercises the
 * real code — the token verification, the device lookup, the eviction decision, the audit entry —
 * rather than a mock of it, and needs no listening server. `setupFiscalBridgeWS` is a three-line
 * wiring of these three.
 */
export async function handleMessage(ws: any, raw: any) {
  let msg: any
  try {
    // Elysia may deliver the message as a pre-parsed object, string, or Buffer
    if (typeof raw === 'object' && raw !== null && !Buffer.isBuffer(raw)) {
      msg = raw // already parsed by Elysia
    } else {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    }
  } catch (e) {
    logger.warn({ error: (e as Error).message, rawType: typeof raw }, 'Fiscal bridge: invalid message')
    ws.send(JSON.stringify({ type: 'fiscal:bridge:error', message: 'Invalid JSON' }))
    return
  }

  // Deny by default: until a socket has authenticated, `register` is the only thing it may say.
  // `ping` is harmless and `fiscal:response` needs a commandId it cannot guess, but "harmless as
  // far as anyone checked" is not a rule — the rule is that an unauthenticated socket does
  // nothing.
  if (msg.type !== 'fiscal:bridge:register' && !wsAuthMap.get(socketKey(ws))?.principal) {
    refuse(ws, 'Register before sending anything else.', 'unauthenticated')
    return
  }

  switch (msg.type) {
    case 'fiscal:bridge:register': {
      const { deviceNumber, warehouseId } = msg
      logger.info({ deviceNumber, warehouseId }, 'Fiscal bridge registration request received')
      if (!deviceNumber) {
        refuse(ws, 'deviceNumber required')
        return
      }

      // ── Authenticate BEFORE anything else ────────────────────────────────────────────────
      const principal = await authenticateBridge(ws, msg)
      if (!principal) return // authenticateBridge has already answered and closed
      const orgId = principal.orgId

      // ⚠ The org comes from the TOKEN, never from the message. A caller naming another org's id
      // would otherwise pick the device to look up, and the only thing standing between that and
      // another tenant's printer would be the token check we are already doing — so take the org
      // from the credential and let a mismatched `msg.orgId` be a loud refusal rather than a
      // silently ignored field.
      if (msg.orgId && String(msg.orgId) !== orgId) {
        refuse(ws, 'The signed-in organization does not match the requested one', 'org_mismatch')
        return
      }

      // Verify device exists in DB
      const device = await FiscalDevice.findOne({
        deviceNumber,
        orgId,
        connectionType: { $in: BRIDGEABLE_CONNECTION_TYPES },
        isActive: true,
      }).exec()

      if (!device) {
        refuse(ws, `No active browser fiscal device found: ${deviceNumber}`, 'device_not_found')
        return
      }

      const key = bridgeKey(orgId, deviceNumber)
      const held = bridgeConnections.get(key)

      // ── No silent eviction ───────────────────────────────────────────────────────────────
      // A second opener used to unregister the first without telling anybody, which is how a
      // shop's printer went offline mid-day. Re-registering the SAME socket stays idempotent.
      if (held && !sameSocket(held, ws)) {
        const holder = wsAuthMap.get(socketKey(held))?.principal
        if (!canTakeOver(principal, msg)) {
          refuse(
            ws,
            holder
              ? `This device is already connected by ${holder.label}.`
              : 'This device is already connected in another tab, window or program.',
            'bridge_in_use',
          )
          return
        }
        evict(held, principal, device, holder)
      }

      // Register this WS as the bridge
      bridgeConnections.set(key, ws)
      wsDeviceMap.set(socketKey(ws), { deviceNumber, orgId })

      // Create the correct printer type based on manufacturer
      const sendCommand = createSendCommand(ws)
      const deviceIdStr = String(device._id)
      const manufacturer = device.manufacturer || 'datecs'
      const printer = createBridgePrinter(manufacturer, sendCommand, deviceIdStr)
      registerPrinter(deviceIdStr, printer)
      logger.info({ deviceId: deviceIdStr, manufacturer, printerType: printer.constructor.name }, 'Printer instance created')

      // Update device status
      await FiscalDevice.findByIdAndUpdate(device._id, {
        status: 'online',
        lastCommunicationAt: new Date(),
      }).exec()

      ws.send(JSON.stringify({ type: 'fiscal:bridge:registered', deviceNumber, manufacturer }))
      logger.info({ deviceNumber, deviceId: String(device._id) }, 'Fiscal bridge registered via WebSocket')

      // The Eltrade answers a harmless identity read, so check right away that the port the
      // cashier picked really is this device and that it is listening — rather than finding
      // out on the first sale. Sent after 'registered': the browser switches to relaying on it.
      if (manufacturer === 'eltrade') void probeBridgeDevice(ws, device, printer)
      break
    }

    case 'fiscal:response': {
      const { commandId, frame } = msg
      const pending = pendingCommands.get(commandId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingCommands.delete(commandId)
        pending.resolve(Buffer.from(frame, 'base64'))
      }
      break
    }

    case 'fiscal:response:error': {
      const { commandId, error } = msg
      const pending = pendingCommands.get(commandId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingCommands.delete(commandId)
        pending.reject(new Error(error || 'Browser fiscal bridge error'))
      }
      break
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
      break
    }

    default:
      logger.warn({ msgType: msg.type, keys: Object.keys(msg) }, 'Fiscal bridge: unknown message type')
      ws.send(JSON.stringify({ type: 'fiscal:bridge:error', message: `Unknown message type: ${msg.type}` }))
  }
}

/**
 * Printer driver for a browser-bridged device. Datecs/Daisy keep the historical
 * WebSocketFiscalPrinter; Tremol and Eltrade have protocol-specific drivers.
 */
export function createBridgePrinter(
  manufacturer: string,
  sendCommand: (frame: Buffer, opts?: FiscalExchangeOptions) => Promise<Buffer>,
  deviceId: string,
): IFiscalPrinter {
  switch (manufacturer) {
    case 'tremol':
      return new WsTremolFiscalPrinter(sendCommand, deviceId)
    case 'eltrade':
      return new EltradeFiscalPrinter(sendCommand, deviceId)
    default:
      return new WebSocketFiscalPrinter(sendCommand, deviceId)
  }
}

/**
 * Read the device's identity and state once the bridge is up and tell the browser what it is
 * talking to. Everything here is advisory — a failure is reported, never thrown.
 */
async function probeBridgeDevice(ws: any, device: any, printer: IFiscalPrinter): Promise<void> {
  const deviceNumber = String(device.deviceNumber)
  try {
    const status = await printer.getStatus()
    const serial = status.serialNumber?.toUpperCase()
    const info = {
      type: 'fiscal:bridge:info',
      deviceNumber,
      responding: status.connected,
      device: {
        model: status.model,
        serialNumber: status.serialNumber,
        fiscalMemoryNumber: status.fiscalMemoryNumber,
        firmwareVersion: status.firmwareVersion,
        fiscalized: status.fiscalized,
        paperPresent: status.paperPresent,
        serialMismatch: !!serial && serial !== deviceNumber.toUpperCase(),
        errors: status.errors || [],
        warnings: status.warnings || [],
      },
    }
    if (sameSocket(bridgeConnections.get(bridgeKey(String(device.orgId), deviceNumber)), ws)) {
      ws.send(JSON.stringify(info))
    }
    if (status.connected) {
      await FiscalDevice.updateOne(
        { _id: device._id },
        { lastCommunicationAt: new Date(), ...(status.firmwareVersion ? { firmwareVersion: status.firmwareVersion } : {}) },
      ).exec()
    }
    logger.info({ deviceNumber, ...info.device, responding: status.connected }, 'Fiscal bridge device probed')
  } catch (e: any) {
    logger.warn({ deviceNumber, error: e?.message }, 'Fiscal bridge device probe failed')
  }
}

/**
 * Handle WS disconnect — clean up bridge registration.
 */
export async function handleClose(ws: any) {
  // Always drop the auth state, registered or not — an unauthenticated socket that goes away
  // must not leave its deadline timer holding the event loop open.
  const auth = wsAuthMap.get(socketKey(ws))
  if (auth?.timer) clearTimeout(auth.timer)
  wsAuthMap.delete(socketKey(ws))

  const entry = wsDeviceMap.get(socketKey(ws))
  if (!entry) return
  const { deviceNumber, orgId } = entry
  const key = bridgeKey(orgId, deviceNumber)

  // A newer registration for the same device may already own the slot — leave it alone.
  if (sameSocket(bridgeConnections.get(key), ws)) bridgeConnections.delete(key)
  wsDeviceMap.delete(socketKey(ws))

  // Reject the pending commands that went through THIS bridge (another device's bridge may
  // be mid-command right now).
  for (const [cmdId, pending] of pendingCommands) {
    if (!sameSocket(pending.ws, ws)) continue
    clearTimeout(pending.timer)
    pending.reject(new Error('Fiscal bridge disconnected'))
    pendingCommands.delete(cmdId)
  }

  // Find device and unregister printer — unless the device has already re-registered.
  if (!bridgeConnections.has(key)) {
    try {
      const device = await FiscalDevice.findOne({
        deviceNumber,
        orgId,
        connectionType: { $in: BRIDGEABLE_CONNECTION_TYPES },
      }).exec()
      if (device) {
        unregisterPrinter(String(device._id))
        await FiscalDevice.findByIdAndUpdate(device._id, { status: 'offline' }).exec()
      }
    } catch (e: any) {
      logger.warn({ deviceNumber, error: e.message }, 'Error cleaning up fiscal bridge')
    }
  }

  logger.info({ deviceNumber }, 'Fiscal bridge disconnected')
}

/**
 * Set up the fiscal bridge WebSocket endpoint on the Elysia app.
 */
/**
 * A socket has opened. It is anonymous until its first message, so start the deadline.
 *
 * ⚠ The upgrade carries no credential on purpose: a token in a URL lands in ingress and proxy
 * logs, which is S-05's lesson. The credential is the register message, and this timer is what
 * stops an unauthenticated socket sitting open until the process restarts.
 */
export function handleOpen(ws: any): void {
  logger.info('Fiscal bridge WebSocket connected, waiting for registration...')
  const timer = setTimeout(() => {
    if (wsAuthMap.get(socketKey(ws))?.principal) return
    logger.warn('Fiscal bridge socket closed: never authenticated')
    refuse(ws, 'Registration timed out.', 'unauthenticated')
    closeSocket(ws, 'unauthenticated')
  }, AUTH_DEADLINE_MS)
  wsAuthMap.set(socketKey(ws), { timer, principal: null })
}

export function setupFiscalBridgeWS(app: any): void {
  app.ws('/ws/fiscal-bridge', {
    open(ws: any) {
      handleOpen(ws)
    },
    message(ws: any, message: any) {
      handleMessage(ws, message)
    },
    close(ws: any) {
      handleClose(ws)
    },
  })

  logger.info('Fiscal bridge WebSocket endpoint registered at /ws/fiscal-bridge')
}

/** How long an unauthenticated socket is tolerated — exported so a test need not hardcode it. */
export { AUTH_DEADLINE_MS }

// `isBridgeConnected(deviceNumber)` used to live here with no callers — the live `connected` flag
// the POS reads comes from `isDeviceConnected(deviceId)` in the printer registry, not from this
// map. It was removed rather than re-keyed: an unused export that takes the wrong key is a trap
// for whoever reaches for it next.

/**
 * Swap the driver behind a live bridge — after an admin corrects the device's manufacturer.
 * Without it the old driver keeps speaking the old protocol until the cashier reconnects.
 * Returns false when no bridge is connected for the device.
 */
export function rebindBridgePrinter(
  deviceId: string,
  orgId: string,
  deviceNumber: string,
  manufacturer: string,
): boolean {
  const ws = bridgeConnections.get(bridgeKey(orgId, deviceNumber))
  if (!ws) return false
  registerPrinter(deviceId, createBridgePrinter(manufacturer, createSendCommand(ws), deviceId))
  logger.info({ deviceId, deviceNumber, manufacturer }, 'Fiscal bridge printer rebound to a new manufacturer')
  return true
}
