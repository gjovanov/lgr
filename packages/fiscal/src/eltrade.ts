/**
 * Eltrade fiscal device driver — A1/A3/A6/B1/B3 KL cash registers (in PC mode) and the
 * Eltrade fiscal printers.
 *
 * Protocol: "ELTRADE Комуникационен протокол" v1.1.1 — the ISL/Datecs framing in
 * `isl-frame.ts`, 115200 8N1, text in Windows-1251. Cross-checked against ErpNet.FP's
 * `BgEltradeIslFiscalPrinter`, which has run against real Eltrade devices.
 *
 * Device setup: with USB connected the ECR shows „Връзка с PC" and answers from its main menu
 * (field-verified on a non-fiscalized A3 KL, 2026-09-26). ErpNet.FP's notes ask for mode
 * „1. Регистрация"; that device did not need it. A device left inside a sub-menu may not answer,
 * which surfaces here as a timeout with that hint in the message.
 *
 * What differs from the other drivers, and why:
 *  - A fiscal receipt is opened with 90h `<OperName>,<UNP>` (the Н-18 command), not 30h.
 *  - Card is payment code 'L' (Datecs uses 'N', which on Eltrade means cheque).
 *  - A storno is the same 90h with `S,<FM>,<reason>,<receipt no>,<time>` and POSITIVE lines;
 *    it carries the ORIGINAL sale's УНП (ErpNet.FP: "You MUST NOT create new unique number
 *    for the reversal").
 *  - A command counts as failed only on the per-command rejection bits (syntax error,
 *    invalid command, not allowed now, overflow; plus no paper / mechanism failure for a
 *    printing command). The "general error" bit and the NRA-link bit stay raised on
 *    otherwise healthy devices (ErpNet.FP #166 — an A1 that printed fine while ErpNet.FP
 *    aborted every receipt on them), so they are reported, not fatal.
 *  - The device keeps Bulgarian local time; the API runs on UTC. Clock values go through
 *    `zoned-time.ts`, never `getHours()`.
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
import { encodeCp1251, decodeCp1251 } from './cp1251.js'
import { ISL, ISL_MAX_DATA, ISL_SEQ_SPAN, buildIslFrame, parseIslStream, toHex } from './isl-frame.js'
import {
  FISCAL_TIME_ZONE,
  formatDeviceDate,
  formatDeviceDateTime,
  formatDeviceIsoDateTime,
  parseDeviceDateTime,
} from './zoned-time.js'
import { logger } from 'services/logger'

export const ELTRADE_CMD = {
  OPEN_NON_FISCAL: 0x26,
  CLOSE_NON_FISCAL: 0x27,
  PRINT_NON_FISCAL_TEXT: 0x2A,
  SALE: 0x31,
  SUBTOTAL: 0x33,
  TOTAL: 0x35,
  CLOSE_FISCAL: 0x38,
  CANCEL_FISCAL: 0x3C,
  SET_DATE_TIME: 0x3D,
  GET_DATE_TIME: 0x3E,
  DAILY_REPORT: 0x45,
  DETAILED_FM_REPORT_BY_NUMBER: 0x49,
  GET_STATUS: 0x4A,
  SHORT_FM_REPORT_BY_DATE: 0x4F,
  DIAGNOSTIC_INFO: 0x5A,
  DETAILED_FM_REPORT_BY_DATE: 0x5E,
  SHORT_FM_REPORT_BY_NUMBER: 0x5F,
  GET_TAX_RATES: 0x61,
  SET_OPERATOR: 0x66,
  LAST_DOCUMENT_NUMBER: 0x71,
  OPEN_FISCAL: 0x90,
} as const

const COMMAND_NAME: Record<number, string> = {
  0x26: 'open non-fiscal receipt',
  0x27: 'close non-fiscal receipt',
  0x2A: 'print non-fiscal text',
  0x31: 'register sale',
  0x33: 'subtotal',
  0x35: 'payment',
  0x38: 'close fiscal receipt',
  0x3C: 'cancel fiscal receipt',
  0x3D: 'set date/time',
  0x3E: 'read date/time',
  0x45: 'daily report',
  0x49: 'detailed FM report by number',
  0x4A: 'read status',
  0x4F: 'short FM report by date',
  0x5A: 'read diagnostic info',
  0x5E: 'detailed FM report by date',
  0x5F: 'short FM report by number',
  0x61: 'read tax rates',
  0x66: 'set operator',
  0x71: 'read last document number',
  0x90: 'open fiscal receipt',
}

const cmdLabel = (cmd: number) => `"${COMMAND_NAME[cmd] ?? 'command'}" (${cmd.toString(16).toUpperCase()}h)`

/** Payment codes of command 35h. */
const PAYMENT_MODE: Record<FiscalPaymentType, string> = {
  cash: 'P',
  card: 'L',
  check: 'N',
  voucher: 'C',
}

/** Reason codes of a 90h storno. 'O' is only valid for receipts from this same fiscal memory. */
const STORNO_REASON: Record<StornoReason, string> = {
  operator_error: 'O',
  customer_return: 'R',
  price_reduction: 'T',
  tax_base_reduction: 'T',
}

/** Tax group letters in device order (А..З). */
const TAX_GROUPS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'] as const

/** Field limits from the protocol. */
const ITEM_TEXT_MAX = 30
const FREE_TEXT_MAX = 46
const OPERATOR_NAME_MAX = 24

const TIMEOUT_MS = {
  /** Reads and settings: the device answers within 60 ms (protocol §В). */
  standard: 30_000,
  /** Anything that prints a line or a document. */
  print: 60_000,
  /** Z-report and fiscal-memory reports print for minutes. */
  report: 300_000,
}

