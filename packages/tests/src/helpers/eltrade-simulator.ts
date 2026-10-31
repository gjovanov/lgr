/**
 * An Eltrade fiscal device on the other end of the wire, for driver and POS tests.
 *
 * Built from "ELTRADE Комуникационен протокол" v1.1.1 (re-checked against v1.1.7), not from the
 * driver: it validates every frame (LEN, BCC), keeps the receipt state machine, raises the
 * documented status bits, answers NAK to a bad frame and — the rule a retransmit depends on —
 * REPLAYS its last answer, without executing anything, when it sees the same SEQ twice in a row.
 *
 * Where the protocol leaves a behaviour open the simulator takes the STRICT reading, so the
 * driver is tested against the least forgiving device: a УНП whose prefix is not this
 * device's serial is a syntax error, a non-cash tender above what is due is refused, a report
 * (X, Z, fiscal memory) is refused while a receipt is open, its period must be one the protocol
 * spells, and an operator's password must match the one it was first programmed with (three
 * wrong ones block the device until `powerCycle()`).
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
  /** Free text printed inside the receipt (36h), in order. */
  texts: string[]
  payments: SimPayment[]
  total: number
  paid: number
  number?: string
  voided?: boolean
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const GROUPS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З']

/** Commands that print: refused with "no paper" when the roll is out. */
const PRINTING = [0x26, 0x27, 0x2A, 0x31, 0x35, 0x36, 0x38, 0x45, 0x49, 0x4F, 0x5E, 0x5F, 0x90]

/**
 * The data each fiscal-memory report takes (v1.1.7). By number: `Start,End`, 4 digits each — 49h
 * may also take nothing (the whole life of the device) and the '#' (SHA-1) / '*' (skip zero
 * groups) prefixes. By date: `DDMMYY,DDMMYY`, or a month `MMYY` or a year `YY` alone; 5Eh takes the
 * same prefixes.
 */
const FM_REPORT_DATA: Record<number, RegExp> = {
  0x49: /^(?:#?\*?(\d{4}),(\d{4}))?$/,
  0x5F: /^(\d{4}),(\d{4})$/,
  0x4F: /^(?:(\d{6}),(\d{6})|(\d{4})|(\d{2}))$/,
  0x5E: /^#?\*?(?:(\d{6}),(\d{6})|(\d{4})|(\d{2}))$/,
}

/** A real DDMMYY day, as a sortable YYMMDD; null for 310226 and the like. */
function fmDay(ddmmyy: string): string | null {
  const [dd, mm, yy] = [ddmmyy.slice(0, 2), ddmmyy.slice(2, 4), ddmmyy.slice(4, 6)].map(Number)
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd))
  return d.getUTCDate() === dd && d.getUTCMonth() === mm - 1 ? ddmmyy.slice(4, 6) + ddmmyy.slice(2, 4) + ddmmyy.slice(0, 2) : null
}

/** Strict: the shape the protocol spells, real dates and months, and a period that does not run backwards. */
export function validFmReportData(cmd: number, text: string): boolean {
  const m = FM_REPORT_DATA[cmd]?.exec(text)
  if (!m) return false
  const [, a, b, month] = m
  if (month !== undefined) return Number(month.slice(0, 2)) >= 1 && Number(month.slice(0, 2)) <= 12
  if (a === undefined || b === undefined) return true // a year, or 49h's whole period
  if (a.length === 4) return Number(a) <= Number(b)
  const [from, to] = [fmDay(a), fmDay(b)]
  return !!from && !!to && from <= to
}

