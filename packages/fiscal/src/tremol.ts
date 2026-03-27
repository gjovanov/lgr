/**
 * Tremol fiscal printer protocol implementation.
 *
 * Tremol (M20, S25, FP01, etc.) uses a protocol similar to but distinct from Datecs:
 *   <02><LEN><NBL><CMD><DATA><CS><CS><0A>
 *
 * Key differences from Datecs:
 *   STX = 0x02 (vs Datecs 0x01)
 *   ETX = 0x0A / LF (vs Datecs 0x03)
 *   Checksum = XOR-based, 2 bytes +0x30 (vs Datecs sum-based, 4 bytes)
 *   Data separator = ';' (vs Datecs '\t')
 *   Code page = Windows-1251
 *
 * Reference: Tremol Communication Protocol v2208081230
 */

import type {
  IFiscalPrinter,
  FiscalDeviceStatus,
  FiscalReceiptResult,
  FiscalStornoResult,
  ZReportResult,
  VatGroup,
  FiscalPaymentType,
  StornoReason,
} from './types.js'
import { logger } from 'services/logger'

// Tremol protocol constants
const STX = 0x02
const ETX = 0x0A  // LF
const OFFSET = 0x20

// Tremol command codes (same hex values as listed in protocol doc)
export const TREMOL_CMD = {
  STATUS: 0x20,                // 20h - Status
  VERSION: 0x21,               // 21h - Version
  READ_DATE_TIME: 0x68,        // 68h - Read date and time
  SET_DATE_TIME: 0x48,         // 48h - Program date and time
  OPEN_FISCAL_RECEIPT: 0x30,   // 30h - Open fiscal receipt
  SELL_ARTICLE: 0x31,          // 31h - Sell article by VAT class
  SUBTOTAL: 0x33,              // 33h - Subtotal
  PAYMENT: 0x35,               // 35h - Payment
  CLOSE_RECEIPT: 0x38,         // 38h - Close fiscal receipt
  CANCEL_RECEIPT: 0x39,        // 39h - Cancel fiscal receipt
  DAILY_REPORT: 0x7C,          // 7Ch - Z/X daily report
  READ_RECEIPT_INFO: 0x72,     // 72h - Read current receipt info
  READ_FD_NUMBERS: 0x60,       // 60h - Read FD numbers
} as const

/** Tremol payment type codes (0-9, where 0=cash, 1=card typically) */
const PAYMENT_CODE: Record<FiscalPaymentType, string> = {
  cash: '0',
  card: '1',
  check: '2',
  voucher: '3',
}

const STORNO_REASON: Record<StornoReason, string> = {
  operator_error: '0',
  customer_return: '1',
  price_reduction: '2',
  tax_base_reduction: '2',
}

/**
 * Build a Tremol protocol frame.
 */
export function buildTremolFrame(seq: number, cmd: number, data: string = ''): Buffer {
  const dataBytes = Buffer.from(data, 'utf-8')
  // LEN = count of bytes from LEN to last DATA byte, +0x20
  const len = dataBytes.length + 3 + OFFSET  // NBL + CMD + DATA bytes + LEN itself... per spec: LEN,NBL,CMD,DATA
  const nbl = (seq % 0x80) + OFFSET

  // Build payload: LEN NBL CMD DATA
  const payload = Buffer.alloc(dataBytes.length + 3)
  payload[0] = len
  payload[1] = nbl
  payload[2] = cmd
  dataBytes.copy(payload, 3)

  // Checksum: XOR of all bytes from LEN to last DATA byte
  let xorVal = 0
  for (let i = 0; i < payload.length; i++) {
    xorVal ^= payload[i]
  }
  // Convert to 2 bytes by adding 0x30
  const cs1 = ((xorVal >> 4) & 0x0F) + 0x30
  const cs2 = (xorVal & 0x0F) + 0x30

  // Full frame: STX + payload + CS1 + CS2 + ETX
  const frame = Buffer.alloc(payload.length + 4)
  frame[0] = STX
  payload.copy(frame, 1)
  frame[payload.length + 1] = cs1
  frame[payload.length + 2] = cs2
  frame[frame.length - 1] = ETX

  return frame
}

/**
 * Parse a Tremol response frame. Returns the data portion.
 * The device can respond with:
 *   - Single ACK byte (0x06) — command accepted
 *   - Single NAK byte (0x15) — command rejected
 *   - ACK + full message frame (ACK STX LEN NBL CMD DATA CS CS ETX)
 *   - Full message frame without ACK prefix
 *   - Various combinations with extra bytes
 */
