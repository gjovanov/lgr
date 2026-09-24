/**
 * An Eltrade fiscal device on the other end of the wire, for driver and POS tests.
 *
 * Built from "ELTRADE Комуникационен протокол" v1.1.1, not from the driver: it validates
 * every frame (LEN, BCC), keeps the receipt state machine, raises the documented status
 * bits, answers NAK to a bad frame and — the rule a retransmit depends on — REPLAYS its last
 * answer, without executing anything, when it sees the same SEQ twice in a row.
 *
 * Where the protocol leaves a behaviour open the simulator takes the STRICT reading, so the
 * driver is tested against the least forgiving device: a УНП whose prefix is not this
 * device's serial is a syntax error, and a non-cash tender above what is due is refused.
 *
 * Fault injection (each counter is consumed per frame): `nakNext` answers NAK before looking
 * at the frame; `loseNextAnswers` executes the command but "loses" the answer on the line,
 * which reaches the driver as the relay's read timeout; `silent` never answers at all.
 */

import { ISL, buildIslResponseFrame, islBcc } from 'fiscal/isl-frame'
import { encodeCp1251, decodeCp1251 } from 'fiscal/cp1251'
import { formatDeviceDateTime, parseDeviceDateTime } from 'fiscal/zoned-time'

export interface SimSale { text: string; group: string; price: number; quantity: number; percent: number; amount: number }
export interface SimPayment { mode: string; amount: number }
export interface SimReceipt {
  kind: 'fiscal' | 'storno'
  header: string[]
  sales: SimSale[]
  payments: SimPayment[]
  total: number
  paid: number
  number?: string
  voided?: boolean
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const GROUPS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З']

export class EltradeSimulator {
  // ── identity & configuration ──
  serial = 'ED123456'
  fiscalMemory = '44123456'
  rates: number[] = [0, 20, 20, 9, 0, 0, 0, 0]
  fiscalized = true
  paper = true
  clockNotSet = false
  /** Mimic the ErpNet.FP #166 A1: "general error" + NRA-link bits raised on a healthy device. */
  terminalDown = false
  /** How amounts come back: "12.50" or an integer count of cents ("1250"). */
  amountFormat: 'decimal' | 'cents' = 'decimal'
  clock = new Date('2026-07-15T09:00:00Z')

  // ── fault injection ──
  nakNext = 0
  loseNextAnswers = 0
  silent = false
  /** Bytes prepended to the next answer once (e.g. a stale frame from an earlier command). */
  prependOnce: Uint8Array | null = null
  synPrefix = 0

  // ── state ──
  lastSeq: number | null = null
  lastAnswer: Uint8Array | null = null
  lastDocNumber = 100
  closure = 12
  dayTotal = 0
  receipt: SimReceipt | null = null
  nonFiscalOpen = false
  nonFiscalLines: string[] = []
  receipts: SimReceipt[] = []
  reports: { cmd: number; data: string }[] = []
  /** Every command EXECUTED (replays are not). */
  executed: { cmd: number; data: string }[] = []
  /** Every frame received, replays and rejected ones included. */
  frames = 0
  operators: Record<number, string> = {}

  exchange = async (frame: Buffer | Uint8Array): Promise<Buffer> => {
    this.frames++
    const f = new Uint8Array(frame)
    if (this.silent) throw new Error('Serial read timeout — no answer from the device')
    if (this.nakNext > 0) {
      this.nakNext--
      return Buffer.from([ISL.NAK])
    }
    if (!this.validFrame(f)) return Buffer.from([ISL.NAK])

    const seq = f[2]
    let answer: Uint8Array
    if (seq === this.lastSeq && this.lastAnswer) {
      answer = this.lastAnswer // same SEQ: replay, do not execute
    } else {
      const cmd = f[3]
      const data = f.subarray(4, f.length - 6)
      answer = this.execute(seq, cmd, data)
      this.lastSeq = seq
      this.lastAnswer = answer
    }

    if (this.loseNextAnswers > 0) {
      this.loseNextAnswers--
      throw new Error('Serial read timeout — the device stopped answering mid-response')
    }
    const parts: number[] = []
    for (let i = 0; i < this.synPrefix; i++) parts.push(ISL.SYN)
    if (this.prependOnce) {
      parts.push(...this.prependOnce)
      this.prependOnce = null
    }
    parts.push(...answer)
    return Buffer.from(parts)
  }

