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
import { disconnectDevice, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import type { IFiscalPrinter, FiscalExchangeOptions } from 'fiscal/types'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { requestVia } from '../front/front-guard.js'
import { logger } from 'services/logger'
import { randomUUID } from 'crypto'
import { verifyToken } from '../auth/verify-token.js'
import {
  DesktopError,
  loadActiveDesktop,
  verifyDesktopToken,
  type DesktopTokenClaims,
} from 'services/biz/desktop/desktop.service'
import { movedFor } from 'services/biz/desktop/repoint.service'
import type { IDesktop } from 'db/models'
import {
  HEARTBEAT_MS,
  POD_ID as POD_ID_SELF,
  claimPresence,
  heartbeatPresence,
  livePresence,
  releasePresence,
  requestEviction,
  type FiscalHolder,
} from 'services/biz/fiscal-presence.service'
import { podAddr } from '../tunnel/pod.js'

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
 * Which `FiscalDevice.connectionType` each kind of bridge may serve (FR-14.27).
 *
 * ⚠ **Disjoint, and that is the whole point.** One owner per serial port: a `desktop` device is
 * never offered to the Web Serial relay, and a `browser` device is never served to a native
 * bridge. Because the device LOOKUP filters on this, a browser asking for a desktop-bridged
 * device does not merely lose a race — it never finds the row, so there is no window in which
 * both could hold the port, and no code path (the admin takeover included, which is only reached
 * after the lookup has matched) can put them on the same device.
 */
const BRIDGEABLE_CONNECTION_TYPES = {
  user: ['browser'],
  desktop: ['desktop'],
} as const satisfies Record<BridgeKind, readonly string[]>

/** Every type some bridge can serve — for the close path, which has no principal left to ask. */
const ALL_BRIDGEABLE_TYPES = [
  ...BRIDGEABLE_CONNECTION_TYPES.user,
  ...BRIDGEABLE_CONNECTION_TYPES.desktop,
]

/**
 * Registered bridge connections: `<orgId>:<deviceNumber>` → ws.
 *
 * ⚠ Keyed by the PAIR. Keyed by `deviceNumber` alone, two orgs that happen to use the same
 * device number shared one slot: registering in org A unregistered org B's printer.
 */
const bridgeConnections = new Map<string, any>()

const bridgeKey = (orgId: string, deviceNumber: string) => `${orgId}:${deviceNumber}`

/** The two kinds of thing that can hold a fiscal device's port. */
type BridgeKind = 'user' | 'desktop'

/**
 * Who is on the other end of an authenticated socket.
 *
 * ⚠ A **discriminated union**, not one shape with optional fields. A desktop has no
 * `permissions`, and the one rule that reads them — `canTakeOver` — must be unable to be handed a
 * desktop and quietly see `[]`. Narrowing on `kind` is what makes "a desktop can never evict
 * anybody" a thing the compiler agrees with rather than an accident of an empty array.
 */
type BridgePrincipal = UserPrincipal | DesktopPrincipal

type UserPrincipal = {
  kind: 'user'
  /** For the audit trail and for telling an evicted bridge who took over. */
  label: string
  userId: string
  orgId: string
  permissions: string[]
  operatorCode?: string
  firstName?: string
  lastName?: string
  /** FR-20.48: where its socket came from, for the audit entry of a takeover (no request is current then). */
  via?: string
  /** FR-24.49: this browser tab's id, the same across its reconnects and reloads. Absent from old relays. */
  instanceId?: string
}

/** A registered LGR Desktop relaying its till's own serial port (FR-14.26). */
type DesktopPrincipal = {
  kind: 'desktop'
  /** The desktop's name, as the POS renders it: "connected via Till 2". */
  label: string
  desktopId: string
  orgId: string
  /**
   * The devices an admin assigned to this desktop, as strings.
   *
   * ⚠ Read from the ROW on every registration, never from the token. The assignment is what an
   * admin changes on the Desktops page, and a token minted before that change must not carry a
   * stale list — which is also why the desktop re-reads it at enrollment and on `report_self`.
   */
  deviceIds: string[]
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
const wsDeviceMap = new WeakMap<any, { deviceNumber: string; orgId: string; deviceId?: string }>()

/** FR-24.45: each socket's presence connection id, keyed by `socketKey`. */
const wsConnIds = new WeakMap<any, string>()
const connIdOf = (ws: any): string => {
  let id = wsConnIds.get(socketKey(ws))
  if (!id) {
    id = randomUUID()
    wsConnIds.set(socketKey(ws), id)
  }
  return id
}

/** The presence row's view of a principal. */
function holderFor(principal: BridgePrincipal): FiscalHolder {
  return principal.kind === 'desktop'
    ? { kind: 'desktop', label: principal.label, desktopId: principal.desktopId }
    : { kind: 'user', label: principal.label, userId: principal.userId, ...(principal.instanceId ? { instanceId: principal.instanceId } : {}) }
}

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
  /**
   * ⚠ **The desktop branch is tried FIRST, and it is tried by VERIFYING, not by inspecting.**
   *
   * The two credentials are signed with different secrets (`DESKTOP_TOKEN_SECRET` vs
   * `JWT_SECRET`, deliberately separate), so each verifier rejects the other's tokens outright.
   * Routing on an *unverified* claim — reading `aud` out of the payload before checking a
   * signature, which is what the C02 placeholder did — means the caller picks which verifier
   * runs. Here the signature picks, and an attacker cannot choose.
   */
  const desktopClaims = verifyDesktopToken(msg.token)
  if (desktopClaims) return authenticateDesktopBridge(ws, desktopClaims)

  const payload = await verifyToken(msg.token)
  if (!payload) {
    refuse(ws, 'A signed-in session is required to bridge a fiscal device.', 'unauthenticated')
    closeSocket(ws, 'unauthenticated')
    return null
  }

  // ⚠ Belt and braces. If the two secrets are ever misconfigured to the same value, a desktop
  // token would verify here too — and a desktop has no `permissions`, so it would fail the check
  // below and be refused as `forbidden`, which reads like a permission problem on a till. Refuse
  // it for what it is instead, and never on the user path.
  if (payload.aud === 'lgr-desktop') {
    refuse(ws, 'A desktop credential cannot be used as a browser session.', 'unauthenticated')
    closeSocket(ws, 'unauthenticated')
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
  const principal: UserPrincipal = {
    kind: 'user',
    label: name || payload.username || payload.email || 'another user',
    userId: String(payload.id),
    orgId,
    permissions,
    operatorCode: payload.operatorCode,
    firstName: payload.firstName,
    lastName: payload.lastName,
    via: requestVia(ws?.data?.request),
    ...(typeof msg.instanceId === 'string' && msg.instanceId.length <= 100 ? { instanceId: msg.instanceId } : {}),
  }

  // Authenticated: the deadline no longer applies.
  return accept(ws, principal)
}

/**
 * Authenticate the native bridge (FR-14.26).
 *
 * ⚠ **The row is re-read, exactly as every desktop HTTP route re-reads it.** A valid signature on
 * an unexpired token is not enough: the row is the revocation list, so revoking a till's desktop
 * must stop it bridging on its next registration whatever its token's remaining life, and a
 * rotated key must invalidate the tokens already issued. A socket that skipped this would be the
 * one place in the system where revocation did not take effect.
 */
async function authenticateDesktopBridge(
  ws: any,
  claims: DesktopTokenClaims,
): Promise<BridgePrincipal | null> {
  let desktop: IDesktop
  try {
    desktop = await loadActiveDesktop(claims)
  } catch (e) {
    // `desktop_revoked` / `key_rotated` — the shell acts differently on each (FR-14.22), so the
    // code is passed through rather than flattened into `unauthenticated`.
    const code = e instanceof DesktopError ? e.code : 'unauthenticated'
    const message = e instanceof DesktopError ? e.message : 'A desktop credential is required.'
    refuse(ws, message, code)
    closeSocket(ws, code)
    return null
  }

  // FR-20.82 (P3-6b): the org moved to its master, which holds the till's port now. Refused before
  // anything of the org is written here (a bridge marks its device online), and said why.
  const moved = await movedFor(String(desktop._id), String(desktop.orgId))
  if (moved) {
    refuse(ws, `This organisation is now on its own server (${moved.name}).`, 'org_moved')
    closeSocket(ws, 'org_moved')
    return null
  }

  const principal: DesktopPrincipal = {
    kind: 'desktop',
    label: desktop.name || 'an LGR Desktop',
    desktopId: String(desktop._id),
    orgId: String(desktop.orgId),
    deviceIds: (desktop.fiscalDeviceIds ?? []).map(String),
  }
  return accept(ws, principal)
}

/** Record a successful authentication and stand the unauthenticated-socket deadline down. */
function accept(ws: any, principal: BridgePrincipal): BridgePrincipal {
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
 *
 * ⚠ **A desktop can never take over, and says so by its type.** The narrowing is the rule: a till
 * that reconnects must not be able to shoulder another till off the port, and the two cannot
 * legitimately contend for one anyway — a `desktop` device is pinned to its desktop by the
 * assignment, and by `bridgeDesktopId` when an admin sets one.
 */
function canTakeOver(principal: BridgePrincipal, msg: any): boolean {
  if (principal.kind !== 'user') return false
  return msg?.takeover === true && principal.permissions.includes('admin.settings')
}

/**
 * Take the device from the bridge that holds it, telling it why, and record that it happened.
 *
 * ⚠ `taker` is a `UserPrincipal`, not a `BridgePrincipal`: only an admin can evict (`canTakeOver`
 * narrows), and the audit entry needs a `userId` — a desktop has none, and `userId: undefined` on
 * an audit row is worse than no row at all.
 */
function evict(held: any, taker: UserPrincipal, device: any, holder: BridgePrincipal | null): void {
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
  auditTakeover(taker, device, holder?.label ?? null, holder)
}

/**
 * Let a socket of this pod go without touching its presence row, which is no longer its own: the
 * same principal reconnected, an admin took the device over on another pod, or a revocation was
 * decided there (FR-24.48). Tells the client why when there is something to tell.
 */
function dropLocal(held: any, reason: string, message: string | null): void {
  if (message) {
    try {
      held.send(JSON.stringify({ type: 'fiscal:bridge:evicted', message }))
    } catch { /* already gone */ }
  }
  const entry = wsDeviceMap.get(socketKey(held))
  if (entry) {
    const key = bridgeKey(entry.orgId, entry.deviceNumber)
    if (sameSocket(bridgeConnections.get(key), held)) {
      bridgeConnections.delete(key)
      if (entry.deviceId) unregisterPrinter(entry.deviceId)
    }
  }
  closeSocket(held, reason)
}

/** The audit entry of a takeover, wherever the evicted bridge was (FR-24.48). */
function auditTakeover(taker: UserPrincipal, device: any, fromLabel: string | null, holder: BridgePrincipal | null = null): void {
  createAuditEntry({
    orgId: taker.orgId,
    userId: taker.userId,
    operatorCode: taker.operatorCode,
    action: 'update',
    module: 'admin',
    entityType: 'fiscalDevice',
    entityId: String(device._id),
    entityName: String(device.deviceNumber),
    via: taker.via,
    // ⚠ `changes`, not a free-text note: `AuditEntry` has no `notes` field and Mongoose drops
    // unknown keys silently, so a note would have read fine here and recorded nothing.
    changes: [{ field: 'bridge', oldValue: fromLabel, newValue: taker.label }],
  })
  logger.warn(
    {
      deviceNumber: device.deviceNumber,
      orgId: taker.orgId,
      takenBy: taker.userId,
      from: holder?.kind === 'user' ? holder.userId : holder?.kind === 'desktop' ? holder.desktopId : undefined,
      fromKind: holder?.kind,
    },
    'Fiscal bridge taken over by an admin',
  )
}

/**
 * May this desktop bridge this device? (FR-14.26)
 *
 * Two independent conditions, both of which must hold:
 *
 *  1. the device is in the desktop's **assignment** — what an admin set on the Desktops page, and
 *     the authority for "this till owns that printer";
 *  2. `connectionParams.bridgeDesktopId`, **when set**, names this desktop.
 *
 * ⚠ (2) is a narrowing, never a widening: a `bridgeDesktopId` pointing at desktop A does not let
 * A bridge a device that is not assigned to it. A shop with one till leaves it unset and relies
 * on (1); a shop with two tills on one counter pins the device so a reinstall of the wrong
 * machine cannot claim it.
 */
function mayDesktopBridge(principal: DesktopPrincipal, device: any): boolean {
  if (!principal.deviceIds.includes(String(device._id))) return false
  const pinned = device.connectionParams?.bridgeDesktopId
  return !pinned || String(pinned) === principal.desktopId
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

      // ⚠ The device must be of a type THIS kind of bridge may serve. The filter is what keeps
      // the two bridges off one port: a browser never finds a `desktop` device here, and a
      // desktop never finds a `browser` one.
      const device = await FiscalDevice.findOne({
        deviceNumber,
        orgId,
        connectionType: { $in: BRIDGEABLE_CONNECTION_TYPES[principal.kind] },
        isActive: true,
      }).exec()

      if (!device) {
        // Within an authenticated org, saying WHY is worth more than uniformity: "it exists but
        // a till owns its port" is the one answer that stops a cashier retrying for ten minutes.
        // Nothing here is an oracle — the caller already proved it belongs to this org.
        const otherKind = await FiscalDevice.exists({ deviceNumber, orgId, isActive: true })
        if (otherKind && principal.kind === 'user') {
          refuse(
            ws,
            'This fiscal device is bridged by an LGR Desktop, so a browser cannot open its port.',
            'bridged_by_desktop',
          )
          return
        }
        refuse(
          ws,
          principal.kind === 'desktop'
            ? `No active desktop-bridged fiscal device found: ${deviceNumber}`
            : `No active browser fiscal device found: ${deviceNumber}`,
          'device_not_found',
        )
        return
      }

      // ── The assignment is the desktop's authority over the device (FR-14.26) ─────────────
      if (principal.kind === 'desktop' && !mayDesktopBridge(principal, device)) {
        refuse(
          ws,
          'This fiscal device is not assigned to this desktop.',
          'device_not_assigned',
        )
        closeSocket(ws, 'device_not_assigned')
        return
      }

      const key = bridgeKey(orgId, deviceNumber)
      const held = bridgeConnections.get(key)
      const deviceIdStr = String(device._id)

      // ── No silent eviction, on any pod (FR-24.45) ────────────────────────────────────────
      // A second opener used to unregister the first without telling anybody, which is how a
      // shop's printer went offline mid-day. The presence row decides now, so a bridge held on a
      // sibling pod counts too. Re-registering the SAME socket stays idempotent; the same tab or
      // desktop reconnecting takes its own row over; a dead row (20 s) is anyone's.
      // ⚠ `principal.kind === 'user'` restates what `canTakeOver` already guarantees, because the
      // compiler cannot narrow through a boolean helper and `evict` needs a `userId`. The two must
      // agree: a desktop never evicts.
      const takeover = principal.kind === 'user' && canTakeOver(principal, msg)
      const claim = await claimPresence(
        { orgId, deviceNumber: String(deviceNumber), deviceId: deviceIdStr },
        holderFor(principal),
        { connId: connIdOf(ws), podAddr: podAddr() },
        { takeover },
      )
      if (!claim.ok) {
        refuse(ws, `This device is already connected by ${claim.holder.label}.`, 'bridge_in_use')
        return
      }
      if (held && !sameSocket(held, ws)) {
        const holder = wsAuthMap.get(socketKey(held))?.principal ?? null
        if (takeover && principal.kind === 'user') {
          evict(held, principal, device, holder)
        } else {
          // The same principal reconnected, or the old socket's row had died: it is stale here.
          dropLocal(held, 'replaced', null)
        }
      } else if (takeover && principal.kind === 'user' && claim.previous && claim.previous.podId !== POD_ID_SELF) {
        // Held on a sibling pod: its next heartbeat sees the row is no longer its own and lets go.
        auditTakeover(principal, device, claim.previous.label)
      }

      // Register this WS as the bridge
      bridgeConnections.set(key, ws)
      wsDeviceMap.set(socketKey(ws), { deviceNumber, orgId, deviceId: deviceIdStr })

      // Create the correct printer type based on manufacturer
      const sendCommand = createSendCommand(ws)
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

  // FR-24.45: let go of the presence row, only while it is still this socket's. A client that has
  // already reconnected (here or on another pod) owns it now, and its old socket's late close must
  // not take that away.
  try {
    await releasePresence({ orgId, deviceNumber: String(deviceNumber) }, connIdOf(ws))
  } catch (e: any) {
    logger.warn({ deviceNumber, error: e?.message }, 'Fiscal bridge: could not release its presence row')
  }

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
      // ⚠ Every bridgeable type, not the registering principal's: the socket is gone, so there is
      // no principal left to ask. Filtering to `browser` here would leave a desktop-bridged
      // device registered after its till disconnected, and the next sale would wait out the full
      // bridge timeout against a printer nobody holds.
      const device = await FiscalDevice.findOne({
        deviceNumber,
        orgId,
        connectionType: { $in: ALL_BRIDGEABLE_TYPES },
      }).exec()
      if (device) {
        unregisterPrinter(String(device._id))
        // Offline only when nobody holds it on any pod: it may already be reconnected elsewhere.
        if (!(await livePresence({ orgId, deviceNumber: String(deviceNumber) }))) {
          await FiscalDevice.findByIdAndUpdate(device._id, { status: 'offline' }).exec()
        }
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

/**
 * FR-24.45/24.48: heartbeat the rows this pod holds, and let go of every bridge whose row is no
 * longer its own: taken over on another pod, revoked there, or released. Runs every `HEARTBEAT_MS`
 * until `closeAllBridges` stops it. Exported for the tests.
 */
export async function presenceTick(): Promise<void> {
  const held: Array<{ orgId: string; deviceNumber: string; connId: string; ws: any }> = []
  for (const ws of bridgeConnections.values()) {
    const entry = wsDeviceMap.get(socketKey(ws))
    if (entry) held.push({ orgId: entry.orgId, deviceNumber: String(entry.deviceNumber), connId: connIdOf(ws), ws })
  }
  if (!held.length) return
  for (const lost of await heartbeatPresence(held)) {
    const h = held.find(x => x.connId === lost.connId)
    if (!h) continue
    if (lost.reason === 'released') {
      // The row went without anyone taking it (a manual cleanup): claim it back rather than drop a working till.
      const entry = wsDeviceMap.get(socketKey(h.ws))
      const principal = wsAuthMap.get(socketKey(h.ws))?.principal
      if (entry?.deviceId && principal) {
        const again = await claimPresence(
          { orgId: h.orgId, deviceNumber: h.deviceNumber, deviceId: entry.deviceId },
          holderFor(principal),
          { connId: h.connId, podAddr: podAddr() },
        )
        if (again.ok) continue
      }
    }
    const message = lost.reason === 'taken_over'
      ? `${lost.by ?? 'Another bridge'} took over this fiscal device.`
      : lost.reason === 'desktop_revoked'
        ? 'This desktop has been removed from the organization.'
        : 'This fiscal device was taken over.'
    logger.warn({ deviceNumber: h.deviceNumber, orgId: h.orgId, reason: lost.reason }, 'Fiscal bridge let go: its presence row is no longer its own')
    dropLocal(h.ws, lost.reason === 'taken_over' ? 'taken_over' : String(lost.reason), message)
    await handleClose(h.ws)
  }
}

/**
 * FR-24.45: devices THIS pod opened itself over TCP (`kind: 'server'`). They hold a row like any
 * bridge, so a sibling pod does not open the same device and the device lists say who has it.
 */
const serverHolds = new Map<string, { orgId: string; deviceNumber: string; deviceId: string; connId: string }>()

/** Claim a device the server is about to open. Null when it is free; the holder's label when not. */
export async function holdServerDevice(d: { orgId: string; deviceNumber: string; deviceId: string; label: string }): Promise<string | null> {
  const key = bridgeKey(d.orgId, d.deviceNumber)
  const connId = serverHolds.get(key)?.connId ?? randomUUID()
  const claim = await claimPresence(
    { orgId: d.orgId, deviceNumber: d.deviceNumber, deviceId: d.deviceId },
    { kind: 'server', label: d.label },
    { connId, podAddr: podAddr() },
  )
  if (!claim.ok) return claim.holder.label
  serverHolds.set(key, { orgId: d.orgId, deviceNumber: d.deviceNumber, deviceId: d.deviceId, connId })
  return null
}

/** Let go of a device the server opened. */
export async function releaseServerDevice(orgId: string, deviceNumber: string): Promise<void> {
  const key = bridgeKey(orgId, deviceNumber)
  const hold = serverHolds.get(key)
  if (!hold) return
  serverHolds.delete(key)
  await releasePresence({ orgId, deviceNumber }, hold.connId).catch(() => undefined)
}

async function heartbeatServerHolds(): Promise<void> {
  if (!serverHolds.size) return
  const holds = [...serverHolds.values()]
  for (const lost of await heartbeatPresence(holds)) {
    const hold = holds.find(h => h.connId === lost.connId)
    if (!hold) continue
    serverHolds.delete(bridgeKey(hold.orgId, hold.deviceNumber))
    logger.warn({ deviceNumber: hold.deviceNumber, reason: lost.reason }, 'A server-opened fiscal device was taken by another holder')
    await disconnectDevice(hold.deviceId).catch(() => undefined)
  }
}

let heartbeat: ReturnType<typeof setInterval> | null = null

/**
 * FR-24.44: at a graceful stop, once no fiscal operation is in flight, close every bridge with 1012
 * ("service restart"): clients reconnect at once, to a pod that takes connections. The presence rows
 * go first, so whichever pod the till lands on can claim the device straight away.
 */
export async function closeAllBridges(code = 1012): Promise<number> {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  const sockets = [...bridgeConnections.values()]
  for (const ws of sockets) {
    const entry = wsDeviceMap.get(socketKey(ws))
    if (entry) {
      try {
        await releasePresence({ orgId: entry.orgId, deviceNumber: String(entry.deviceNumber) }, connIdOf(ws))
      } catch { /* the row dies in 20 s anyway */ }
    }
    try {
      ws.close(code, 'server_restart')
    } catch { /* already gone */ }
    await handleClose(ws)
  }
  for (const hold of [...serverHolds.values()]) await releaseServerDevice(hold.orgId, hold.deviceNumber)
  if (sockets.length) logger.info({ closed: sockets.length, code }, 'Fiscal bridges closed for the stop: clients reconnect elsewhere')
  return sockets.length
}

export function setupFiscalBridgeWS(app: any): void {
  heartbeat ??= setInterval(() => {
    presenceTick().catch(e => logger.warn({ error: e?.message }, 'Fiscal presence heartbeat failed'))
    heartbeatServerHolds().catch(e => logger.warn({ error: e?.message }, 'Fiscal presence heartbeat failed (server devices)'))
  }, HEARTBEAT_MS)
  ;(heartbeat as any).unref?.()

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

/** What is holding a device's port right now, for the POS's "connected via" label (FR-14.27). */
export interface BridgeHolder {
  kind: BridgeKind
  /** The desktop's name, or the cashier's — what the POS prints after "connected via". */
  label: string
  /** Set only for a desktop, so the UI can link to the Desktops page. */
  desktopId?: string
}

/**
 * Who holds this device's bridge, or `null`.
 *
 * ⚠ Read from the **live socket map**, not from `FiscalDevice.status`: the stored status is the
 * last thing written and survives a process restart that dropped every socket. This is the same
 * distinction `isDeviceConnected` draws, and the POS needs both — "is anything holding it" and
 * "what".
 */
export function bridgeHolder(orgId: string, deviceNumber: string): BridgeHolder | null {
  const ws = bridgeConnections.get(bridgeKey(orgId, deviceNumber))
  if (!ws) return null
  const principal = wsAuthMap.get(socketKey(ws))?.principal
  if (!principal) return null
  return principal.kind === 'desktop'
    ? { kind: 'desktop', label: principal.label, desktopId: principal.desktopId }
    : { kind: 'user', label: principal.label }
}

/**
 * Stop the bridge a desktop holds — revocation's teardown (FR-14.22, C11).
 *
 * ⚠ The shell stops its own bridge when it learns it was revoked, but it may be offline, mid-print
 * or simply not listening. Revocation must not depend on the till cooperating, so the server drops
 * the socket from its side too.
 *
 * Returns how many bridges were stopped.
 */
export async function stopDesktopBridges(desktopId: string): Promise<number> {
  const doomed = [...bridgeConnections.values()].filter(ws => {
    const principal = wsAuthMap.get(socketKey(ws))?.principal
    return principal?.kind === 'desktop' && principal.desktopId === desktopId
  })

  for (const ws of doomed) {
    try {
      ws.send(JSON.stringify({
        type: 'fiscal:bridge:evicted',
        message: 'This desktop has been removed from the organization.',
      }))
    } catch { /* already gone — the teardown proceeds */ }
    closeSocket(ws, 'desktop_revoked')
    // ⚠ `handleClose` explicitly, rather than relying on the close event: a socket that is
    // already dead fires nothing, and the point of this function is that revocation does not
    // depend on the till cooperating. It is the same teardown the disconnect path uses — the
    // printer is unregistered and the device marked offline — so a sale cannot be routed to a
    // revoked till even if its socket never reports closing.
    await handleClose(ws)
  }

  // FR-24.48: a bridge this desktop holds on ANOTHER pod lets go on that pod's next heartbeat. The
  // server still drops the socket itself there; nothing waits for the till to cooperate.
  try {
    await requestEviction({ desktopId }, 'desktop_revoked')
  } catch (e: any) {
    logger.warn({ desktopId, error: e?.message }, 'Could not ask other pods to drop a revoked desktop')
  }

  if (doomed.length) logger.warn({ desktopId, stopped: doomed.length }, 'Fiscal bridges stopped: desktop revoked')
  return doomed.length
}

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
