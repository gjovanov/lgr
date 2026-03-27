/**
 * WebSocket-based Tremol fiscal printer transport.
 *
 * Same as WebSocketFiscalPrinter but uses Tremol protocol framing
 * instead of Datecs. Routes commands through the browser WS bridge.
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
import { buildTremolFrame, parseTremolResponse, TREMOL_CMD } from './tremol.js'
import { logger } from 'services/logger'
import type { SendCommandFn } from './ws-fiscal-printer.js'

const PAYMENT_CODE: Record<FiscalPaymentType, string> = {
  cash: '0', card: '1', check: '2', voucher: '3',
}
const STORNO_REASON: Record<StornoReason, string> = {
  operator_error: '0', customer_return: '1', price_reduction: '2', tax_base_reduction: '2',
}

export class WsTremolFiscalPrinter implements IFiscalPrinter {
  private sendCommand: SendCommandFn
  private seq = 0
  private deviceId: string

  constructor(sendCommand: SendCommandFn, deviceId: string) {
    this.sendCommand = sendCommand
    this.deviceId = deviceId
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0x7F
    return this.seq
  }

  private async send(cmd: number, data: string = ''): Promise<string> {
    const frame = buildTremolFrame(this.nextSeq(), cmd, data)
    logger.info({ deviceId: this.deviceId, cmd, data, frameBytes: Array.from(frame).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '), frameLen: frame.length }, 'Tremol command SENT')
    const responseBuffer = await this.sendCommand(frame)
    logger.info({ deviceId: this.deviceId, cmd, responseBytes: Array.from(responseBuffer).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '), responseLen: responseBuffer.length }, 'Tremol raw response received')
    const response = parseTremolResponse(responseBuffer)
    return response.data
  }

  async connect(): Promise<void> { /* managed by WS bridge */ }
  async disconnect(): Promise<void> { /* managed by WS bridge */ }

  async getStatus(): Promise<FiscalDeviceStatus> {
    try {
      await this.send(TREMOL_CMD.STATUS)
      return { connected: true, paperPresent: true, fiscalMemoryOk: true, errors: [] }
    } catch (e: any) {
      return { connected: false, paperPresent: false, fiscalMemoryOk: false, errors: [e.message] }
    }
  }

  async openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void> {
    // OperNum (1-20);OperPass (up to 6 chars, default 000000);ReceiptFormat;PrintVAT;PrintType$UNP
    // Note: operatorCode is the operator NUMBER (e.g. "0002"), NOT the password.
    // Default Tremol password for all operators is "000000".
    const operNum = parseInt(operatorCode, 10) || 1 // Device expects plain number 1-20
    const operPass = '000000' // Default Tremol M20 operator password
    const data = `${operNum};${operPass};1;1;0$${unpNumber}`
    await this.send(TREMOL_CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Tremol fiscal receipt opened via WS')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    // Tremol cmd 31h format: Name\tVATgroup;Price[*Qty][,Perc]
    // Name separated by TAB, then VATgroup;Price separated by semicolons
    let data = `${name.substring(0, 34)}\t${vatGroup};${price.toFixed(2)}`
    if (quantity !== 1) data += `*${quantity.toFixed(3)}`
    if (discount && discount > 0) data += `,${discount.toFixed(2)}`
    await this.send(TREMOL_CMD.SELL_ARTICLE, data)
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const data = await this.send(TREMOL_CMD.SUBTOTAL)
    return { subtotal: parseFloat(data) || 0 }
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    const code = PAYMENT_CODE[type] || '0'
    await this.send(TREMOL_CMD.PAYMENT, `${code};1;${amount.toFixed(2)}`)
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    await this.send(TREMOL_CMD.CLOSE_RECEIPT)
    let receiptNumber = 'unknown'
    try {
      const info = await this.send(TREMOL_CMD.READ_RECEIPT_INFO)
      receiptNumber = info.split(';')[0] || 'unknown'
    } catch { /* best-effort */ }
    logger.info({ deviceId: this.deviceId, receiptNumber }, 'Tremol receipt closed via WS')
    return { fiscalReceiptNumber: receiptNumber, dateTime: new Date() }
  }

  async printStornoReceipt(
    operatorCode: string, operatorName: string, unpNumber: string,
    originalReceiptNumber: string, originalDate: Date, originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult> {
    const dd = String(originalDate.getDate()).padStart(2, '0')
    const mm = String(originalDate.getMonth() + 1).padStart(2, '0')
    const yy = String(originalDate.getFullYear()).slice(-2)
    const hh = String(originalDate.getHours()).padStart(2, '0')
    const min = String(originalDate.getMinutes()).padStart(2, '0')
    const ss = String(originalDate.getSeconds()).padStart(2, '0')
    const dt = `${dd}-${mm}-${yy} ${hh}:${min}:${ss}`
    const rc = STORNO_REASON[reason]

    const operNum = parseInt(operatorCode, 10) || 1
    const operPass = '000000'
    await this.send(TREMOL_CMD.OPEN_FISCAL_RECEIPT, `${operNum};${operPass};1;1;E;${rc};${originalReceiptNumber};${dt};$${unpNumber}`)
    for (const line of lines) await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
    await this.printPayment(payment.type, -payment.amount)
    await this.send(TREMOL_CMD.CLOSE_RECEIPT)

    let receiptNumber = 'unknown'
    try { receiptNumber = (await this.send(TREMOL_CMD.READ_RECEIPT_INFO)).split(';')[0] || 'unknown' } catch {}
    logger.info({ deviceId: this.deviceId, receiptNumber, reason }, 'Tremol storno via WS')
    return { fiscalReceiptNumber: receiptNumber, dateTime: new Date() }
  }

  async printDailyZReport(): Promise<ZReportResult> {
    await this.send(TREMOL_CMD.DAILY_REPORT, '0;0')
    return { reportNumber: 'unknown', dateTime: new Date(), totalSales: 0, totalReturns: 0, receiptCount: 0 }
  }

  async readDateTime(): Promise<Date> {
    const data = await this.send(TREMOL_CMD.READ_DATE_TIME)
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
    await this.send(TREMOL_CMD.SET_DATE_TIME, `${dd}-${mm}-${yy};${hh}:${min}:${ss}`)
  }
}