  private validFrame(f: Uint8Array): boolean {
    if (f.length < 10 || f[0] !== ISL.PREAMBLE || f[f.length - 1] !== ISL.TERMINATOR) return false
    const post = f.length - 6
    if (f[post] !== ISL.POSTAMBLE) return false
    if (f[1] !== ISL.OFFSET + post) return false // LEN counts LEN..05
    const bcc = islBcc(f, 1, post)
    return bcc.every((b, i) => f[post + 1 + i] === b)
  }

  private money(n: number): string {
    return this.amountFormat === 'decimal' ? round2(n).toFixed(2) : String(Math.round(n * 100))
  }

  private execute(seq: number, cmd: number, raw: Uint8Array): Uint8Array {
    const text = decodeCp1251(raw)
    const flags = { syntax: false, invalid: false, notAllowed: false, noPaper: false }
    let out = ''
    const prints = [0x26, 0x27, 0x2A, 0x31, 0x35, 0x38, 0x45, 0x90].includes(cmd)
    if (prints && !this.paper) {
      flags.noPaper = true
    } else {
      out = this.run(cmd, text, flags)
      if (!flags.syntax && !flags.invalid && !flags.notAllowed) this.executed.push({ cmd, data: text })
    }
    return buildIslResponseFrame(seq, cmd, encodeCp1251(out), this.status(flags))
  }

