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
import { paymentCode } from './types.js'
import { logger } from 'services/logger'
import { stagedPrint } from './print-stage.js'

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
  // Non-fiscal receipt commands
  OPEN_NON_FISCAL_RECEIPT: 0x2E, // 2Eh - Open non-fiscal receipt
  PRINT_FREE_TEXT: 0x37,         // 37h - Print free text line
  CLOSE_NON_FISCAL_RECEIPT: 0x2F, // 2Fh - Close non-fiscal receipt
  // Report and operator commands (verified from ZFPLab XML SDK s_*.xml files)
  OPERATOR_REPORT: 0x7D,           // 7Dh - Operator report (OptionZeroing;Number)
  BRIEF_FM_REPORT_BY_DATE: 0x7B,   // 7Bh - Brief FM report by date (DDMMYY;DDMMYY)
  DETAILED_FM_REPORT_BY_DATE: 0x7A, // 7Ah - Detailed FM report by date (DDMMYY;DDMMYY)
  BRIEF_FM_REPORT_BY_NUMBER: 0x79, // 79h - Brief FM report by Z-number (0000;0000)
  DETAILED_FM_REPORT_BY_NUMBER: 0x78, // 78h - Detailed FM report by Z-number (0000;0000)
  DETAILED_DAILY_REPORT: 0x7F,     // 7Fh - Detailed daily report (Z or X)
  // EJ report uses DAILY_REPORT (0x7C) with J1;D;DDMMYY;DDMMYY data
  PROGRAM_OPERATOR: 0x4A,          // 4Ah - Program operator (Number;Name;Password)
  READ_OPERATOR: 0x6A,             // 6Ah - Read operator (Number) → Number;Name;Password
} as const

/**
 * Tremol payment type codes (0-9, where 0=cash, 1=card typically). No cash on delivery: it is
 * refused, never printed as cash.
 */
const PAYMENT_CODE: Partial<Record<FiscalPaymentType, string>> = {
  cash: '0',
  card: '1',
  check: '2',
  voucher: '3',
}
const DRIVER = "LGR's Tremol driver"

const STORNO_REASON: Record<StornoReason, string> = {
  operator_error: '0',
  customer_return: '1',
  price_reduction: '2',
  tax_base_reduction: '2',
}

/**
 * Encode a string to Windows-1251 (single-byte Cyrillic encoding).
 * Tremol fiscal devices expect Windows-1251, NOT UTF-8.
 * In UTF-8, Cyrillic chars are 2 bytes (D0 XX) — corrupts field parsing.
 */
function encodeWindows1251(str: string): Buffer {
  const bytes: number[] = []
  for (const char of str) {
    const code = char.charCodeAt(0)
    if (code < 0x80) {
      // ASCII — same in both encodings
      bytes.push(code)
    } else if (code >= 0x0410 && code <= 0x044F) {
      // Cyrillic А-я (U+0410-U+044F) → Windows-1251 0xC0-0xFF
      bytes.push(code - 0x0410 + 0xC0)
    } else if (code === 0x0401) {
      bytes.push(0xA8) // Ё
    } else if (code === 0x0451) {
      bytes.push(0xB8) // ё
    } else if (code === 0x2116) {
      bytes.push(0xB9) // №
    } else {
      bytes.push(0x3F) // Unknown → '?'
    }
  }
  return Buffer.from(bytes)
}

/**
 * Decode a Windows-1251 buffer to a JavaScript string.
 * Inverse of encodeWindows1251.
 */
function decodeWindows1251(buf: Buffer): string {
  const chars: string[] = []
  for (const byte of buf) {
    if (byte < 0x80) {
      chars.push(String.fromCharCode(byte))
    } else if (byte >= 0xC0 && byte <= 0xFF) {
      // Cyrillic А-я (Windows-1251 0xC0-0xFF → U+0410-U+044F)
      chars.push(String.fromCharCode(0x0410 + (byte - 0xC0)))
    } else if (byte === 0xA8) {
      chars.push('Ё')
    } else if (byte === 0xB8) {
      chars.push('ё')
    } else if (byte === 0xB9) {
      chars.push('№')
    } else {
      chars.push('?')
    }
  }
  return chars.join('')
}

/**
 * Build a Tremol protocol frame.
 */