/** A retransmit reuses the SEQ, so the device replays rather than re-executes. */
const MAX_ATTEMPTS = 3
/** Do not write the clock for drift smaller than this. */
const CLOCK_TOLERANCE_MS = 5_000
/**
 * Never move the device clock back by more than this. Н-18 makes a device refuse (and some
 * block) a date earlier than its last record, and a big backward jump means one of the two
 * clocks is wrong — that needs a person, not an automatic sync.
 */
const MAX_CLOCK_ROLLBACK_MS = 5 * 60_000

const NOT_RESPONDING_HINT =
  'Check that the Eltrade is switched on, at its main menu (not inside a sub-menu), and on the port that was picked.'
const GARBLED_HINT =
  'Repeated NAKs or unreadable answers usually mean a speed mismatch — the device and the POS baud selector must both be 115200.'

// ── Status ──────────────────────────────────────────────────────────────────

export interface EltradeStatus {
  raw: Uint8Array
  // the command was not executed
  syntaxError: boolean
  invalidCommand: boolean
  notAllowed: boolean
  overflow: boolean
  // printing
  noPaper: boolean
  lowPaper: boolean
  printerFailure: boolean
  coverOpen: boolean
  // device state
  clockNotSet: boolean
  ramCleared: boolean
  lowBattery: boolean
  ramCorrupted: boolean
  terminalDown: boolean
  fiscalReceiptOpen: boolean
  nonFiscalReceiptOpen: boolean
  klenFull: boolean
  klenNearFull: boolean
  // fiscal memory
  fmWriteError: boolean
  fmReadError: boolean
  fmFull: boolean
  fmNearFull: boolean
  fmReadOnly: boolean
  fmLastRecordFailed: boolean
  fmFormatted: boolean
  fiscalized: boolean
  taxRatesSet: boolean
  eikSet: boolean
  serialSet: boolean
}

/** Decode the 6 status bytes (protocol "СТАТУС БИТОВЕ", v1.1.1). Byte 3 is the DIP switches. */
export function decodeEltradeStatus(raw: Uint8Array): EltradeStatus {
  const bit = (byte: number, n: number) => (((raw[byte] ?? 0) >> n) & 1) === 1
  return {
    raw,
    syntaxError: bit(0, 0),
    invalidCommand: bit(0, 1),
    clockNotSet: bit(0, 2),
    printerFailure: bit(0, 4),
    coverOpen: bit(0, 6),
    overflow: bit(1, 0),
    notAllowed: bit(1, 1),
    ramCleared: bit(1, 2),
    lowBattery: bit(1, 3),
    ramCorrupted: bit(1, 4),
    terminalDown: bit(1, 6),
    noPaper: bit(2, 0),
    lowPaper: bit(2, 1),
    klenFull: bit(2, 2),
    fiscalReceiptOpen: bit(2, 3),
    klenNearFull: bit(2, 4),
    nonFiscalReceiptOpen: bit(2, 5),
    fmWriteError: bit(4, 0),
    eikSet: bit(4, 1),
    serialSet: bit(4, 2),
    fmNearFull: bit(4, 3),
    fmFull: bit(4, 4),
    fmReadOnly: bit(5, 0),
    fmFormatted: bit(5, 1),
    fmLastRecordFailed: bit(5, 2),
    fiscalized: bit(5, 3),
    taxRatesSet: bit(5, 4),
    fmReadError: bit(5, 5),
  }
}

type StatusFlag = Exclude<keyof EltradeStatus, 'raw'>

const CONDITIONS: { flag: StatusFlag; text: string; severity: 'error' | 'warning' }[] = [
  { flag: 'noPaper', text: 'out of paper', severity: 'error' },
  { flag: 'printerFailure', text: 'printing mechanism failure', severity: 'error' },
  { flag: 'coverOpen', text: 'printer cover is open', severity: 'error' },
  { flag: 'clockNotSet', text: 'device clock is not set', severity: 'error' },
  { flag: 'ramCorrupted', text: 'RAM corrupted after power-on', severity: 'error' },
  { flag: 'lowBattery', text: 'clock battery low (clock was reset)', severity: 'error' },
  { flag: 'klenFull', text: 'electronic journal (КЛЕН) is full', severity: 'error' },
  { flag: 'fmFull', text: 'fiscal memory is full', severity: 'error' },
  { flag: 'fmWriteError', text: 'fiscal memory write error', severity: 'error' },
  { flag: 'fmReadError', text: 'fiscal memory read error', severity: 'error' },
  { flag: 'fmReadOnly', text: 'fiscal memory is locked (read-only)', severity: 'error' },
  { flag: 'fmLastRecordFailed', text: 'last fiscal memory record failed', severity: 'error' },
  { flag: 'ramCleared', text: 'operational memory was cleared', severity: 'warning' },
  { flag: 'terminalDown', text: 'NRA link (built-in tax terminal) is not responding', severity: 'warning' },
  { flag: 'lowPaper', text: 'paper is running low', severity: 'warning' },
  { flag: 'klenNearFull', text: 'electronic journal (КЛЕН) is almost full', severity: 'warning' },
  { flag: 'fmNearFull', text: 'fewer than 50 fiscal memory records left', severity: 'warning' },
]

/** Human-readable conditions raised in a status, split by whether they stop the device. */
export function describeEltradeStatus(s: EltradeStatus): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const c of CONDITIONS) {
    if (s[c.flag]) (c.severity === 'error' ? errors : warnings).push(c.text)
  }
  return { errors, warnings }
}

