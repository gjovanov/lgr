/**
 * Datecs fiscal printer protocol implementation.
 *
 * Datecs (DP-25, DP-55, FP-700, FP-2000, etc.) uses a binary protocol:
 *   <01><LEN><SEQ><CMD><DATA><05><BCC><03>
 *
 * Where:
 *   01 = STX (start of frame)
 *   LEN = length of data from LEN to 04 inclusive (add 0x20 offset)
 *   SEQ = sequence number (0x20-0xFF, wraps)
 *   CMD = command code (0x20 offset)
 *   DATA = command parameters separated by tab (0x09) or comma
 *   05 = ETX separator
 *   BCC = 4-byte checksum (sum of bytes from LEN to 05 inclusive, each byte + 0x30)
 *   03 = ETX (end of frame)
 *
 * Reference: Datecs FP Protocol documentation
 */

import type {
  IFiscalPrinter,
  FiscalDeviceStatus,
  FiscalReceiptResult,
  FiscalStornoResult,
  ZReportResult,
  FiscalConnectionConfig,
  VatGroup,
  FiscalPaymentType,
  StornoReason,
} from './types.js'
import { logger } from 'services/logger/logger'

// Datecs protocol constants
const STX = 0x01
const ETX_DATA = 0x05
const ETX_FRAME = 0x03
const OFFSET = 0x20

// Datecs command codes (after subtracting OFFSET these are raw command bytes)
const CMD = {
  GET_STATUS: 0x4A,          // 74 - Get device status
  GET_DATE_TIME: 0x3E,       // 62 - Read date/time
  SET_DATE_TIME: 0x3D,       // 61 - Set date/time
  OPEN_FISCAL_RECEIPT: 0x30, // 48 - Open fiscal receipt
  SALE_LINE: 0x31,           // 49 - Register sale
  SUBTOTAL: 0x33,            // 51 - Subtotal
  PAYMENT: 0x35,             // 53 - Total/Payment
  CLOSE_RECEIPT: 0x38,       // 56 - Close fiscal receipt
  OPEN_STORNO: 0x2E,         // 46 - Open storno receipt (extended)
  DAILY_Z_REPORT: 0x45,      // 69 - Daily Z report
  GET_LAST_RECEIPT: 0x71,    // 113 - Get last receipt info
  PRINT_FREE_TEXT: 0x36,     // 54 - Print free text line
} as const

/** Datecs payment type codes */
const PAYMENT_CODE: Record<FiscalPaymentType, string> = {
  cash: 'P',
  card: 'N',
  check: 'C',
  voucher: 'D',
}

/** Datecs storno reason codes */
const STORNO_REASON_CODE: Record<StornoReason, number> = {
  operator_error: 0,
  customer_return: 1,
  price_reduction: 2,
  tax_base_reduction: 2,
}

/**
 * Build a Datecs protocol frame.
 */
function buildFrame(seq: number, cmd: number, data: string = ''): Buffer {
  const dataBytes = Buffer.from(data, 'utf-8')
  const len = dataBytes.length + 3 + OFFSET // data + SEQ + CMD + ETX_DATA marker
  const seqByte = (seq % 0xDF) + OFFSET

  // Build payload: LEN SEQ CMD DATA ETX_DATA
  const payload = Buffer.alloc(dataBytes.length + 4)
  payload[0] = len
  payload[1] = seqByte
  payload[2] = cmd + OFFSET
  dataBytes.copy(payload, 3)
  payload[payload.length - 1] = ETX_DATA

  // Calculate BCC (sum of all payload bytes)
  let sum = 0
  for (let i = 0; i < payload.length; i++) {
    sum += payload[i]
  }
  const bcc = Buffer.alloc(4)
  bcc[0] = ((sum >> 12) & 0x0F) + 0x30
  bcc[1] = ((sum >> 8) & 0x0F) + 0x30
  bcc[2] = ((sum >> 4) & 0x0F) + 0x30
  bcc[3] = (sum & 0x0F) + 0x30

  // Full frame: STX + payload + BCC + ETX
  const frame = Buffer.alloc(payload.length + 6)
  frame[0] = STX
  payload.copy(frame, 1)
  bcc.copy(frame, payload.length + 1)
  frame[frame.length - 1] = ETX_FRAME

  return frame
}

