/**
 * Fiscal device connection manager.
 *
 * Manages active connections to fiscal printers, monitors their status,
 * and routes commands to the correct printer implementation.
 */

import type { IFiscalPrinter, FiscalConnectionConfig, FiscalDeviceStatus } from './types.js'
import { DatecsFiscalPrinter } from './datecs.js'
import { logger } from 'services/logger'

/** Active printer connections keyed by fiscal device ID */
const activeConnections = new Map<string, IFiscalPrinter>()

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
      return new DatecsFiscalPrinter(config, deviceId)
    case 'daisy':
    case 'tremol':
    case 'incotex':
      // TODO: Implement other manufacturers
      throw new Error(`Manufacturer '${manufacturer}' not yet implemented. Use 'datecs'.`)
    default:
      throw new Error(`Unknown fiscal printer manufacturer: ${manufacturer}`)
  }
}

/**
 * Connect to a fiscal device and register it as active.
 */
export async function connectDevice(
  deviceId: string,
  manufacturer: string,
  config: FiscalConnectionConfig,
): Promise<IFiscalPrinter> {
  // Disconnect existing connection if any
  if (activeConnections.has(deviceId)) {
    await disconnectDevice(deviceId)
  }

  const printer = createPrinter(manufacturer, config, deviceId)
  await printer.connect()
  activeConnections.set(deviceId, printer)

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

/**
 * Get an active fiscal printer connection.
 * Throws if the device is not connected.
 */
export function getPrinter(deviceId: string): IFiscalPrinter {
  const printer = activeConnections.get(deviceId)
  if (!printer) {
    throw new Error(`Fiscal device ${deviceId} is not connected`)
  }
  return printer
}

/**
 * Check if a fiscal device is connected.
 */
export function isDeviceConnected(deviceId: string): boolean {
  return activeConnections.has(deviceId)
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
        ip: params.ip || '127.0.0.1',
        port: params.tcpPort || 4999,
      }
      break
    case 'usb':
      config.usb = {
        path: params.usbPath || '/dev/usb/lp0',
      }
      break
  }

  return config
}