/** Why a command was not executed; empty when it was. */
export function eltradeRejectionReasons(s: EltradeStatus, prints: boolean): string[] {
  const reasons: string[] = []
  if (s.syntaxError) reasons.push('syntax error in the command data')
  if (s.invalidCommand) reasons.push('command not supported by this device')
  if (s.notAllowed) reasons.push('not allowed in the current state of the device')
  if (s.overflow) reasons.push('amount overflow')
  if (prints && s.noPaper) reasons.push('out of paper')
  if (prints && s.printerFailure) reasons.push('printing mechanism failure')
  return reasons
}

function stateHints(s: EltradeStatus): string[] {
  const hints: string[] = []
  if (s.fiscalReceiptOpen) hints.push('a fiscal receipt is open')
  if (s.nonFiscalReceiptOpen) hints.push('a non-fiscal receipt is open')
  const { errors, warnings } = describeEltradeStatus(s)
  return [...hints, ...errors, ...warnings]
}

// ── Parsing helpers ────────────────────────────────────────────────────────

export interface EltradeDiagnostics {
  model?: string
  firmwareVersion?: string
  serialNumber?: string
  fiscalMemoryNumber?: string
  raw: string
}

/**
 * 5Ah answer. The protocol lists `<Name>,<FwRev> <FwDate> <FwTime>,<Chk>,<Sw>,<Ser>,<FM>`
 * but real devices send an extra field (ErpNet.FP reads 7), so fields are recognised by
 * shape rather than position: the serial is two letters + six digits (ED123456), the fiscal
 * memory number eight digits.
 */
export function parseEltradeDiagnostics(text: string): EltradeDiagnostics {
  const fields = text.split(',').map(f => f.trim())
  const serialNumber = fields.find(f => /^[A-Z]{2}\d{6}$/.test(f))
  const fiscalMemoryNumber = [...fields].reverse().find(f => /^\d{8}$/.test(f))
  const firmwareVersion = fields.find(f => /\d{2}[A-Za-z]{3}\d{2}/.test(f)) ?? fields[1]
  return {
    model: fields[0] || undefined,
    firmwareVersion: firmwareVersion || undefined,
    serialNumber,
    fiscalMemoryNumber,
    raw: text,
  }
}

/**
 * An amount as a device reports it. With a decimal point it is read as written; without one
 * it is an integer count of cents — the ISL convention ErpNet.FP also relies on.
 */
export function parseDeviceAmount(raw: string | undefined): number | null {
  const m = /^\s*([+-]?)(\d+)(?:[.,](\d+))?\s*$/.exec(raw ?? '')
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  if (m[3] !== undefined) return sign * Number(`${m[2]}.${m[3]}`)
  return (sign * Number(m[2])) / 100
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Printable text: control characters would be read as field separators by the device. */
export function sanitizeDeviceText(text: string): string {
  return String(text ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ')
}

/** Split a product name over the two 30-character lines a sale may carry. */
export function splitItemText(name: string): [string, string | undefined] {
  const clean = sanitizeDeviceText(name).replace(/\s+/g, ' ').trim()
  if (clean.length <= ITEM_TEXT_MAX) return [clean, undefined]
  let cut = clean.lastIndexOf(' ', ITEM_TEXT_MAX)
  if (cut < ITEM_TEXT_MAX / 2) cut = ITEM_TEXT_MAX
  const first = clean.slice(0, cut).trim()
  const second = clean.slice(cut).trim().slice(0, ITEM_TEXT_MAX)
  return [first, second || undefined]
}

function formatQuantity(q: number): string {
  return String(Number(q.toFixed(3)))
}

const UNP_PATTERN = /^[A-Z]{2}\d{6}-[0-9A-Za-z]{4}-\d{7}$/

// ── Driver ─────────────────────────────────────────────────────────────────

export type EltradeExchange = (frame: Buffer, opts: FiscalExchangeOptions) => Promise<Buffer | Uint8Array>

export interface EltradeTransport {
  exchange: EltradeExchange
  open?: () => Promise<void>
  close?: () => Promise<void> | void
}

export interface EltradeOptions {
  /** Zone of the device clock. Bulgarian devices keep Bulgarian time. */
  timeZone?: string
}

export class EltradeError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'timeout' | 'protocol' | 'input',
    readonly command?: number,
    readonly status?: EltradeStatus,
  ) {
    super(message)
    this.name = 'EltradeError'
  }
}

interface RequestOptions {
  /** Throw when the device reports the command as not executed (default true). */
  check?: boolean
  /** The command prints — no paper / mechanism failure also mean "not executed". */
  prints?: boolean
  timeoutMs?: number
  /** Appended to a rejection message. */
  hint?: string
}

interface Reply {
  data: string
  status: EltradeStatus
}

interface ReceiptState {
  /** What the registered lines total, by the device's rounding. */
  expected: number
  /** Amount still due, once read from the device. */
  remaining: number | null
  /** Result code of the last 35h answer. */
  lastPaidCode: string | null
}

/** Transport failures where a retransmit cannot help. */
function isFatalTransportError(message: string): boolean {
  return /disconnected|not connected|failed to send|bridge command timeout/i.test(message)
}

export class EltradeFiscalPrinter implements IFiscalPrinter {
  private readonly exchangeFn: EltradeExchange
  private readonly openFn?: () => Promise<void>
  private readonly closeFn?: () => Promise<void> | void
  private readonly timeZone: string
  /** 0..5Fh; the wire byte is 20h + seq. Random start — see the priming read in `request()`. */
  private seq = Math.floor(Math.random() * ISL_SEQ_SPAN)
  private primed = false
  private queue: Promise<unknown> = Promise.resolve()
  private receipt: ReceiptState | null = null
  private diagnostics: EltradeDiagnostics | null = null
  private taxRates: (number | null)[] | null = null
  /** Status carried by the most recent answer. */
  lastStatus: EltradeStatus | null = null