/**
 * Parse a Datecs response frame. Returns the data portion as a string.
 */
function parseResponse(buffer: Buffer): { data: string; status: Buffer } {
  // Find STX and ETX
  const stxIdx = buffer.indexOf(STX)
  const etxIdx = buffer.indexOf(ETX_FRAME, stxIdx)
  if (stxIdx === -1 || etxIdx === -1) {
    throw new Error('Invalid Datecs response: missing frame delimiters')
  }

  // Extract data between CMD and ETX_DATA
  const etxDataIdx = buffer.indexOf(ETX_DATA, stxIdx)
  if (etxDataIdx === -1) {
    throw new Error('Invalid Datecs response: missing data separator')
  }

  // Data starts after STX + LEN + SEQ + CMD (index stxIdx+4)
  const dataStart = stxIdx + 4
  const data = buffer.subarray(dataStart, etxDataIdx).toString('utf-8')

  // Status bytes are in the response data (typically first 6 bytes after separator)
  const statusStart = etxDataIdx + 1
  const status = buffer.subarray(statusStart, statusStart + 6)

  return { data, status }
}

/**
 * TCP transport for Datecs fiscal printers.
 * Serial transport would use the 'serialport' npm package similarly.
 */
class DatecsTransport {
  private socket: any = null // TCP socket or serial port
  private config: FiscalConnectionConfig
  private seq = 0

  constructor(config: FiscalConnectionConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.config.type === 'tcp' && this.config.tcp) {
      const net = await import('net')
      return new Promise((resolve, reject) => {
        this.socket = net.createConnection(
          { host: this.config.tcp!.ip, port: this.config.tcp!.port },
          () => resolve(),
        )
        this.socket.on('error', (err: Error) => reject(err))
        this.socket.setTimeout(5000)
      })
    }
    // Serial and USB would be implemented with 'serialport' package
    throw new Error(`Transport type '${this.config.type}' not yet implemented. Use TCP for now.`)
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  async sendCommand(cmd: number, data: string = ''): Promise<string> {
    if (!this.socket) throw new Error('Not connected to fiscal device')

    this.seq = (this.seq + 1) % 0xFF
    const frame = buildFrame(this.seq, cmd, data)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fiscal device timeout')), 10000)
      const chunks: Buffer[] = []

      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const buf = Buffer.concat(chunks)
        if (buf.includes(ETX_FRAME)) {
          clearTimeout(timeout)
          this.socket.removeListener('data', onData)
          try {
            const response = parseResponse(buf)
            resolve(response.data)
          } catch (e) {
            reject(e)
          }
        }
      }

      this.socket.on('data', onData)
      this.socket.write(frame)
    })
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }
}

/**
 * Datecs fiscal printer implementation.
 */
export class DatecsFiscalPrinter implements IFiscalPrinter {
  private transport: DatecsTransport
  private deviceId: string

  constructor(config: FiscalConnectionConfig, deviceId: string = 'datecs') {
    this.transport = new DatecsTransport(config)
    this.deviceId = deviceId
  }

  async connect(): Promise<void> {
    await this.transport.connect()
    logger.info({ deviceId: this.deviceId }, 'Datecs fiscal printer connected')
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect()
    logger.info({ deviceId: this.deviceId }, 'Datecs fiscal printer disconnected')
  }

  async getStatus(): Promise<FiscalDeviceStatus> {
    try {
      const data = await this.transport.sendCommand(CMD.GET_STATUS)
      const parts = data.split(',')

      return {
        connected: true,
        paperPresent: true, // Parse from status bits
        fiscalMemoryOk: true,
        serialNumber: parts[0] || undefined,
        firmwareVersion: parts[1] || undefined,
        errors: [],
      }
    } catch (e: any) {
      return {
        connected: false,
        paperPresent: false,
        fiscalMemoryOk: false,
        errors: [e.message],
      }
    }
  }