export function buildTremolFrame(seq: number, cmd: number, data: string = ''): Buffer {
  const dataBytes = encodeWindows1251(data)
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
    return { data: decodeWindows1251(buffer), isAck: false }
  }

  // Full message response: STX LEN NBL CMD DATA CS CS ETX
  // Data starts after STX + LEN + NBL + CMD (index stxIdx+4)
  const dataStart = stxIdx + 4
  const csStart = etxIdx - 2  // 2 checksum bytes before ETX
  if (csStart <= dataStart) {
    // Frame too short for data — but command was accepted
    return { data: '', isAck: true }
  }
  const data = decodeWindows1251(buffer.subarray(dataStart, csStart))

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
    // PrintType=2 (Postponed) — buffers receipt, prints at close (avoids step-by-step timeout)
    const data = `1;0000;1;1;2$${unpNumber}`
    await this.transport.sendCommand(TREMOL_CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Tremol fiscal receipt opened')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    // Command 31h: NamePLU;OptionVATClass;Price{*Quantity}{,DiscountPercent}
    // ALL fields separated by semicolons (per ZFPLab XML spec)
    let data = `${name.substring(0, 34)};${vatGroup};${price.toFixed(4)}`
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
    const code = paymentCode(PAYMENT_CODE, type, DRIVER)
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
    return stagedPrint(async (reached) => {
      // A payment this driver cannot print is refused before the storno receipt is opened.
      paymentCode(PAYMENT_CODE, payment.type, DRIVER)
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

      const stornoData = `1;0000;1;1;E;${reasonCode};${originalReceiptNumber};${dateTimeStr};$${unpNumber}`
      await this.transport.sendCommand(TREMOL_CMD.OPEN_FISCAL_RECEIPT, stornoData)
      reached('lines')

      for (const line of lines) {
        await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
      }

      reached('paying')
      await this.printPayment(payment.type, -payment.amount)
      reached('closing')
      await this.transport.sendCommand(TREMOL_CMD.CLOSE_RECEIPT)

      let receiptNumber = 'unknown'
      try {
        const info = await this.transport.sendCommand(TREMOL_CMD.READ_RECEIPT_INFO)
        receiptNumber = info.split(';')[0] || 'unknown'
      } catch { /* best-effort */ }

      const result: FiscalStornoResult = { fiscalReceiptNumber: receiptNumber, dateTime: new Date() }
      logger.info({ deviceId: this.deviceId, receiptNumber, reason }, 'Tremol storno receipt printed')
      return result
    })
  }

  async printDailyZReport(): Promise<ZReportResult> {
    // Command 7Ch with 'Z' = zeroing (daily fiscal close)
    await this.transport.sendCommand(TREMOL_CMD.DAILY_REPORT, 'Z')
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

  // ── Non-fiscal receipt methods ──

  async openNonFiscalReceipt(operatorCode: string): Promise<void> {
    const operNum = parseInt(operatorCode, 10) || 1
    // Operator 1, password "0000", Reserve=0, PrintType=1 (Postponed Printing)
    await this.transport.sendCommand(TREMOL_CMD.OPEN_NON_FISCAL_RECEIPT, '1;0000;0;1')
    logger.info({ deviceId: this.deviceId, operatorCode }, 'Tremol non-fiscal receipt opened')
  }

  async printNonFiscalText(text: string): Promise<void> {
    await this.transport.sendCommand(TREMOL_CMD.PRINT_FREE_TEXT, text.substring(0, 42))
  }

  async closeNonFiscalReceipt(): Promise<void> {
    await this.transport.sendCommand(TREMOL_CMD.CLOSE_NON_FISCAL_RECEIPT)
    logger.info({ deviceId: this.deviceId }, 'Tremol non-fiscal receipt closed')
  }

  // ── Report and operator commands ──

  private formatDate(d: Date): string {
    // DDMMYY format (no dashes) per ZFPLab spec
    return `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(-2)}`
  }

  async printDailyXReport(): Promise<ZReportResult> {
    // Command 7Ch with 'X' = without zeroing (read-only daily report)
    await this.transport.sendCommand(TREMOL_CMD.DAILY_REPORT, 'X')
    return { reportNumber: 'unknown', dateTime: new Date(), totalSales: 0, totalReturns: 0, receiptCount: 0 }
  }

  async printOperatorReport(operatorNumber = 0): Promise<void> {
    // Command 7Dh: OptionZeroing;Number — 'X' = without zeroing
    await this.transport.sendCommand(TREMOL_CMD.OPERATOR_REPORT, `X;${operatorNumber}`)
  }

  async printFiscalMemoryReportByDate(startDate: Date, endDate: Date, detailed = false): Promise<void> {
    // Brief=0x7B, Detailed=0x7A — both take DDMMYY;DDMMYY
    const cmd = detailed ? TREMOL_CMD.DETAILED_FM_REPORT_BY_DATE : TREMOL_CMD.BRIEF_FM_REPORT_BY_DATE
    await this.transport.sendCommand(cmd, `${this.formatDate(startDate)};${this.formatDate(endDate)}`)
  }

  async printFiscalMemoryReportByNumber(startNumber: number, endNumber: number, detailed = false): Promise<void> {
    // Brief=0x79, Detailed=0x78 — both take 0000;0000 (4-digit zero-padded)
    const cmd = detailed ? TREMOL_CMD.DETAILED_FM_REPORT_BY_NUMBER : TREMOL_CMD.BRIEF_FM_REPORT_BY_NUMBER
    const start = String(startNumber).padStart(4, '0')
    const end = String(endNumber).padStart(4, '0')
    await this.transport.sendCommand(cmd, `${start};${end}`)
  }

  async printEJReport(startDate: Date, endDate: Date): Promise<void> {
    // EJ uses DAILY_REPORT (0x7C) with data: J1;D;DDMMYY;DDMMYY (J1=print, D=by date)
    await this.transport.sendCommand(TREMOL_CMD.DAILY_REPORT, `J1;D;${this.formatDate(startDate)};${this.formatDate(endDate)}`)
  }

  async programOperator(operatorNumber: number, password: string, name: string): Promise<void> {
    // Format: Number;Name[20];Password[6]
    await this.transport.sendCommand(TREMOL_CMD.PROGRAM_OPERATOR, `${operatorNumber};${name};${password}`)
  }

  async readOperator(operatorNumber: number): Promise<{ number: number; name: string }> {
    const data = await this.transport.sendCommand(TREMOL_CMD.READ_OPERATOR, String(operatorNumber))
    const parts = data.split(';')
    // Response: Number;Name[20];Password[6]
    return { number: operatorNumber, name: (parts[1] || '').trim() }
  }
}
