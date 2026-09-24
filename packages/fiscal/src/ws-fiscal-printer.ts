/**
 * WebSocket-based fiscal printer transport.
 *
 * Implements IFiscalPrinter by routing Datecs binary commands through a
 * WebSocket connection to a browser that has the physical printer connected
 * via Web Serial API.
 *
 * The browser acts as a transparent serial proxy — it receives the raw
 * Datecs frame bytes, writes them to the serial port, reads the response,
 * and sends it back.
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
  FiscalExchangeOptions,
} from './types.js'
import { buildFrame, parseResponse, CMD } from './datecs.js'
import { logger } from 'services/logger'

const PAYMENT_CODE: Record<FiscalPaymentType, string> = {
  cash: 'P',
  card: 'N',
  check: 'C',
  voucher: 'D',
}

const STORNO_REASON_CODE: Record<StornoReason, number> = {
  operator_error: 0,
  customer_return: 1,
  price_reduction: 2,
  tax_base_reduction: 2,
}

export type SendCommandFn = (frame: Buffer, opts?: FiscalExchangeOptions) => Promise<Buffer>

/**
 * Fiscal printer that routes commands through a WebSocket bridge to a browser.
 */
export class WebSocketFiscalPrinter implements IFiscalPrinter {
  private sendCommand: SendCommandFn
  private seq = 0
  private deviceId: string

  constructor(sendCommand: SendCommandFn, deviceId: string) {
    this.sendCommand = sendCommand
    this.deviceId = deviceId
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0xFF
    return this.seq
  }

  private async send(cmd: number, data: string = ''): Promise<string> {
    const frame = buildFrame(this.nextSeq(), cmd, data)
    const responseBuffer = await this.sendCommand(frame)
    const response = parseResponse(responseBuffer)
    return response.data
  }

  async connect(): Promise<void> {
    // No-op — connection managed by WS bridge
  }

  async disconnect(): Promise<void> {
    // No-op — connection managed by WS bridge
  }

  async getStatus(): Promise<FiscalDeviceStatus> {
    try {
      const data = await this.send(CMD.GET_STATUS)
      const parts = data.split(',')
      return {
        connected: true,
        paperPresent: true,
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
    const data = `${operatorCode}\t${operatorCode}\t${unpNumber}`
    await this.send(CMD.OPEN_FISCAL_RECEIPT, data)
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Fiscal receipt opened via WS bridge')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void> {
    let data = `${name}\t${vatGroup}${price.toFixed(2)}`
    if (quantity !== 1) data += `*${quantity.toFixed(3)}`
    if (discount && discount > 0) data += `,${discount.toFixed(2)}`
    await this.send(CMD.SALE_LINE, data)
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const data = await this.send(CMD.SUBTOTAL)
    return { subtotal: parseFloat(data) || 0 }
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    const code = PAYMENT_CODE[type] || 'P'
    await this.send(CMD.PAYMENT, `\t${code}${amount.toFixed(2)}`)
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    const data = await this.send(CMD.CLOSE_RECEIPT)
    const parts = data.split(',')
    const result: FiscalReceiptResult = {
      fiscalReceiptNumber: parts[0] || 'unknown',
      dateTime: new Date(),
    }
    logger.info({ deviceId: this.deviceId, receiptNumber: result.fiscalReceiptNumber }, 'Fiscal receipt closed via WS bridge')
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
    const dd = String(originalDate.getDate()).padStart(2, '0')
    const mm = String(originalDate.getMonth() + 1).padStart(2, '0')
    const yy = String(originalDate.getFullYear()).slice(-2)
    const dateStr = `${dd}-${mm}-${yy}`
    const reasonCode = STORNO_REASON_CODE[reason]

    await this.send(CMD.OPEN_STORNO, `${operatorCode}\t${operatorCode}\t${unpNumber}\t${reasonCode}\t${originalReceiptNumber}\t${dateStr}\t${originalUNP}`)

    for (const line of lines) {
      await this.printSaleLine(line.name, -line.quantity, line.price, line.vatGroup)
    }

    await this.printPayment(payment.type, -payment.amount)
    const data = await this.send(CMD.CLOSE_RECEIPT)
    const parts = data.split(',')

    const result: FiscalStornoResult = {
      fiscalReceiptNumber: parts[0] || 'unknown',
      dateTime: new Date(),
    }
    logger.info({ deviceId: this.deviceId, stornoReceiptNumber: result.fiscalReceiptNumber }, 'Storno receipt via WS bridge')
    return result
  }

  async printDailyZReport(): Promise<ZReportResult> {
    const data = await this.send(CMD.DAILY_Z_REPORT)
    const parts = data.split(',')
    return {
      reportNumber: parts[0] || 'unknown',
      dateTime: new Date(),
      totalSales: parseFloat(parts[1]) || 0,
      totalReturns: parseFloat(parts[2]) || 0,
      receiptCount: parseInt(parts[3]) || 0,
    }
  }

  async readDateTime(): Promise<Date> {
    const data = await this.send(CMD.GET_DATE_TIME)
    const [datePart, timePart] = data.trim().split(' ')
    const [dd, mmm, yy] = (datePart || '').split('-').map(Number)
    const [hh, min, ss] = (timePart || '').split(':').map(Number)
    return new Date(2000 + (yy || 0), (mmm || 1) - 1, dd || 1, hh || 0, min || 0, ss || 0)
  }

  async syncDateTime(dateTime: Date): Promise<void> {
    const dd = String(dateTime.getDate()).padStart(2, '0')
    const mm = String(dateTime.getMonth() + 1).padStart(2, '0')
    const yy = String(dateTime.getFullYear()).slice(-2)
    const hh = String(dateTime.getHours()).padStart(2, '0')
    const min = String(dateTime.getMinutes()).padStart(2, '0')
    const ss = String(dateTime.getSeconds()).padStart(2, '0')
    await this.send(CMD.SET_DATE_TIME, `${dd}-${mm}-${yy} ${hh}:${min}:${ss}`)
  }
}