  async openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void> {
    // Command 48: Open fiscal receipt
    // Data: <OperatorNum>,<OperatorPassword>,<UNP>,<TillNumber>
    const data = `${operatorCode}\t${operatorCode}\t${unpNumber}`
    await this.transport.sendCommand(CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Fiscal receipt opened')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    // Command 49: Register sale
    // Data: <Name>\t<VatGroup><Price>[*<Qty>][,<Discount%>]
    let data = `${name}\t${vatGroup}${price.toFixed(2)}`
    if (quantity !== 1) data += `*${quantity.toFixed(3)}`
    if (discount && discount > 0) data += `,${discount.toFixed(2)}`
    await this.transport.sendCommand(CMD.SALE_LINE, data)
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const data = await this.transport.sendCommand(CMD.SUBTOTAL)
    return { subtotal: parseFloat(data) || 0 }
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    // Command 53: Total/Payment
    // Data: <PaymentType>\t<Amount>
    const code = PAYMENT_CODE[type] || 'P'
    await this.transport.sendCommand(CMD.PAYMENT, `\t${code}${amount.toFixed(2)}`)
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    const data = await this.transport.sendCommand(CMD.CLOSE_RECEIPT)
    const parts = data.split(',')

    const result: FiscalReceiptResult = {
      fiscalReceiptNumber: parts[0] || 'unknown',
      dateTime: new Date(),
    }

    logger.info({ deviceId: this.deviceId, receiptNumber: result.fiscalReceiptNumber }, 'Fiscal receipt closed')
    return result
  }

  async printStornoReceipt(
    operatorCode: string,
    operatorName: string,
    unpNumber: string,
    originalReceiptNumber: string,
    originalDate: Date,
    originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult> {
    // Open storno receipt with reason and original receipt reference
    const dateStr = formatDatecsDate(originalDate)
    const reasonCode = STORNO_REASON_CODE[reason]
    const stornoData = `${operatorCode}\t${operatorCode}\t${unpNumber}\t${reasonCode}\t${originalReceiptNumber}\t${dateStr}\t${originalUNP}`
    await this.transport.sendCommand(CMD.OPEN_STORNO, stornoData)

    // Print each storno line (negative quantities)
    for (const line of lines) {
      await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
    }

    // Payment and close
    await this.printPayment(payment.type, -payment.amount)
    const data = await this.transport.sendCommand(CMD.CLOSE_RECEIPT)
    const parts = data.split(',')

    const result: FiscalStornoResult = {
      fiscalReceiptNumber: parts[0] || 'unknown',
      dateTime: new Date(),
    }

    logger.info({
      deviceId: this.deviceId,
      stornoReceiptNumber: result.fiscalReceiptNumber,
      originalReceiptNumber,
      reason,
    }, 'Storno fiscal receipt printed')

    return result
  }

  async printDailyZReport(): Promise<ZReportResult> {
    const data = await this.transport.sendCommand(CMD.DAILY_Z_REPORT)
    const parts = data.split(',')

    const result: ZReportResult = {
      reportNumber: parts[0] || 'unknown',
      dateTime: new Date(),
      totalSales: parseFloat(parts[1]) || 0,
      totalReturns: parseFloat(parts[2]) || 0,
      receiptCount: parseInt(parts[3]) || 0,
    }

    logger.info({ deviceId: this.deviceId, reportNumber: result.reportNumber }, 'Daily Z-report printed')
    return result
  }

  async readDateTime(): Promise<Date> {
    const data = await this.transport.sendCommand(CMD.GET_DATE_TIME)
    // Response format: DD-MM-YY HH:MM:SS
    return parseDatecsDateTime(data)
  }

  async syncDateTime(dateTime: Date): Promise<void> {
    const str = formatDatecsDateTime(dateTime)
    await this.transport.sendCommand(CMD.SET_DATE_TIME, str)
    logger.info({ deviceId: this.deviceId, dateTime: str }, 'Fiscal device time synchronized')
  }
}

// ── Datecs date/time helpers ──

function formatDatecsDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(-2)
  return `${dd}-${mm}-${yy}`
}

function formatDatecsDateTime(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(-2)
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${dd}-${mm}-${yy} ${hh}:${min}:${ss}`
}

function parseDatecsDateTime(str: string): Date {
  // Format: DD-MM-YY HH:MM:SS
  const [datePart, timePart] = str.trim().split(' ')
  const [dd, mm, yy] = (datePart || '').split('-').map(Number)
  const [hh, min, ss] = (timePart || '').split(':').map(Number)
  const year = 2000 + (yy || 0)
  return new Date(year, (mm || 1) - 1, dd || 1, hh || 0, min || 0, ss || 0)
}