  constructor(
    transport: EltradeTransport | EltradeExchange,
    private readonly deviceId: string,
    options: EltradeOptions = {},
  ) {
    if (typeof transport === 'function') {
      this.exchangeFn = transport
    } else {
      this.exchangeFn = transport.exchange
      this.openFn = transport.open
      this.closeFn = transport.close
    }
    this.timeZone = options.timeZone || FISCAL_TIME_ZONE
  }

  // ── Transport plumbing ──

  /**
   * One command at a time per device. Callers are not coordinated — a sale, the periodic
   * clock sync and a status probe can all arrive together — and interleaved frames on one
   * serial line are unrecoverable.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private nextSeqByte(): number {
    this.seq = (this.seq + 1) % ISL_SEQ_SPAN
    return ISL.OFFSET + this.seq
  }

  private request(cmd: number, data = '', opts: RequestOptions = {}): Promise<Reply> {
    return this.serialize(async () => {
      // The device answers a repeated SEQ by replaying its last answer WITHOUT executing the
      // command. A new driver instance can collide with the last SEQ of the previous session,
      // so the first exchange is a harmless status read: a replay there costs nothing and
      // `transact` moves to a fresh SEQ; afterwards SEQs only advance.
      if (!this.primed) {
        await this.transact(ELTRADE_CMD.GET_STATUS, 'X', { check: false })
        this.primed = true
      }
      return this.transact(cmd, data, opts)
    })
  }

  private async transact(cmd: number, data: string, opts: RequestOptions): Promise<Reply> {
    const payload = encodeCp1251(data)
    if (payload.length > ISL_MAX_DATA) {
      throw new EltradeError(`Eltrade ${cmdLabel(cmd)}: data too long (${payload.length} bytes, max ${ISL_MAX_DATA})`, 'input', cmd)
    }
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS.standard
    let seqByte = this.nextSeqByte()
    let frame = Buffer.from(buildIslFrame(seqByte, cmd, payload))
    let replays = 0
    let problem = ''

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      logger.info({ deviceId: this.deviceId, cmd: cmdLabel(cmd), data, frame: toHex(frame), attempt }, 'Eltrade command SENT')
      let raw: Uint8Array
      try {
        raw = new Uint8Array(await this.exchangeFn(frame, { protocol: 'isl', timeoutMs }))
      } catch (e: any) {
        const message = String(e?.message || e)
        if (isFatalTransportError(message)) {
          throw new EltradeError(`Eltrade ${cmdLabel(cmd)}: ${message}`, 'timeout', cmd)
        }
        problem = message
        logger.warn({ deviceId: this.deviceId, cmd: cmdLabel(cmd), attempt, error: message }, 'Eltrade exchange failed — resending with the same SEQ')
        continue
      }

      const parsed = parseIslStream(raw)
      const answer = parsed.frames.find(f => f.seq === seqByte)
      logger.info({ deviceId: this.deviceId, cmd: cmdLabel(cmd), response: toHex(raw.subarray(0, 96)), frames: parsed.frames.length, syn: parsed.syn, nak: parsed.nak }, 'Eltrade response received')

      if (answer) {
        if (answer.cmd !== cmd) {
          // A replay of the device's previous answer: our SEQ matched the last one it saw.
          if (++replays > 2) throw new EltradeError(`Eltrade ${cmdLabel(cmd)}: device keeps replaying an older answer`, 'protocol', cmd)
          seqByte = this.nextSeqByte()
          frame = Buffer.from(buildIslFrame(seqByte, cmd, payload))
          attempt--
          continue
        }
        const status = decodeEltradeStatus(answer.status)
        this.lastStatus = status
        const text = decodeCp1251(answer.data)
        if (opts.check !== false) this.assertExecuted(cmd, status, opts)
        return { data: text, status }
      }

      problem = parsed.nak
        ? 'the device rejected the frame (NAK)'
        : `no valid answer (${raw.length ? toHex(raw.subarray(0, 32)) : 'nothing received'})`
      logger.warn({ deviceId: this.deviceId, cmd: cmdLabel(cmd), attempt, problem }, 'Eltrade: resending with the same SEQ')
    }

    if (/timeout|no valid answer \(nothing/i.test(problem) || !problem) {
      throw new EltradeError(`Eltrade ${cmdLabel(cmd)}: no response from the device (timeout). ${NOT_RESPONDING_HINT}`, 'timeout', cmd)
    }
    throw new EltradeError(`Eltrade ${cmdLabel(cmd)}: ${problem}. ${GARBLED_HINT}`, 'protocol', cmd)
  }

  private assertExecuted(cmd: number, status: EltradeStatus, opts: RequestOptions): void {
    const reasons = eltradeRejectionReasons(status, !!opts.prints)
    if (!reasons.length) return
    const state = stateHints(status)
    let message = `Eltrade rejected ${cmdLabel(cmd)}: ${reasons.join(', ')}`
    if (state.length) message += ` — device state: ${state.join(', ')}`
    if (opts.hint) message += `. ${opts.hint}`
    throw new EltradeError(message, 'rejected', cmd, status)
  }

  // ── Connection ──

  async connect(): Promise<void> {
    await this.openFn?.()
  }

  async disconnect(): Promise<void> {
    await this.closeFn?.()
  }

  // ── Status & identity ──

  async readStatus(): Promise<EltradeStatus> {
    return (await this.request(ELTRADE_CMD.GET_STATUS, 'X', { check: false })).status
  }

  async readDiagnostics(): Promise<EltradeDiagnostics> {
    if (this.diagnostics) return this.diagnostics
    // Calc '0': skip the firmware checksum (the device then answers FFFF for it) — nothing here
    // needs it, and computing it on every connect only keeps the device busy.
    const { data } = await this.request(ELTRADE_CMD.DIAGNOSTIC_INFO, '0', { check: false, timeoutMs: TIMEOUT_MS.print })
    const d = parseEltradeDiagnostics(data)
    if (!d.serialNumber && !d.fiscalMemoryNumber) {
      throw new EltradeError(`Eltrade ${cmdLabel(ELTRADE_CMD.DIAGNOSTIC_INFO)}: unexpected answer "${data}"`, 'protocol', ELTRADE_CMD.DIAGNOSTIC_INFO)
    }
    this.diagnostics = d
    return d
  }

  async getStatus(): Promise<FiscalDeviceStatus> {
    try {
      const status = await this.readStatus()
      const diag = await this.readDiagnostics().catch(() => null)
      const dateTime = await this.readDateTime().catch(() => undefined)
      const last = await this.readLastDocumentNumber().catch(() => undefined)
      const { errors, warnings } = describeEltradeStatus(status)
      return {
        connected: true,
        paperPresent: !status.noPaper,
        fiscalMemoryOk: !(status.fmFull || status.fmWriteError || status.fmReadError || status.fmReadOnly || status.fmLastRecordFailed),
        dateTime,
        serialNumber: diag?.serialNumber,
        firmwareVersion: diag?.firmwareVersion,
        model: diag?.model,
        fiscalMemoryNumber: diag?.fiscalMemoryNumber,
        fiscalized: status.fiscalized,
        lastReceiptNumber: last !== undefined ? Number(last) : undefined,
        errors,
        warnings,
      }
    } catch (e: any) {
      return { connected: false, paperPresent: false, fiscalMemoryOk: false, errors: [e.message] }
    }
  }

  private async readLastDocumentNumber(): Promise<string | undefined> {
    const { data } = await this.request(ELTRADE_CMD.LAST_DOCUMENT_NUMBER, '', { check: false })
    const n = data.trim()
    return /^\d+$/.test(n) ? n : undefined
  }

  private async readTaxRates(): Promise<(number | null)[]> {
    if (this.taxRates) return this.taxRates
    const { data } = await this.request(ELTRADE_CMD.GET_TAX_RATES, '', { check: false })
    const rates = data.split(',').map(s => {
      const v = Number.parseFloat(s.replace('%', '').trim())
      return Number.isFinite(v) ? v : null
    })
    if (rates.length < 4) {
      throw new EltradeError(`Eltrade ${cmdLabel(ELTRADE_CMD.GET_TAX_RATES)}: unexpected answer "${data}"`, 'protocol', ELTRADE_CMD.GET_TAX_RATES)
    }
    this.taxRates = rates
    return rates
  }

  /**
   * The group to register a line in. The caller's Н-18 mapping is checked against the rates
   * actually programmed on the device, so a mis-set device or an odd product rate fails
   * loudly instead of booking the sale under the wrong VAT.
   */
  private async resolveTaxGroup(vatGroup: VatGroup, taxRate?: number): Promise<string> {
    if (taxRate === undefined || !Number.isFinite(taxRate)) return vatGroup
    let rates: (number | null)[]
    try {
      rates = await this.readTaxRates()
    } catch (e: any) {
      logger.warn({ deviceId: this.deviceId, error: e.message }, 'Eltrade: tax rates unreadable — using the Н-18 mapping unchecked')
      return vatGroup
    }
    // A reading with neither 20 % nor 9 % anywhere is a parse we do not understand, not a device
    // with no standard rates — do not let it block every sale.
    if (!rates.some(r => r !== null && (Math.abs(r - 20) < 0.005 || Math.abs(r - 9) < 0.005))) {
      logger.warn({ deviceId: this.deviceId, rates }, 'Eltrade: tax rates not recognised — using the Н-18 mapping unchecked')
      return vatGroup
    }
    const matches = (g: string) => {
      const r = rates[TAX_GROUPS.indexOf(g as typeof TAX_GROUPS[number])]
      return r !== null && r !== undefined && Math.abs(r - taxRate) < 0.005
    }
    if (matches(vatGroup)) return vatGroup
    // В is the liquid-fuels group (Н-18 чл. 27) — never a fallback, whatever its rate.
    const alternative = TAX_GROUPS.find(g => g !== 'В' && matches(g))
    if (alternative) {
      logger.warn({ deviceId: this.deviceId, requested: vatGroup, used: alternative, taxRate }, 'Eltrade: VAT group taken from the device programming')
      return alternative
    }
    const programmed = TAX_GROUPS.map((g, i) => `${g}=${rates[i] ?? '—'}`).join(' ')
    throw new EltradeError(
      `No VAT group on the Eltrade is programmed at ${taxRate}% (device: ${programmed}). Check the product's tax rate or have the device's tax rates checked by service.`,
      'input',
    )
  }

