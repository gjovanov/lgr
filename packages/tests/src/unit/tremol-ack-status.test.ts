import { describe, it, expect } from 'bun:test'
import { TREMOL_CMD, TremolRefusedError, parseTremolResponse, tremolAckStatus } from 'fiscal/tremol'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { fiscalFailure } from 'fiscal/errors'

/**
 * #491: a Tremol answers a command that returns no data with an ACK frame whose two status bytes are the
 * command's own result: `<ACK><NBL><STE1><STE2><CS><CS><ETX>`, read as ErpNet.FP reads it. They were never
 * read, so a refused command (a close, a Z) read as done.
 */

/** An ACK frame, its checksum as the protocol computes it: XOR from NBL to STE2, two nibbles + 30h. */
function ack(ste1: number, ste2: number, opts: { nbl?: number; badChecksum?: boolean } = {}): Buffer {
  const nbl = opts.nbl ?? 0x21
  const xor = nbl ^ ste1 ^ ste2
  return Buffer.from([0x06, nbl, ste1, ste2, ((xor >> 4) & 0x0F) + 0x30, (xor & 0x0F) + 0x30 + (opts.badChecksum ? 1 : 0), 0x0A])
}

/** What `parseTremolResponse` threw, or null. No `.rejects`/`.toThrow` matchers in this suite (Known Issues). */
function thrown(fn: () => unknown): any {
  try { fn(); return null } catch (e) { return e }
}

describe('a Tremol ACK frame\'s status bytes (#491)', () => {
  it('30h 30h is accepted', () => {
    expect(tremolAckStatus(ack(0x30, 0x30))).toEqual([0x30, 0x30])
    expect(parseTremolResponse(ack(0x30, 0x30))).toEqual({ data: '', isAck: true })
  })

  it('a device error is refused, with its words', () => {
    const e = thrown(() => parseTremolResponse(ack(0x31, 0x30)))
    expect(e).toBeInstanceOf(TremolRefusedError)
    expect(e.message).toBe('Tremol refused the command: Out of paper, printer failure')
    expect(e.kind).toBe('rejected')
    expect(fiscalFailure(e)).toMatchObject({ status: 409, code: 'device_refused' })
  })

  it('a command error is refused, and both are named when both are set', () => {
    expect(thrown(() => parseTremolResponse(ack(0x30, 0x34))).message).toBe('Tremol refused the command: Syntax error')
    expect(thrown(() => parseTremolResponse(ack(0x3B, 0x32))).message).toBe('Tremol refused the command: 24 hours block: missing Z report; Illegal command')
  })

  it('a receipt left open on the device is `receipt_open`, as an Eltrade\'s', () => {
    for (const ste1 of [0x34, 0x36, 0x37]) {
      const e = thrown(() => parseTremolResponse(ack(ste1, 0x30)))
      expect(fiscalFailure(e)).toMatchObject({ status: 409, code: 'receipt_open' })
    }
  })

  it('what cannot be read is read as before, accepted: a lone ACK, a short frame, a bad checksum, bytes off the tables', () => {
    for (const answer of [
      Buffer.from([0x06]),
      Buffer.from([0x06, 0x21, 0x31, 0x0A]),
      ack(0x31, 0x30, { badChecksum: true }),
      ack(0x31, 0x39),
      ack(0x2F, 0x30),
    ]) {
      expect(tremolAckStatus(answer)).toBeNull()
      expect(parseTremolResponse(answer)).toEqual({ data: '', isAck: true })
    }
  })

  it('a data frame is untouched: its status is no ACK\'s', () => {
    const body = [0x24, 0x21, 0x60, 0x41]
    const xor = body.reduce((a, b) => a ^ b, 0)
    const frame = Buffer.from([0x02, ...body, ((xor >> 4) & 0x0F) + 0x30, (xor & 0x0F) + 0x30, 0x0A])
    expect(parseTremolResponse(frame).isAck).toBe(false)
  })
})

describe('the bridge driver (#491)', () => {
  it('a refused close is no closed receipt: it throws, and nothing reads as printed', async () => {
    const printer = new WsTremolFiscalPrinter(async (frame: Uint8Array) => (frame[3] === TREMOL_CMD.CLOSE_RECEIPT ? ack(0x31, 0x30) : ack(0x30, 0x30)), 'tremol-491')
    let caught: any = null
    try { await printer.closeFiscalReceipt() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(TremolRefusedError)
    expect(fiscalFailure(caught).code).toBe('device_refused')
  })

  it('an accepted close still closes', async () => {
    const printer = new WsTremolFiscalPrinter(async () => ack(0x30, 0x30), 'tremol-491-ok')
    expect((await printer.closeFiscalReceipt()).fiscalReceiptNumber).toBe('unknown')
  })
})
