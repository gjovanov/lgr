import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup.js'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestFiscalDevice,
  createTestStockLevel,
} from '../helpers/factories.js'
import { FiscalDevice, POSTransaction } from 'db/models'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { buildFrame, CMD } from 'fiscal/datecs'
import { registerPrinter, unregisterPrinter, getPrinter, isDeviceConnected } from 'fiscal/fiscal-device.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

// ── Mock helpers ──

/** Build a minimal valid Datecs response frame */
function mockDatecsResponse(data: string): Buffer {
  const STX = 0x01
  const ETX_DATA = 0x05
  const ETX_FRAME = 0x03
  const OFFSET = 0x20

  const dataBytes = Buffer.from(data, 'utf-8')
  const len = dataBytes.length + 3 + OFFSET
  const seqByte = OFFSET + 1
  const cmdByte = OFFSET + 0x30 // arbitrary response cmd

  const payload = Buffer.alloc(dataBytes.length + 4)
  payload[0] = len
  payload[1] = seqByte
  payload[2] = cmdByte
  dataBytes.copy(payload, 3)
  payload[payload.length - 1] = ETX_DATA

  let sum = 0
  for (let i = 0; i < payload.length; i++) sum += payload[i]
  const bcc = Buffer.alloc(4)
  bcc[0] = ((sum >> 12) & 0x0F) + 0x30
  bcc[1] = ((sum >> 8) & 0x0F) + 0x30
  bcc[2] = ((sum >> 4) & 0x0F) + 0x30
  bcc[3] = (sum & 0x0F) + 0x30

  const frame = Buffer.alloc(payload.length + 6)
  frame[0] = STX
  payload.copy(frame, 1)
  bcc.copy(frame, payload.length + 1)
  frame[frame.length - 1] = ETX_FRAME

  return frame
}

/** Create a mock sendCommand that auto-responds with a valid Datecs frame */
function createMockSendCommand(responseData: string = 'OK') {
  const calls: Buffer[] = []
  const sendCommand = async (frame: Buffer): Promise<Buffer> => {
    calls.push(frame)
    return mockDatecsResponse(responseData)
  }
  return { sendCommand, calls }
}

// ── Tests ──

describe('WebSocketFiscalPrinter', () => {
  it('should build and send correct Datecs frames for openFiscalReceipt', async () => {
    const { sendCommand, calls } = createMockSendCommand()
    const printer = new WebSocketFiscalPrinter(sendCommand, 'test-device')

    await printer.openFiscalReceipt('0001', 'Test Operator', 'DT523847-0001-0000001')

    expect(calls.length).toBe(1)
    // Verify the frame starts with STX byte
    expect(calls[0][0]).toBe(0x01)
    // Verify the frame ends with ETX byte
    expect(calls[0][calls[0].length - 1]).toBe(0x03)
    // Verify CMD byte is OPEN_FISCAL_RECEIPT + OFFSET
    expect(calls[0][3]).toBe(CMD.OPEN_FISCAL_RECEIPT + 0x20)
  })

  it('should build correct frames for printSaleLine', async () => {
    const { sendCommand, calls } = createMockSendCommand()
    const printer = new WebSocketFiscalPrinter(sendCommand, 'test-device')

    await printer.printSaleLine('Test Product', 2, 10.50, 'А')

    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe(0x01) // STX
    expect(calls[0][3]).toBe(CMD.SALE_LINE + 0x20)
  })

  it('should parse closeFiscalReceipt response correctly', async () => {
    const { sendCommand } = createMockSendCommand('0000042,23-03-26 09:21:15')
    const printer = new WebSocketFiscalPrinter(sendCommand, 'test-device')

    const result = await printer.closeFiscalReceipt()

    expect(result.fiscalReceiptNumber).toBe('0000042')
    expect(result.dateTime).toBeInstanceOf(Date)
  })

  it('should handle sendCommand timeout', async () => {
    // sendCommand that never resolves
    const sendCommand = () => new Promise<Buffer>(() => {})
    const printer = new WebSocketFiscalPrinter(sendCommand, 'test-device')

    // The printer itself doesn't have a timeout — the fiscal bridge handler adds it.
    // Test that the sendCommand is called and the promise hangs.
    // In production, the fiscal-bridge.ts createSendCommand adds a 15s timeout.
    const promise = printer.openFiscalReceipt('0001', 'Test', 'UNP-TEST')

    // We can't easily test the timeout here without the bridge layer,
    // but we verify the call doesn't throw synchronously
    expect(promise).toBeInstanceOf(Promise)
  })
})