  // ── Receipt hygiene ──

  /**
   * An interrupted sale leaves a receipt open, and every later command is then refused.
   * Close or void it before starting a new document.
   */
  private async ensureNoOpenReceipt(): Promise<void> {
    const status = await this.readStatus()
    if (status.nonFiscalReceiptOpen) {
      logger.warn({ deviceId: this.deviceId }, 'Eltrade: closing a non-fiscal receipt left open')
      await this.request(ELTRADE_CMD.CLOSE_NON_FISCAL, '', { check: false, timeoutMs: TIMEOUT_MS.print })
    }
    if (status.fiscalReceiptOpen) {
      logger.warn({ deviceId: this.deviceId }, 'Eltrade: a fiscal receipt was left open by an interrupted sale — voiding it')
      await this.cancelFiscalReceipt()
    }
  }

  async cancelFiscalReceipt(): Promise<void> {
    this.receipt = null
    const { status } = await this.request(ELTRADE_CMD.CANCEL_FISCAL, '', { check: false, timeoutMs: TIMEOUT_MS.print })
    if (!status.fiscalReceiptOpen) return
    // 3Ch is refused once a payment has gone through; such a receipt can only be finished.
    // Leaving it open would block the device, so settle the remainder in cash and close it.
    logger.error({ deviceId: this.deviceId }, 'Eltrade: receipt could not be voided after a payment — completing it with the remainder in cash')
    await this.request(ELTRADE_CMD.TOTAL, '\t', { check: false, timeoutMs: TIMEOUT_MS.print })
    await this.request(ELTRADE_CMD.CLOSE_FISCAL, '', { check: false, timeoutMs: TIMEOUT_MS.print })
  }