/** Placeholder names for the 11 payment slots (55h) — not any device's factory names. */
const DEFAULT_PAYMENT_NAMES: Record<string, string> = {
  P: 'В БРОЙ', N: 'ЧЕК', C: 'ТАЛОН', D: 'В.ТАЛОН', I: 'АМБАЛАЖ', J: 'ВЪТР.ОБСЛУЖВАНЕ',
  K: 'ПОВРЕДИ', L: 'КАРТА', M: 'БАНКА', Q: 'НЗОК', R: 'РЕЗЕРВ',
}

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
  /**
   * How 55h answers a read: the bare name, or `P\<name>` — the protocol's `Result\Name` leaves both
   * readings open, and the driver must take either.
   */
  paymentNameAnswer: 'bare' | 'prefixed' = 'bare'
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
  /** 66h: operator 1–16 → its name and the password that authenticates the next change. */
  operators: Record<number, { name: string; password: string }> = {}
  /** 55h: the name the device prints for each payment slot. */
  paymentNames: Record<string, string> = { ...DEFAULT_PAYMENT_NAMES }
  /** Wrong operator passwords in a row; the third blocks the device (66h). */
  wrongPasswords = 0
  locked = false

  /** Switch the device off and on: what a block after three wrong passwords needs. */
  powerCycle(): void {
    this.locked = false
    this.wrongPasswords = 0
  }

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
    const prints = PRINTING.includes(cmd)
    if (this.locked && cmd !== 0x4A) {
      flags.notAllowed = true // blocked after three wrong passwords; only the status still answers
    } else if (prints && !this.paper) {
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
        this.receipt = { kind: storno ? 'storno' : 'fiscal', header, sales: [], texts: [], payments: [], total: 0, paid: 0 }
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
      case 0x36:
        // "A fiscal receipt must be opened because in the opposite case the text will not be
        // printed and the S1.1 flag is raised"; past 46 symbols it is cut off (v1.1.1).
        if (!this.receipt) { flags.notAllowed = true; return '' }
        this.receipt.texts.push(text.slice(0, 46))
        return ''
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
        // [<Option>[N]: '0' Z, '2' X, then 'N' or 'a' (keep the operators' / items' data).
        if (!/^(?:[02][Na]?)?$/.test(text)) { flags.syntax = true; return '' }
        const zeroing = text === '' || text.startsWith('0')
        const answer = `${String(this.closure + (zeroing ? 1 : 0)).padStart(4, '0')},${this.money(this.dayTotal)},0,0,0,0,0,0,0,0`
        if (zeroing) { this.closure++; this.dayTotal = 0 }
        this.reports.push({ cmd, data: text })
        return answer
      }
      case 0x49: case 0x4F: case 0x5E: case 0x5F:
        if (this.receipt || this.nonFiscalOpen) { flags.notAllowed = true; return '' }
        if (!validFmReportData(cmd, text)) { flags.syntax = true; return '' }
        this.reports.push({ cmd, data: text })
        return ''
      case 0x55: {
        // Option[,Name]: the slot alone reads its name; with a name (≤ 20) sets it — 'F' if longer.
        const m = /^([PNCDIJKLMQR])(?:,(.*))?$/s.exec(text)
        if (!m) { flags.syntax = true; return '' }
        const [, code, name] = m
        if (name === undefined) return this.paymentNameAnswer === 'prefixed' ? `P\\${this.paymentNames[code]}` : this.paymentNames[code]
        if (name.length > 20) return 'F'
        this.paymentNames[code] = name
        return 'P'
      }
      case 0x66: {
        // <OpCode>,<Pwd>,<OpName>: operator 1–16, password 4–8 digits, name up to 24.
        const m = /^(\d{1,2}),(\d{4,8}),(.*)$/s.exec(text)
        if (!m || Number(m[1]) < 1 || Number(m[1]) > 16 || m[3].length > 24) { flags.syntax = true; return '' }
        const n = Number(m[1])
        // An empty location takes the password it is first given; after that it must match.
        const known = this.operators[n]?.password
        if (known && known !== m[2]) {
          flags.notAllowed = true
          if (++this.wrongPasswords >= 3) this.locked = true
          return ''
        }
        this.wrongPasswords = 0
        this.operators[n] = { name: m[3], password: m[2] }
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