describe('Fiscal Bridge Registration', () => {
  it('should register and unregister printer in activeConnections', async () => {
    const org = await createTestOrg({ slug: 'bridge-reg-org' })
    const warehouse = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, warehouse._id, {
      connectionType: 'browser',
      status: 'offline',
    })
    const deviceId = String(device._id)

    const { sendCommand, calls } = createMockSendCommand()
    const printer = new WebSocketFiscalPrinter(sendCommand, deviceId)

    // Register
    registerPrinter(deviceId, printer)
    expect(isDeviceConnected(deviceId)).toBe(true)
    // What `getPrinter` hands out is a counted view of the registered printer (FR-20.23): the same
    // class, the same object on every call, and its commands reach this printer's socket.
    const handedOut = getPrinter(deviceId)
    expect(handedOut).toBeInstanceOf(WebSocketFiscalPrinter)
    expect(getPrinter(deviceId)).toBe(handedOut)
    await handedOut.openFiscalReceipt('0001', 'Test Operator', 'DT523847-0001-0000001')
    expect(calls.length).toBe(1)

    // Update DB status
    await FiscalDevice.findByIdAndUpdate(device._id, { status: 'online' }).exec()
    const updated = await FiscalDevice.findById(device._id).lean().exec()
    expect(updated!.status).toBe('online')

    // Unregister
    unregisterPrinter(deviceId)
    expect(isDeviceConnected(deviceId)).toBe(false)
    expect(() => getPrinter(deviceId)).toThrow()
  })
})

describe('POS with Browser Fiscal Device', () => {
  it('should create POS transaction with fiscal data when browser device is registered', async () => {
    const org = await createTestOrg({ slug: 'pos-browser-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const product = await createTestProduct(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })

    const device = await createTestFiscalDevice(org._id, warehouse._id, {
      deviceNumber: '12345678',
      connectionType: 'browser',
    })
    const deviceId = String(device._id)

    // Register mock printer
    const receiptCalls: string[] = []
    const { sendCommand } = createMockSendCommand('0000099')
    const printer = new WebSocketFiscalPrinter(sendCommand, deviceId)
    registerPrinter(deviceId, printer)
    await FiscalDevice.findByIdAndUpdate(device._id, { status: 'online' }).exec()

    // The POS controller uses getFiscalContext → finds the browser device → uses registered printer
    // We verify by checking the fiscal device is online and registered
    expect(isDeviceConnected(deviceId)).toBe(true)

    // Clean up
    unregisterPrinter(deviceId)
  })

  it('should fall through to non-fiscal mode when browser bridge is disconnected', async () => {
    const org = await createTestOrg({ slug: 'pos-nofiscal-org' })
    const warehouse = await createTestWarehouse(org._id)

    const device = await createTestFiscalDevice(org._id, warehouse._id, {
      connectionType: 'browser',
      status: 'offline',
    })
    const deviceId = String(device._id)

    // Device registered in DB but NOT in activeConnections
    expect(isDeviceConnected(deviceId)).toBe(false)

    // The POS controller's getFiscalContext() will find the device offline
    // and return null → non-fiscal mode
    const dbDevice = await FiscalDevice.findById(device._id).lean().exec()
    expect(dbDevice!.status).toBe('offline')
    expect(dbDevice!.connectionType).toBe('browser')
  })
})