  private operatorLabel(name: string, code: string): string {
    const clean = sanitizeDeviceText(name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    return (clean || `Оператор ${code}`).slice(0, OPERATOR_NAME_MAX)
  }

  /** Explains the most likely rejection of 90h: the УНП names another device. */
  private async unpHint(unp: string): Promise<string | undefined> {
    const prefix = unp.split('-')[0]?.toUpperCase()
    const serial = (await this.readDiagnostics().catch(() => null))?.serialNumber?.toUpperCase()
    if (!serial || !prefix || serial === prefix) return undefined
    logger.warn({ deviceId: this.deviceId, unpPrefix: prefix, serial }, 'Eltrade: УНП prefix does not match the device serial number')
    return `The УНП starts with ${prefix} but this device's serial number is ${serial} — set the device number in LGR to ${serial}`
  }

  private assertUnp(unp: string): void {
    if (!UNP_PATTERN.test(unp || '')) {
      throw new EltradeError(`Invalid УНП "${unp}" — expected XX123456-0001-0000001 (device serial, 4-character operator code, 7-digit number)`, 'input')
    }
  }

  // ── Fiscal receipt ──

  async openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void> {
    this.assertUnp(unpNumber)
    await this.ensureNoOpenReceipt()
    const hint = await this.unpHint(unpNumber)
    await this.request(ELTRADE_CMD.OPEN_FISCAL, `${this.operatorLabel(operatorName, operatorCode)},${unpNumber}`, {
      prints: true, timeoutMs: TIMEOUT_MS.print, hint,
    })
    this.receipt = { expected: 0, remaining: null, lastPaidCode: null }
    logger.info({ deviceId: this.deviceId, operatorCode, unpNumber }, 'Eltrade fiscal receipt opened')
  }

  async printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number, taxRate?: number): Promise<void> {
    if (!(quantity > 0)) throw new EltradeError(`Invalid quantity ${quantity} for "${name}"`, 'input', ELTRADE_CMD.SALE)
    if (!(price >= 0)) throw new EltradeError(`Invalid price ${price} for "${name}"`, 'input', ELTRADE_CMD.SALE)
    if (discount !== undefined && (discount < -99 || discount > 99)) {
      throw new EltradeError(`Discount ${discount}% for "${name}" is outside the device range (-99..99%)`, 'input', ELTRADE_CMD.SALE)
    }
    const group = await this.resolveTaxGroup(vatGroup, taxRate)
    const [line1, line2] = splitItemText(name)
    let data = line1 + (line2 ? `\n${line2}` : '') + `\t${group}${price.toFixed(2)}`
    if (quantity !== 1) data += `*${formatQuantity(quantity)}`
    // LGR's discount is "percent off"; the device's is a signed adjustment (negative = discount).
    if (discount) data += `,${(-discount).toFixed(2)}`
    await this.request(ELTRADE_CMD.SALE, data, { prints: true, timeoutMs: TIMEOUT_MS.print })

    const receipt = this.receipt ?? (this.receipt = { expected: 0, remaining: null, lastPaidCode: null })
    const amount = round2(Number(price.toFixed(2)) * quantity)
    receipt.expected = round2(receipt.expected + amount - (discount ? round2((amount * discount) / 100) : 0))
  }

  async printSubtotal(): Promise<{ subtotal: number }> {
    const { data } = await this.request(ELTRADE_CMD.SUBTOTAL, '00', { timeoutMs: TIMEOUT_MS.print })
    return { subtotal: parseDeviceAmount(data.split(',')[0]) ?? 0 }
  }

  /**
   * The receipt total as the device computed it. Its number format is not pinned down by the
   * protocol, so the reading is accepted in whichever scale agrees with the lines we sent.
   */
  private async readAmountDue(expected: number): Promise<number> {
    try {
      const { data } = await this.request(ELTRADE_CMD.SUBTOTAL, '00', { check: false, timeoutMs: TIMEOUT_MS.print })
      const value = parseDeviceAmount(data.split(',')[0])
      if (value !== null) {
        const tolerance = Math.max(0.05, expected * 0.01)
        for (const candidate of [value, value * 100, value / 100]) {
          if (Math.abs(candidate - expected) <= tolerance) return round2(candidate)
        }
        logger.warn({ deviceId: this.deviceId, subtotal: data, expected }, 'Eltrade: device subtotal disagrees with the registered lines — using the registered total')
      }
    } catch (e: any) {
      logger.warn({ deviceId: this.deviceId, error: e.message }, 'Eltrade: subtotal unreadable — using the registered total')
    }
    return round2(expected)
  }

