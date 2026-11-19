/**
 * Fiscal device connection manager.
 *
 * Manages active connections to fiscal printers, monitors their status,
 * and routes commands to the correct printer implementation.
 */

import type { IFiscalPrinter, FiscalConnectionConfig, FiscalDeviceStatus } from './types.js'
import { DatecsFiscalPrinter } from './datecs.js'
import { EltradeFiscalPrinter } from './eltrade.js'
import { IslTcpTransport } from './isl-tcp.js'
import { tracked } from './in-flight.js'
import { PRINTING_COMMANDS, deviceTurn } from './device-turn.js'
import { noteAnswered } from './device-reach.js'
import { FiscalNotConnectedError } from './errors.js'
import { resolveFiscalTcpTarget, fiscalTcpPolicy, type FiscalTcpPolicy } from './tcp-target.js'
import { logger } from 'services/logger'
import { nodeRole } from 'config'

/** Active printer connections keyed by fiscal device ID */
const activeConnections = new Map<string, IFiscalPrinter>()

/**
 * #869: when this process last LOST each device's bridge (its socket closed and nobody took the device over), and the
 * requests waiting for a printer to be registered again. A deliberate stop (a revocation, a takeover) is no loss, and
 * nothing waits for it. A registration clears the stamp and wakes the waiters.
 */
const lostAt = new Map<string, number>()
const waiters = new Map<string, Set<() => void>>()

function setActive(deviceId: string, printer: IFiscalPrinter): void {
  activeConnections.set(deviceId, printer)
  lostAt.delete(deviceId)
  const waiting = waiters.get(deviceId)
  if (!waiting) return
  waiters.delete(deviceId)
  for (const wake of waiting) wake()
}

/**
 * Create a fiscal printer instance based on manufacturer.
 */
export function createPrinter(
  manufacturer: string,
  config: FiscalConnectionConfig,
  deviceId: string,
): IFiscalPrinter {
  switch (manufacturer) {
    case 'datecs':
    case 'tremol':
    case 'daisy':
      // Tremol and Daisy use the same Bulgarian fiscal protocol as Datecs
      // (STX/LEN/SEQ/CMD/DATA/BCC/ETX frame format, same command set)
      return new DatecsFiscalPrinter(config, deviceId)
    case 'eltrade': {
      if (config.type === 'tcp' && config.tcp) {
        const transport = new IslTcpTransport(config.tcp.ip, config.tcp.port)
        return new EltradeFiscalPrinter(
          { exchange: transport.exchange, open: () => transport.open(), close: () => transport.close() },
          deviceId,
        )
      }
      throw new Error(
        `Eltrade over '${config.type}' is not opened by the server. Use connection type 'browser' `
        + `(connect from the CS Terminal or the Devices page) or 'tcp' through the serial-to-TCP bridge.`,
      )
    }
    case 'incotex':
      // Incotex has minor protocol differences — needs separate driver
      throw new Error(`Manufacturer 'incotex' not yet implemented.`)
    default:
      throw new Error(`Unknown fiscal printer manufacturer: ${manufacturer}`)
  }
}

/**
 * Connect to a fiscal device and register it as active.
 *
 * A TCP device is connected to the address `resolveFiscalTcpTarget` returns, never to the stored
 * host as typed: that host comes from a user, and this is the one place the server opens a socket
 * for it. A refused target throws `FiscalTargetError` before anything connects.
 */
export async function connectDevice(
  deviceId: string,
  manufacturer: string,
  config: FiscalConnectionConfig,
  opts: { tcpPolicy?: FiscalTcpPolicy } = {},
): Promise<IFiscalPrinter> {
  if (config.tcp) {
    const ip = await resolveFiscalTcpTarget(config.tcp.ip, opts.tcpPolicy ?? fiscalTcpPolicy(nodeRole()))
    config = { ...config, tcp: { ...config.tcp, ip } }
  }

  // Disconnect existing connection if any
  if (activeConnections.has(deviceId)) {
    await disconnectDevice(deviceId)
  }

  const printer = createPrinter(manufacturer, config, deviceId)
  await printer.connect()
  setActive(deviceId, printer)

  logger.info({ deviceId, manufacturer }, 'Fiscal device connected and registered')
  return printer
}

/**
 * Disconnect a fiscal device.
 */
export async function disconnectDevice(deviceId: string): Promise<void> {
  const printer = activeConnections.get(deviceId)
  if (printer) {
    try {
      await printer.disconnect()
    } catch (e: any) {
      logger.warn({ deviceId, error: e.message }, 'Error disconnecting fiscal device')
    }
    activeConnections.delete(deviceId)
  }
}

/** One counted view per printer, so two `getPrinter()` calls hand out the same object. */
const trackedPrinters = new WeakMap<IFiscalPrinter, IFiscalPrinter>()