  private run(cmd: number, text: string, flags: { syntax: boolean; invalid: boolean; notAllowed: boolean }): string {
    const receiptOpen = !!this.receipt
    switch (cmd) {
      case 0x4A: return ''
      case 0x5A: return `ELTRADE A3 KL,BG,1.02 13Nov19 1015,21A4,00001000,${this.serial},${this.fiscalMemory}`
      case 0x3E: return formatDeviceDateTime(this.clock)
      case 0x3D: {
        const d = parseDeviceDateTime(text)
        if (!d) { flags.syntax = true; return '' }
        this.clock = d
        return ''
      }
      case 0x61: return this.rates.map(r => r.toFixed(2)).join(',')
      case 0x71: return String(this.lastDocNumber).padStart(7, '0')

      case 0x26:
        if (receiptOpen || this.nonFiscalOpen) { flags.notAllowed = true; return `0000,${receiptOpen ? 2 : 3}` }
        this.nonFiscalOpen = true
        this.nonFiscalLines = []
        return '0001'
      case 0x2A:
        if (!this.nonFiscalOpen) { flags.notAllowed = true; return '' }
        this.nonFiscalLines.push(text.slice(0, 46))
        return ''
      case 0x27:
        if (!this.nonFiscalOpen) { flags.notAllowed = true; return '' }
        this.nonFiscalOpen = false
        this.lastDocNumber++
        return '0002'

      case 0x90: {
        if (receiptOpen || this.nonFiscalOpen) { flags.notAllowed = true; return '' }
        const header = text.split(',')
        const unp = header[1] || ''
        if (!/^[A-Z]{2}\d{6}-[0-9A-Za-z]{4}-\d{7}$/.test(unp) || unp.slice(0, 8) !== this.serial) {
          flags.syntax = true
          return ''
        }
        const storno = header[2] === 'S'
        if (storno && (header[3] !== this.fiscalMemory || !['O', 'R', 'T'].includes(header[4] || '') || !/^\d+$/.test(header[5] || ''))) {
          flags.syntax = true
          return ''
        }
        this.receipt = { kind: storno ? 'storno' : 'fiscal', header, sales: [], payments: [], total: 0, paid: 0 }
        return '0003,0001'
      }
      case 0x31: {
        if (!this.receipt || this.receipt.payments.length) { flags.notAllowed = true; return '' }
        const m = /^([^\t]*)\t(.)(\d+(?:\.\d+)?)(?:\*(\d+(?:\.\d+)?))?(?:,(-?\d+(?:\.\d+)?))?$/s.exec(text)
        if (!m) { flags.syntax = true; return '' }
        const group = m[2]
        const gi = GROUPS.indexOf(group)
        if (gi < 0) { flags.syntax = true; return '' }
        const price = Number(m[3])
        const quantity = m[4] ? Number(m[4]) : 1
        const percent = m[5] ? Number(m[5]) : 0
        const gross = round2(price * quantity)
        const amount = round2(gross + (percent ? round2((gross * percent) / 100) : 0))
        this.receipt.sales.push({ text: m[1], group, price, quantity, percent, amount })
        this.receipt.total = round2(this.receipt.total + amount)
        return ''
      }
      case 0x33:
        if (!this.receipt) { flags.notAllowed = true; return '' }
        return [this.money(this.receipt.total), ...GROUPS.map(g => this.money(
          this.receipt!.sales.filter(s => s.group === g).reduce((a, s) => a + s.amount, 0),
        ))].join(',')
      case 0x35: {
        if (!this.receipt) { flags.notAllowed = true; return 'F' }
        const tab = text.indexOf('\t')
        if (tab < 0) { flags.syntax = true; return 'F' }
        const rest = text.slice(tab + 1)
        const due = round2(this.receipt.total - this.receipt.paid)
        let mode = 'P'
        let amount = due
        if (rest.length) {
          const m = /^([PNCDIJKLMQR]?)\+?(\d+(?:\.\d+)?)$/.exec(rest)
          if (!m) { flags.syntax = true; return 'F' }
          mode = m[1] || 'P'
          amount = Number(m[2])
        }
        // Strict: only cash may be tendered above what is due.
        if (mode !== 'P' && amount > due + 0.001) { flags.notAllowed = true; return 'F' }
        this.receipt.payments.push({ mode, amount })
        this.receipt.paid = round2(this.receipt.paid + amount)
        const left = round2(this.receipt.total - this.receipt.paid)
        return left > 0 ? `D${this.money(left)}` : `R${this.money(-left)}`
      }
      case 0x38: {
        if (!this.receipt || !this.receipt.payments.length || this.receipt.paid + 0.001 < this.receipt.total) {
          flags.notAllowed = true
          return ''
        }
        this.lastDocNumber++
        this.receipt.number = String(this.lastDocNumber).padStart(7, '0')
        if (this.receipt.kind === 'fiscal') this.dayTotal = round2(this.dayTotal + this.receipt.total)
        this.receipts.push(this.receipt)
        this.receipt = null
        return '0004,0002'
      }
      case 0x3C:
        if (!this.receipt || this.receipt.payments.length) { flags.notAllowed = true; return '' }
        this.receipts.push({ ...this.receipt, voided: true })
        this.receipt = null
        return ''
      case 0x45: {
        if (this.receipt || this.nonFiscalOpen) { flags.notAllowed = true; return '' }
        const zeroing = text === '' || text.startsWith('0')
        const answer = `${String(this.closure + (zeroing ? 1 : 0)).padStart(4, '0')},${this.money(this.dayTotal)},0,0,0,0,0,0,0,0`
        if (zeroing) { this.closure++; this.dayTotal = 0 }
        this.reports.push({ cmd, data: text })
        return answer
      }
      case 0x49: case 0x4F: case 0x5E: case 0x5F:
        this.reports.push({ cmd, data: text })
        return ''
      case 0x66: {
        const [n, pwd, ...name] = text.split(',')
        if (!/^\d{1,2}$/.test(n) || !/^\d{4,8}$/.test(pwd)) { flags.syntax = true; return '' }
        this.operators[Number(n)] = name.join(',')
        return ''
      }
      default:
        flags.invalid = true
        return ''
    }
  }

  /** The 6 status bytes, bit 7 always set (protocol "СТАТУС БИТОВЕ"). */
  private status(flags: { syntax: boolean; invalid: boolean; notAllowed: boolean; noPaper: boolean }): Uint8Array {
    const s = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80]
    if (flags.syntax) s[0] |= 0x01
    if (flags.invalid) s[0] |= 0x02
    if (this.clockNotSet) s[0] |= 0x04
    if (this.terminalDown) { s[0] |= 0x20; s[1] |= 0x40 }
    if (flags.syntax || flags.invalid || flags.notAllowed || flags.noPaper) s[0] |= 0x20
    if (flags.notAllowed) s[1] |= 0x02
    if (!this.paper) s[2] |= 0x01
    if (this.receipt) s[2] |= 0x08
    if (this.nonFiscalOpen) s[2] |= 0x20
    s[4] |= 0x06 // serial + FM number set, EIK set
    s[5] |= 0x12 // FM formatted, tax rates set
    if (this.fiscalized) s[5] |= 0x08
    return Uint8Array.from(s)
  }
}