  async printPayment(type: FiscalPaymentType, amount: number): Promise<void> {
    const receipt = this.receipt ?? (this.receipt = { expected: 0, remaining: null, lastPaidCode: null })
    if (receipt.lastPaidCode === 'R') {
      // The device already reports the receipt as paid — e.g. its total came out a cent below
      // LGR's and the first tender covered it. Another 35h would just print more change.
      logger.info({ deviceId: this.deviceId, type, amount }, 'Eltrade: receipt already paid — payment skipped')
      return
    }
    const mode = PAYMENT_MODE[type] ?? 'P'
    if (receipt.remaining === null) receipt.remaining = await this.readAmountDue(receipt.expected)

    let tender = round2(Math.abs(amount))
    // Only cash can be over-tendered (the device prints change); never over-charge a card
    // because LGR's total and the device's differ by a rounding cent.
    if (mode !== 'P') tender = Math.min(tender, receipt.remaining)
    if (tender <= 0) {
      logger.info({ deviceId: this.deviceId, type }, 'Eltrade: nothing left to pay — payment skipped')
      return
    }
    const { data } = await this.request(ELTRADE_CMD.TOTAL, `\t${mode}${tender.toFixed(2)}`, { prints: true, timeoutMs: TIMEOUT_MS.print })
    this.applyPaidCode(receipt, data, tender)
  }

  private applyPaidCode(receipt: ReceiptState, answer: string, tender: number): void {
    const code = answer.trim().charAt(0).toUpperCase()
    receipt.lastPaidCode = code
    const before = receipt.remaining ?? receipt.expected
    switch (code) {
      case 'R': // paid in full (change, if any, is printed)
        receipt.remaining = 0
        return
      case 'D': { // part-paid; the device returns what is still due
        const due = parseDeviceAmount(answer.trim().slice(1))
        receipt.remaining = due !== null && due > 0 && due <= before ? round2(due) : round2(Math.max(0, before - tender))
        return
      }
      case 'F':
        throw new EltradeError('Eltrade refused the payment (error)', 'rejected', ELTRADE_CMD.TOTAL)
      case 'E':
        throw new EltradeError('Eltrade refused the payment: the receipt subtotal is negative', 'rejected', ELTRADE_CMD.TOTAL)
      case 'I':
        throw new EltradeError('Eltrade refused the payment: a VAT group total is negative', 'rejected', ELTRADE_CMD.TOTAL)
      default:
        receipt.remaining = round2(Math.max(0, before - tender))
    }
  }

  async closeFiscalReceipt(): Promise<FiscalReceiptResult> {
    const receipt = this.receipt
    if (receipt?.lastPaidCode === 'D') {
      // LGR's total and the device's can differ by a rounding cent. The device will not close
      // an underpaid receipt, so let it settle its own remainder (Tab alone = rest in cash).
      logger.warn({ deviceId: this.deviceId, remaining: receipt.remaining }, 'Eltrade: receipt short by rounding after the last payment — settling the remainder in cash')
      const { data } = await this.request(ELTRADE_CMD.TOTAL, '\t', { prints: true, timeoutMs: TIMEOUT_MS.print })
      this.applyPaidCode(receipt, data, receipt.remaining ?? 0)
    }
    await this.request(ELTRADE_CMD.CLOSE_FISCAL, '', { prints: true, timeoutMs: TIMEOUT_MS.print })
    this.receipt = null
    const fiscalReceiptNumber = (await this.readLastDocumentNumber().catch(() => undefined)) ?? 'unknown'
    logger.info({ deviceId: this.deviceId, fiscalReceiptNumber }, 'Eltrade fiscal receipt closed')
    return { fiscalReceiptNumber, dateTime: new Date() }
  }

  async printStornoReceipt(
    operatorCode: string,
    operatorName: string,
    unpNumber: string,
    originalReceiptNumber: string,
    originalDate: Date,
    originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup; taxRate?: number }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult> {
    // A reversal carries the ORIGINAL sale's УНП — it is an operation on that sale.
    const unp = originalUNP || unpNumber
    this.assertUnp(unp)
    const receiptNumber = String(originalReceiptNumber || '').trim()
    if (!/^\d+$/.test(receiptNumber)) {
      throw new EltradeError(`Storno needs the original fiscal receipt number, got "${originalReceiptNumber}"`, 'input', ELTRADE_CMD.OPEN_FISCAL)
    }
    await this.ensureNoOpenReceipt()
    const diag = await this.readDiagnostics()
    if (!diag.fiscalMemoryNumber) {
      throw new EltradeError('Storno needs the fiscal memory number, which the device did not report', 'protocol', ELTRADE_CMD.DIAGNOSTIC_INFO)
    }
    const header = [
      this.operatorLabel(operatorName, operatorCode),
      unp,
      'S',
      diag.fiscalMemoryNumber,
      STORNO_REASON[reason] ?? 'R',
      receiptNumber,
      formatDeviceIsoDateTime(originalDate, this.timeZone),
    ].join(',')
    await this.request(ELTRADE_CMD.OPEN_FISCAL, header, { prints: true, timeoutMs: TIMEOUT_MS.print, hint: await this.unpHint(unp) })
    this.receipt = { expected: 0, remaining: null, lastPaidCode: null }

    try {
      // Quantities and amounts on a reversal are POSITIVE; the receipt type carries the sign.
      for (const line of lines) {
        await this.printSaleLine(line.name, Math.abs(line.quantity), Math.abs(line.price), line.vatGroup, undefined, line.taxRate)
      }
      await this.printPayment(payment.type, Math.abs(payment.amount))
      const result = await this.closeFiscalReceipt()
      logger.info({ deviceId: this.deviceId, stornoReceiptNumber: result.fiscalReceiptNumber, originalReceiptNumber, reason }, 'Eltrade storno receipt printed')
      return result
    } catch (e) {
      await this.cancelFiscalReceipt().catch(() => undefined)
      throw e
    }
  }

  // ── Non-fiscal (service) receipt ──