export function parseTremolResponse(buffer: Buffer): { data: string; isAck: boolean } {
  if (buffer.length === 0) {
    return { data: '', isAck: true } // empty response treated as ACK
  }

  // Check for ACK byte anywhere in first few bytes
  const hasAck = buffer[0] === 0x06 || (buffer.length > 1 && buffer[1] === 0x06)

  // Check for NAK
  if (buffer[0] === 0x15) {
    throw new Error('Tremol NAK: command rejected')
  }

  // If it's just ACK (with possible trailing bytes), accept it
  if (buffer[0] === 0x06 && (buffer.length === 1 || buffer.indexOf(STX) === -1)) {
    return { data: '', isAck: true }
  }

  // Try to find a full message frame: STX ... ETX
  // ACK byte may precede the frame
  const stxIdx = buffer.indexOf(STX)
  const etxIdx = stxIdx !== -1 ? buffer.indexOf(ETX, stxIdx) : -1

  if (stxIdx === -1 || etxIdx === -1) {
    // No full frame found — if we have ACK, treat as success
    if (hasAck) return { data: '', isAck: true }
    // Otherwise accept whatever we got as a raw response
    return { data: buffer.toString('utf-8'), isAck: false }
  }

  // Full message response: STX LEN NBL CMD DATA CS CS ETX
  // Data starts after STX + LEN + NBL + CMD (index stxIdx+4)
  const dataStart = stxIdx + 4
  const csStart = etxIdx - 2  // 2 checksum bytes before ETX
  if (csStart <= dataStart) {
    // Frame too short for data — but command was accepted
    return { data: '', isAck: true }
  }
  const data = buffer.subarray(dataStart, csStart).toString('utf-8')

  return { data, isAck: false }
}

/**
 * TCP/Serial transport for Tremol fiscal printers.
 */
class TremolTransport {
  private socket: any = null
  private config: { type: string; tcp?: { ip: string; port: number } }
  private seq = 0

