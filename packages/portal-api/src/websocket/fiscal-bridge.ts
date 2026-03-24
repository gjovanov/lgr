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
 *     { type: 'fiscal:bridge:registered', deviceNumber }
 *     { type: 'fiscal:bridge:error', message }
 *     { type: 'fiscal:command', commandId, frame: base64 }
 */

import { FiscalDevice } from 'db/models'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { logger } from 'services/logger'
import { randomUUID } from 'crypto'

const COMMAND_TIMEOUT_MS = 15000

/** Registered bridge connections: deviceNumber → ws */
const bridgeConnections = new Map<string, any>()

/** Pending command responses: commandId → { resolve, reject, timer } */
const pendingCommands = new Map<string, {
  resolve: (data: Buffer) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

/** Device number stored per WS connection */
const wsDeviceMap = new WeakMap<any, string>()

/**
 * Create a sendCommand function for a specific WS connection.
 * This is injected into WebSocketFiscalPrinter.
 */
function createSendCommand(ws: any): (frame: Buffer) => Promise<Buffer> {
  return (frame: Buffer): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const commandId = randomUUID()

      const timer = setTimeout(() => {
        pendingCommands.delete(commandId)
        reject(new Error(`Fiscal bridge command timeout (${COMMAND_TIMEOUT_MS}ms)`))
      }, COMMAND_TIMEOUT_MS)

      pendingCommands.set(commandId, { resolve, reject, timer })

      try {
        ws.send(JSON.stringify({
          type: 'fiscal:command',
          commandId,
          frame: frame.toString('base64'),
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
        const oldWs = bridgeConnections.get(deviceNumber)
        const oldDeviceId = String(device._id)
        unregisterPrinter(oldDeviceId)
        bridgeConnections.delete(deviceNumber)
      }

      // Register this WS as the bridge
      bridgeConnections.set(deviceNumber, ws)
      wsDeviceMap.set(ws, deviceNumber)

      // Create the correct printer type based on manufacturer
      const sendCommand = createSendCommand(ws)
      const deviceIdStr = String(device._id)
      const manufacturer = device.manufacturer || 'datecs'
      const printer = (manufacturer === 'tremol')
        ? new WsTremolFiscalPrinter(sendCommand, deviceIdStr)
        : new WebSocketFiscalPrinter(sendCommand, deviceIdStr)
      registerPrinter(deviceIdStr, printer)
      logger.info({ deviceId: deviceIdStr, manufacturer, printerType: manufacturer === 'tremol' ? 'WsTremolFiscalPrinter' : 'WebSocketFiscalPrinter' }, 'Printer instance created')

      // Update device status
      await FiscalDevice.findByIdAndUpdate(device._id, {
        status: 'online',
        lastCommunicationAt: new Date(),
      }).exec()

      ws.send(JSON.stringify({ type: 'fiscal:bridge:registered', deviceNumber }))
      logger.info({ deviceNumber, deviceId: String(device._id) }, 'Fiscal bridge registered via WebSocket')
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
 * Handle WS disconnect — clean up bridge registration.
 */
async function handleClose(ws: any) {
  const deviceNumber = wsDeviceMap.get(ws)
  if (!deviceNumber) return

  bridgeConnections.delete(deviceNumber)
  wsDeviceMap.delete(ws)

  // Find device and unregister printer
  try {
    const device = await FiscalDevice.findOne({ deviceNumber, connectionType: 'browser' }).exec()
    if (device) {
      unregisterPrinter(String(device._id))
      await FiscalDevice.findByIdAndUpdate(device._id, { status: 'offline' }).exec()
    }
  } catch (e: any) {
    logger.warn({ deviceNumber, error: e.message }, 'Error cleaning up fiscal bridge')
  }

  // Reject any pending commands for this bridge
  for (const [cmdId, pending] of pendingCommands) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Fiscal bridge disconnected'))
    pendingCommands.delete(cmdId)
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
