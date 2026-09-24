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
 *     { type: 'fiscal:bridge:register', deviceNumber, orgId, warehouseId }
 *     { type: 'fiscal:response', commandId, frame: base64 }
 *     { type: 'fiscal:response:error', commandId, error: string }
 *
 *   Server → Browser:
 *     { type: 'fiscal:bridge:registered', deviceNumber, manufacturer }
 *     { type: 'fiscal:bridge:error', message }
 *     { type: 'fiscal:command', commandId, frame: base64, protocol?: 'isl', timeoutMs? }
 *     { type: 'fiscal:bridge:info', deviceNumber, device, responding }   (Eltrade, after registration)
 *
 * `protocol`/`timeoutMs` are optional: a relay that predates them ignores both and falls back
 * to its old "stop at 03h/0Ah" heuristic, which an ISL answer also satisfies.
 */

import { FiscalDevice } from 'db/models'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import type { IFiscalPrinter, FiscalExchangeOptions } from 'fiscal/types'
import { logger } from 'services/logger'
import { randomUUID } from 'crypto'

const COMMAND_TIMEOUT_MS = 60000 // 60s — device may be physically printing (step-by-step mode)
/** Headroom over a driver-supplied budget, so the browser's own timeout always fires first. */
const COMMAND_TIMEOUT_MARGIN_MS = 15000

/** Registered bridge connections: deviceNumber → ws */
const bridgeConnections = new Map<string, any>()

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

/**
 * Handle incoming WebSocket messages for the fiscal bridge.
 */
async function handleMessage(ws: any, raw: any) {
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

  switch (msg.type) {
    case 'fiscal:bridge:register': {
      const { deviceNumber, orgId, warehouseId } = msg
      logger.info({ deviceNumber, orgId, warehouseId }, 'Fiscal bridge registration request received')
      if (!deviceNumber || !orgId) {
        ws.send(JSON.stringify({ type: 'fiscal:bridge:error', message: 'deviceNumber and orgId required' }))
        return
      }

      // Verify device exists in DB
      const device = await FiscalDevice.findOne({
        deviceNumber,
        orgId,
        connectionType: 'browser',
        isActive: true,
      }).exec()

      if (!device) {
        ws.send(JSON.stringify({ type: 'fiscal:bridge:error', message: `No active browser fiscal device found: ${deviceNumber}` }))
        return
      }

      // Disconnect previous bridge for this device (if any)
      if (bridgeConnections.has(deviceNumber)) {
        const oldDeviceId = String(device._id)
        unregisterPrinter(oldDeviceId)
        bridgeConnections.delete(deviceNumber)
      }

      // Register this WS as the bridge
      bridgeConnections.set(deviceNumber, ws)
      wsDeviceMap.set(socketKey(ws), { deviceNumber, orgId: String(orgId) })

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
    if (sameSocket(bridgeConnections.get(deviceNumber), ws)) ws.send(JSON.stringify(info))
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
async function handleClose(ws: any) {
  const entry = wsDeviceMap.get(socketKey(ws))
  if (!entry) return
  const { deviceNumber, orgId } = entry

  // A newer registration for the same device may already own the slot — leave it alone.
  if (sameSocket(bridgeConnections.get(deviceNumber), ws)) bridgeConnections.delete(deviceNumber)
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
  if (!bridgeConnections.has(deviceNumber)) {
    try {
      const device = await FiscalDevice.findOne({ deviceNumber, orgId, connectionType: 'browser' }).exec()
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
export function setupFiscalBridgeWS(app: any): void {
  app.ws('/ws/fiscal-bridge', {
    open(ws: any) {
      logger.info('Fiscal bridge WebSocket connected, waiting for registration...')
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

/** Check if a bridge is connected for a device number */
export function isBridgeConnected(deviceNumber: string): boolean {
  return bridgeConnections.has(deviceNumber)
}

/**
 * Swap the driver behind a live bridge — after an admin corrects the device's manufacturer.
 * Without it the old driver keeps speaking the old protocol until the cashier reconnects.
 * Returns false when no bridge is connected for the device.
 */
export function rebindBridgePrinter(deviceId: string, deviceNumber: string, manufacturer: string): boolean {
  const ws = bridgeConnections.get(deviceNumber)
  if (!ws) return false
  registerPrinter(deviceId, createBridgePrinter(manufacturer, createSendCommand(ws), deviceId))
  logger.info({ deviceId, deviceNumber, manufacturer }, 'Fiscal bridge printer rebound to a new manufacturer')
  return true
}
