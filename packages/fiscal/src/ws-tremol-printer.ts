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
import { paymentCode } from './types.js'
import { buildTremolFrame, parseTremolResponse, TREMOL_CMD } from './tremol.js'
import { logger } from 'services/logger'
import { stagedPrint } from './print-stage.js'
import type { SendCommandFn } from './ws-fiscal-printer.js'

/** No cash on delivery: it is refused, never printed as cash. */
const PAYMENT_CODE: Partial<Record<FiscalPaymentType, string>> = {
  cash: '0', card: '1', check: '2', voucher: '3',
}
const DRIVER = "LGR's Tremol driver"
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
    // Operator 1, password "0000", Detailed=1, PrintVAT=1, PrintType=2 (Postponed)
    // Postponed mode buffers receipt and prints at CloseReceipt (avoids step-by-step timeout)
    const data = `1;0000;1;1;2$${unpNumber}`
    await this.send(TREMOL_CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Tremol fiscal receipt opened via WS')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    // Tremol cmd 31h format: Name;VATgroup;Price[*Qty][,Perc]
    // ALL fields separated by semicolons (per ZFPLab XML spec)
    let data = `${name.substring(0, 34)};${vatGroup};${price.toFixed(2)}`
    if (quantity !== 1) data += `*${quantity.toFixed(3)}`
    if (discount && discount > 0) data += `,${discount.toFixed(2)}`
    await this.send(TREMOL_CMD.SELL_ARTICLE, data)
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const data = await this.send(TREMOL_CMD.SUBTOTAL)
    return { subtotal: parseFloat(data) || 0 }
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    const code = paymentCode(PAYMENT_CODE, type, DRIVER)
    await this.send(TREMOL_CMD.PAYMENT, `${code};1;${amount.toFixed(2)}`)
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    await this.send(TREMOL_CMD.CLOSE_RECEIPT)
    // Skip ReadReceiptInfo — in postponed print mode, the device is busy printing
    // after CloseReceipt and ReadReceiptInfo would timeout (30s+ delay).
    // Receipt number will be read on next status check if needed.
    logger.info({ deviceId: this.deviceId }, 'Tremol receipt closed via WS')
    return { fiscalReceiptNumber: 'unknown', dateTime: new Date() }
  }

  async printStornoReceipt(
    operatorCode: string, operatorName: string, unpNumber: string,
    originalReceiptNumber: string, originalDate: Date, originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult> {
    return stagedPrint(async (reached) => {
      // A payment this driver cannot print is refused before the storno receipt is opened.
      paymentCode(PAYMENT_CODE, payment.type, DRIVER)
      // This driver closes a sale before it can ask for its number, so a sale may have none to cite.
      if (!/^\d+$/.test(String(originalReceiptNumber ?? ''))) {
        throw new Error(`Storno needs the original fiscal receipt number, got "${originalReceiptNumber}". Read it from the receipt.`)
      }
      const dd = String(originalDate.getDate()).padStart(2, '0')
      const mm = String(originalDate.getMonth() + 1).padStart(2, '0')
      const yy = String(originalDate.getFullYear()).slice(-2)
      const hh = String(originalDate.getHours()).padStart(2, '0')
      const min = String(originalDate.getMinutes()).padStart(2, '0')
      const ss = String(originalDate.getSeconds()).padStart(2, '0')
      const dt = `${dd}-${mm}-${yy} ${hh}:${min}:${ss}`
      const rc = STORNO_REASON[reason]

      await this.send(TREMOL_CMD.OPEN_FISCAL_RECEIPT, `1;0000;1;1;E;${rc};${originalReceiptNumber};${dt};$${unpNumber}`)
      reached('lines')
      for (const line of lines) await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
      reached('paying')
      await this.printPayment(payment.type, -payment.amount)
      reached('closing')
      await this.send(TREMOL_CMD.CLOSE_RECEIPT)

      let receiptNumber = 'unknown'
      try { receiptNumber = (await this.send(TREMOL_CMD.READ_RECEIPT_INFO)).split(';')[0] || 'unknown' } catch {}
      logger.info({ deviceId: this.deviceId, receiptNumber, reason }, 'Tremol storno via WS')
      return { fiscalReceiptNumber: receiptNumber, dateTime: new Date() }
    })
  }

  async printDailyZReport(): Promise<ZReportResult> {
    await this.send(TREMOL_CMD.DAILY_REPORT, 'Z')
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

  // ── Non-fiscal receipt methods ──

  async openNonFiscalReceipt(operatorCode: string): Promise<void> {
    // Operator 1, password "0000", Reserve=0, PrintType=1 (Postponed Printing)
    // Postponed mode buffers all text and prints at CloseNonFiscalReceipt
    // Step-by-step mode (0) causes 15+ second delays while header prints
    await this.send(TREMOL_CMD.OPEN_NON_FISCAL_RECEIPT, '1;0000;0;1')
    logger.info({ deviceId: this.deviceId, operatorCode }, 'Tremol non-fiscal receipt opened via WS')
  }

  async printNonFiscalText(text: string): Promise<void> {
    await this.send(TREMOL_CMD.PRINT_FREE_TEXT, text.substring(0, 42))
  }

  async closeNonFiscalReceipt(): Promise<void> {
    await this.send(TREMOL_CMD.CLOSE_NON_FISCAL_RECEIPT)
    logger.info({ deviceId: this.deviceId }, 'Tremol non-fiscal receipt closed via WS')
  }

  // ── Report and operator commands ──

  private formatDate(d: Date): string {
    // DDMMYY format (no dashes) per ZFPLab spec
    return `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(-2)}`
  }

  async printDailyXReport(): Promise<ZReportResult> {
    await this.send(TREMOL_CMD.DAILY_REPORT, 'X')
    return { reportNumber: 'unknown', dateTime: new Date(), totalSales: 0, totalReturns: 0, receiptCount: 0 }
  }

  async printOperatorReport(operatorNumber = 0): Promise<void> {
    await this.send(TREMOL_CMD.OPERATOR_REPORT, `X;${operatorNumber}`)
  }

  async printFiscalMemoryReportByDate(startDate: Date, endDate: Date, detailed = false): Promise<void> {
    const cmd = detailed ? TREMOL_CMD.DETAILED_FM_REPORT_BY_DATE : TREMOL_CMD.BRIEF_FM_REPORT_BY_DATE
    await this.send(cmd, `${this.formatDate(startDate)};${this.formatDate(endDate)}`)
  }

  async printFiscalMemoryReportByNumber(startNumber: number, endNumber: number, detailed = false): Promise<void> {
    const cmd = detailed ? TREMOL_CMD.DETAILED_FM_REPORT_BY_NUMBER : TREMOL_CMD.BRIEF_FM_REPORT_BY_NUMBER
    const start = String(startNumber).padStart(4, '0')
    const end = String(endNumber).padStart(4, '0')
    await this.send(cmd, `${start};${end}`)
  }

  async printEJReport(startDate: Date, endDate: Date): Promise<void> {
    await this.send(TREMOL_CMD.DAILY_REPORT, `J1;D;${this.formatDate(startDate)};${this.formatDate(endDate)}`)
  }

  async programOperator(operatorNumber: number, password: string, name: string): Promise<void> {
    // Format: Number;Name[20];Password[6]
    await this.send(TREMOL_CMD.PROGRAM_OPERATOR, `${operatorNumber};${name};${password}`)
  }

  async readOperator(operatorNumber: number): Promise<{ number: number; name: string }> {
    const data = await this.send(TREMOL_CMD.READ_OPERATOR, String(operatorNumber))
    // Response: Number;Name[20];Password[6]
    const parts = data.split(';')
    return { number: operatorNumber, name: (parts[1] || '').trim() }
  }
}