  async openNonFiscalReceipt(_operatorCode: string): Promise<void> {
    await this.ensureNoOpenReceipt()
    const { data } = await this.request(ELTRADE_CMD.OPEN_NON_FISCAL, '', { prints: true, timeoutMs: TIMEOUT_MS.print })
    // Answer: Allreceipt,ErrCode — codes per the protocol, 26h.
    const errCode = data.split(',')[1]?.trim()
    const errors: Record<string, string> = {
      '1': 'the fiscal memory is not formatted',
      '2': 'a fiscal receipt is open',
      '3': 'a non-fiscal receipt is already open',
    }
    if (errCode && errors[errCode]) {
      throw new EltradeError(`Eltrade rejected ${cmdLabel(ELTRADE_CMD.OPEN_NON_FISCAL)}: ${errors[errCode]}`, 'rejected', ELTRADE_CMD.OPEN_NON_FISCAL)
    }
  }

  async printNonFiscalText(text: string): Promise<void> {
    // The device frames each line with '#' and cuts it after 46 characters.
    await this.request(ELTRADE_CMD.PRINT_NON_FISCAL_TEXT, sanitizeDeviceText(text).slice(0, FREE_TEXT_MAX), {
      prints: true, timeoutMs: TIMEOUT_MS.print,
    })
  }

  async closeNonFiscalReceipt(): Promise<void> {
    await this.request(ELTRADE_CMD.CLOSE_NON_FISCAL, '', { prints: true, timeoutMs: TIMEOUT_MS.print })
  }

  // ── Reports ──

  private async dailyReport(option: '0' | '2'): Promise<ZReportResult> {
    await this.ensureNoOpenReceipt()
    const { data } = await this.request(ELTRADE_CMD.DAILY_REPORT, option, { prints: true, timeoutMs: TIMEOUT_MS.report })
    // Answer: Closure,FM_Total,TotA..TotH
    const fields = data.split(',')
    const closure = fields[0]?.trim() ?? ''
    return {
      reportNumber: /^\d+$/.test(closure) ? closure : 'unknown',
      dateTime: new Date(),
      totalSales: parseDeviceAmount(fields[1]) ?? 0,
      totalReturns: 0,
      receiptCount: 0,
    }
  }

  async printDailyZReport(): Promise<ZReportResult> {
    const result = await this.dailyReport('0')
    logger.info({ deviceId: this.deviceId, reportNumber: result.reportNumber }, 'Eltrade Z-report printed')
    return result
  }

  async printDailyXReport(): Promise<ZReportResult> {
    return this.dailyReport('2')
  }

  async printFiscalMemoryReportByDate(startDate: Date, endDate: Date, detailed = false): Promise<void> {
    const cmd = detailed ? ELTRADE_CMD.DETAILED_FM_REPORT_BY_DATE : ELTRADE_CMD.SHORT_FM_REPORT_BY_DATE
    // Both dates are always sent: with only one the device prints a monthly/annual report.
    await this.request(cmd, `${formatDeviceDate(startDate, this.timeZone)},${formatDeviceDate(endDate, this.timeZone)}`, {
      prints: true, timeoutMs: TIMEOUT_MS.report,
    })
  }

  async printFiscalMemoryReportByNumber(startNumber: number, endNumber: number, detailed = false): Promise<void> {
    const cmd = detailed ? ELTRADE_CMD.DETAILED_FM_REPORT_BY_NUMBER : ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER
    const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(4, '0')
    await this.request(cmd, `${pad(startNumber)},${pad(endNumber)}`, { prints: true, timeoutMs: TIMEOUT_MS.report })
  }

  // ── Clock ──

  async readDateTime(): Promise<Date> {
    const { data } = await this.request(ELTRADE_CMD.GET_DATE_TIME, '', { check: false })
    const parsed = parseDeviceDateTime(data, this.timeZone)
    if (!parsed) {
      throw new EltradeError(`Eltrade ${cmdLabel(ELTRADE_CMD.GET_DATE_TIME)}: unexpected answer "${data}"`, 'protocol', ELTRADE_CMD.GET_DATE_TIME)
    }
    return parsed
  }

  async syncDateTime(dateTime: Date): Promise<void> {
    const current = await this.readDateTime().catch(() => null)
    if (current) {
      const drift = dateTime.getTime() - current.getTime()
      if (Math.abs(drift) < CLOCK_TOLERANCE_MS) return
      if (drift < -MAX_CLOCK_ROLLBACK_MS) {
        throw new EltradeError(
          `Refusing to move the Eltrade clock back by ${Math.round(-drift / 60_000)} min (device ${formatDeviceDateTime(current, this.timeZone)}, requested ${formatDeviceDateTime(dateTime, this.timeZone)}). Check the server time; a device clock that is ahead must be corrected by service.`,
          'input',
          ELTRADE_CMD.SET_DATE_TIME,
        )
      }
    }
    const value = formatDeviceDateTime(dateTime, this.timeZone)
    await this.request(ELTRADE_CMD.SET_DATE_TIME, value)
    logger.info({ deviceId: this.deviceId, dateTime: value }, 'Eltrade clock synchronized')
  }

  // ── Operators ──

  async programOperator(operatorNumber: number, password: string, name: string): Promise<void> {
    if (!Number.isInteger(operatorNumber) || operatorNumber < 1 || operatorNumber > 16) {
      throw new EltradeError('Eltrade operators are numbered 1–16', 'input', ELTRADE_CMD.SET_OPERATOR)
    }
    // The password authenticates the change; three wrong ones lock the device until it is
    // power-cycled — so nothing malformed is ever sent.
    if (!/^\d{4,8}$/.test(password)) {
      throw new EltradeError('Eltrade operator passwords are 4–8 digits', 'input', ELTRADE_CMD.SET_OPERATOR)
    }
    const clean = sanitizeDeviceText(name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, OPERATOR_NAME_MAX)
    await this.request(ELTRADE_CMD.SET_OPERATOR, `${operatorNumber},${password},${clean}`)
  }
}