/**
 * Get an active fiscal printer connection.
 * Throws if the device is not connected.
 *
 * Each command given to it counts as in flight while it runs (`in-flight.ts`), so the API's
 * graceful stop waits for it (FR-20.23), and each one that prints a document takes the device's
 * turn (`device-turn.ts`), so it never lands inside another document.
 */
export function getPrinter(deviceId: string): IFiscalPrinter {
  const printer = activeConnections.get(deviceId)
  if (!printer) {
    throw new FiscalNotConnectedError(deviceId)
  }
  let view = trackedPrinters.get(printer)
  if (!view) {
    // Each answer is the device reached (FR-20.49): what the two-hour rule reads.
    view = tracked(
      printer,
      (method, result) => noteAnswered(deviceId, method, result),
      (method, run) => (PRINTING_COMMANDS.has(method) ? deviceTurn(deviceId, async () => run()) : run()),
    )
    trackedPrinters.set(printer, view)
  }
  return view
}

/**
 * Check if a fiscal device is connected.
 */
export function isDeviceConnected(deviceId: string): boolean {
  return activeConnections.has(deviceId)
}

/**
 * What the device said of itself in the status every answer carries (FR-23): `false` is what makes a
 * receipt print as text. Undefined when this process holds no answer from it. No command is sent.
 */
export function lastFiscalized(deviceId: string): boolean | undefined {
  return (activeConnections.get(deviceId) as { lastStatus?: { fiscalized?: boolean } | null } | undefined)?.lastStatus?.fiscalized
}

/**
 * Get status of a connected fiscal device.
 */
export async function getDeviceStatus(deviceId: string): Promise<FiscalDeviceStatus> {
  const printer = activeConnections.get(deviceId)
  if (!printer) {
    return {
      connected: false,
      paperPresent: false,
      fiscalMemoryOk: false,
      errors: ['Device not connected'],
    }
  }
  return printer.getStatus()
}

/**
 * Get all active device IDs.
 */
export function getActiveDeviceIds(): string[] {
  return [...activeConnections.keys()]
}

/**
 * Register an externally-created printer (e.g., WebSocketFiscalPrinter from browser bridge).
 * Unlike connectDevice(), this does NOT call printer.connect() — the caller manages the connection.
 */
export function registerPrinter(deviceId: string, printer: IFiscalPrinter): void {
  setActive(deviceId, printer)
  logger.info({ deviceId }, 'Fiscal printer registered (external)')
}

/**
 * Unregister a printer without calling disconnect() (for browser bridge teardown).
 *
 * `lost`: its bridge went away by itself (#869), so a request for the device may wait a few seconds for it to come
 * back (`bridge-hold.ts`). Not for a deliberate stop.
 */
export function unregisterPrinter(deviceId: string, opts: { lost?: boolean } = {}): void {
  activeConnections.delete(deviceId)
  if (opts.lost) lostAt.set(deviceId, Date.now())
  logger.info({ deviceId, ...(opts.lost ? { lost: true } : {}) }, 'Fiscal printer unregistered')
}

/** #869: when this process last lost the device's bridge (ms since the epoch); undefined when it has not, or it came back. */
export function lostHereAt(deviceId: string): number | undefined {
  return lostAt.get(deviceId)
}

/**
 * #869: true as soon as a printer is registered for the device (at once when one already is), false once `ms` have
 * passed without one.
 */
export function printerRegistered(deviceId: string, ms: number): Promise<boolean> {
  if (activeConnections.has(deviceId)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let waiting = waiters.get(deviceId)
    if (!waiting) waiters.set(deviceId, (waiting = new Set()))
    const wake = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      const set = waiters.get(deviceId)
      set?.delete(wake)
      if (set && !set.size) waiters.delete(deviceId)
      resolve(activeConnections.has(deviceId))
    }, Math.max(0, ms))
    waiting.add(wake)
  })
}

/**
 * Disconnect all devices (for graceful shutdown).
 */
export async function disconnectAll(): Promise<void> {
  const ids = [...activeConnections.keys()]
  await Promise.allSettled(ids.map(id => disconnectDevice(id)))
  logger.info({ count: ids.length }, 'All fiscal devices disconnected')
}

/**
 * Build a FiscalConnectionConfig from the DB model's connectionParams.
 */
export function buildConnectionConfig(
  connectionType: string,
  params: { port?: string; baudRate?: number; ip?: string; tcpPort?: number; usbPath?: string },
): FiscalConnectionConfig {
  const config: FiscalConnectionConfig = { type: connectionType as any }

  switch (connectionType) {
    case 'serial':
      config.serial = {
        port: params.port || '/dev/ttyUSB0',
        baudRate: params.baudRate || 115200,
      }
      break
    case 'tcp':
      config.tcp = {
        // A TCP device always names its host; there is no default.
        ip: params.ip || '',
        port: params.tcpPort || 4999,
      }
      break
    case 'usb':
      config.usb = {
        path: params.usbPath || '/dev/usb/lp0',
      }
      break
    case 'browser':
      // Browser connections are managed via WebSocket bridge, no params needed
      break
  }

  return config
}