  constructor(config: any) {
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
    throw new Error(`Transport type '${this.config.type}' not supported for direct connection. Use browser bridge for USB.`)
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  async sendCommand(cmd: number, data: string = ''): Promise<string> {
    if (!this.socket) throw new Error('Not connected to Tremol device')

    this.seq = (this.seq + 1) % 0x7F
    const frame = buildTremolFrame(this.seq, cmd, data)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tremol device timeout')), 10000)
      const chunks: Buffer[] = []

      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const buf = Buffer.concat(chunks)
        // Check for ACK (0x06), NAK (0x15), or full frame (ends with ETX=0x0A)
        if (buf[0] === 0x06 || buf[0] === 0x15 || buf.includes(ETX)) {
          clearTimeout(timeout)
          this.socket.removeListener('data', onData)
          try {
            const response = parseTremolResponse(buf)
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
 * Tremol fiscal printer implementation (direct TCP connection).
 */
export class TremolFiscalPrinter implements IFiscalPrinter {
  private transport: TremolTransport
  private deviceId: string

  constructor(config: any, deviceId: string = 'tremol') {
    this.transport = new TremolTransport(config)
    this.deviceId = deviceId
  }

  async connect(): Promise<void> {
    await this.transport.connect()
    logger.info({ deviceId: this.deviceId }, 'Tremol fiscal printer connected')
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect()
    logger.info({ deviceId: this.deviceId }, 'Tremol fiscal printer disconnected')
  }

  async getStatus(): Promise<FiscalDeviceStatus> {
    try {
      const data = await this.transport.sendCommand(TREMOL_CMD.STATUS)
      return {
        connected: true,
        paperPresent: true,
        fiscalMemoryOk: true,
        errors: [],
      }
    } catch (e: any) {
      return { connected: false, paperPresent: false, fiscalMemoryOk: false, errors: [e.message] }
    }
  }

  async openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void> {
    // Command 30h: OpNum;OpPass;ReceiptFormat;PrintVAT;FiscalRcpPrintType$UNP
    // ReceiptFormat: 1=Detailed, PrintVAT: 1=Yes, PrintType: 0=StepByStep
    const operPass = operatorCode.padEnd(6, '0') // Tremol requires 6-char password
    const data = `${operatorCode};${operPass};1;1;0$${unpNumber}`
    await this.transport.sendCommand(TREMOL_CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Tremol fiscal receipt opened')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    // Command 31h: NamePLU\tOptionVATClass;Price{*Quantity}{,DiscountPercent}
    // Name separated by TAB, then VATgroup;Price by semicolons
    let data = `${name.substring(0, 34)}\t${vatGroup};${price.toFixed(2)}`
    if (quantity !== 1) data += `*${quantity.toFixed(3)}`
    if (discount && discount > 0) data += `,${discount.toFixed(2)}`
    await this.transport.sendCommand(TREMOL_CMD.SELL_ARTICLE, data)
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const data = await this.transport.sendCommand(TREMOL_CMD.SUBTOTAL)
    return { subtotal: parseFloat(data) || 0 }
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    // Command 35h: PaymentType;OptionChange;Amount
    // OptionChange: 1=Yes (return change)
    const code = PAYMENT_CODE[type] || '0'
    await this.transport.sendCommand(TREMOL_CMD.PAYMENT, `${code};1;${amount.toFixed(2)}`)
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    // Command 38h: no input data
    await this.transport.sendCommand(TREMOL_CMD.CLOSE_RECEIPT)

    // Read receipt info to get the receipt number
    let receiptNumber = 'unknown'
    try {
      const info = await this.transport.sendCommand(TREMOL_CMD.READ_RECEIPT_INFO)
      const parts = info.split(';')
      receiptNumber = parts[0] || 'unknown'
    } catch { /* best-effort */ }

    const result: FiscalReceiptResult = {
      fiscalReceiptNumber: receiptNumber,
      dateTime: new Date(),
    }
    logger.info({ deviceId: this.deviceId, receiptNumber }, 'Tremol fiscal receipt closed')
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
    // Command 30h with storno format:
    // OpNum;OpPass;ReceiptFormat;PrintVAT;StornoRcpPrintType;StornoReason;RelatedToRcpNum;RelatedToRcpDateTime;FMNum$UNP
    const dd = String(originalDate.getDate()).padStart(2, '0')
    const mm = String(originalDate.getMonth() + 1).padStart(2, '0')
    const yy = String(originalDate.getFullYear()).slice(-2)
    const hh = String(originalDate.getHours()).padStart(2, '0')
    const min = String(originalDate.getMinutes()).padStart(2, '0')
    const ss = String(originalDate.getSeconds()).padStart(2, '0')
    const dateTimeStr = `${dd}-${mm}-${yy} ${hh}:${min}:${ss}`
    const reasonCode = STORNO_REASON[reason]

    const operPass = operatorCode.padEnd(6, '0')
    const stornoData = `${operatorCode};${operPass};1;1;E;${reasonCode};${originalReceiptNumber};${dateTimeStr};$${unpNumber}`
    await this.transport.sendCommand(TREMOL_CMD.OPEN_FISCAL_RECEIPT, stornoData)

    for (const line of lines) {
      await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
    }

    await this.printPayment(payment.type, -payment.amount)
    await this.transport.sendCommand(TREMOL_CMD.CLOSE_RECEIPT)

    let receiptNumber = 'unknown'
    try {
      const info = await this.transport.sendCommand(TREMOL_CMD.READ_RECEIPT_INFO)
      receiptNumber = info.split(';')[0] || 'unknown'
    } catch { /* best-effort */ }

    const result: FiscalStornoResult = { fiscalReceiptNumber: receiptNumber, dateTime: new Date() }
    logger.info({ deviceId: this.deviceId, receiptNumber, reason }, 'Tremol storno receipt printed')
    return result
  }

  async printDailyZReport(): Promise<ZReportResult> {
    // Command 7Ch: Option;SubOption — '0';'0' = Z report
    await this.transport.sendCommand(TREMOL_CMD.DAILY_REPORT, '0;0')
    return { reportNumber: 'unknown', dateTime: new Date(), totalSales: 0, totalReturns: 0, receiptCount: 0 }
  }

  async readDateTime(): Promise<Date> {
    const data = await this.transport.sendCommand(TREMOL_CMD.READ_DATE_TIME)
    // Response: DD-MM-YY;HH:MM:SS
    const [datePart, timePart] = data.split(';')
    const [dd, mm, yy] = (datePart || '').split('-').map(Number)
    const [hh, min, ss] = (timePart || '').split(':').map(Number)
    return new Date(2000 + (yy || 0), (mm || 1) - 1, dd || 1, hh || 0, min || 0, ss || 0)
  }

  async syncDateTime(dateTime: Date): Promise<void> {
    const dd = String(dateTime.getDate()).padStart(2, '0')
    const mm = String(dateTime.getMonth() + 1).padStart(2, '0')
    const yy = String(dateTime.getFullYear()).slice(-2)
    const hh = String(dateTime.getHours()).padStart(2, '0')
    const min = String(dateTime.getMinutes()).padStart(2, '0')
    const ss = String(dateTime.getSeconds()).padStart(2, '0')
    await this.transport.sendCommand(TREMOL_CMD.SET_DATE_TIME, `${dd}-${mm}-${yy};${hh}:${min}:${ss}`)
  }
}
