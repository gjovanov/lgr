/**
 * ISL wire framing — the Datecs-style protocol family (Eltrade, Daisy, Datecs P/C, Incotex).
 *
 *   host → device   <01><LEN><SEQ><CMD><DATA><05><BCC×4><03>
 *   device → host   <01><LEN><SEQ><CMD><DATA><04><STATUS×6><05><BCC×4><03>
 *   single bytes    NAK 15h — the device found a bad frame: resend it with the SAME SEQ
 *                   SYN 16h — busy (printing); repeated every 60 ms until the answer is ready
 *
 * LEN  = 20h + number of bytes after <01> up to and including <05>  (4 + data length)
 * SEQ  = 20h–7Fh. The device echoes it, and when it receives the SAME SEQ twice in a row it
 *        does NOT execute the command again — it replays its last answer. That rule is what
 *        makes a retransmit after a lost answer safe, and it is also a trap: a fresh session
 *        whose first SEQ happens to equal the last one the device saw gets a stale replay.
 * CMD  = the command code as-is (no offset).
 * BCC  = 16-bit sum of the bytes after <01> up to and including <05>, sent as four nibbles,
 *        each + 30h (1AE3h → 31h 3Ah 3Eh 33h).
 *
 * Source: "ELTRADE Комуникационен протокол" v1.1.1 (06.02.2019), cross-checked against the
 * ErpNet.FP `BgIslFiscalPrinter` implementation, which has run against real Eltrade devices.
 *
 * Import-pure on purpose (no logger, no Node APIs): it is shared by the Eltrade driver, the
 * TCP transport and the tests, and it is the part worth pinning byte-for-byte.
 */

export const ISL = {
  PREAMBLE: 0x01,
  TERMINATOR: 0x03,
  SEPARATOR: 0x04,
  POSTAMBLE: 0x05,
  NAK: 0x15,
  SYN: 0x16,
  OFFSET: 0x20,
} as const

/** Host → device data limit (Eltrade protocol §Г). */
export const ISL_MAX_DATA = 213
export const ISL_STATUS_LENGTH = 6
/** SEQ values run 20h..7Fh — 96 of them. */
export const ISL_SEQ_SPAN = 0x60

export function islBcc(bytes: ArrayLike<number>, from: number, toInclusive: number): number[] {
  let sum = 0
  for (let i = from; i <= toInclusive; i++) sum = (sum + bytes[i]) & 0xFFFF
  return [
    ((sum >> 12) & 0x0F) + 0x30,
    ((sum >> 8) & 0x0F) + 0x30,
    ((sum >> 4) & 0x0F) + 0x30,
    (sum & 0x0F) + 0x30,
  ]
}

/**
 * Build a host → device frame. `seq` is the raw wire byte (20h–7Fh).
 */
export function buildIslFrame(seq: number, cmd: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (seq < 0x20 || seq > 0x7F) throw new RangeError(`ISL SEQ out of range: 0x${seq.toString(16)}`)
  if (cmd < 0x20 || cmd > 0xFF) throw new RangeError(`ISL command out of range: 0x${cmd.toString(16)}`)
  if (data.length > ISL_MAX_DATA) {
    throw new RangeError(`ISL data too long: ${data.length} bytes (max ${ISL_MAX_DATA})`)
  }
  const frame = new Uint8Array(data.length + 10)
  frame[0] = ISL.PREAMBLE
  frame[1] = ISL.OFFSET + 4 + data.length
  frame[2] = seq
  frame[3] = cmd
  frame.set(data, 4)
  const post = 4 + data.length
  frame[post] = ISL.POSTAMBLE
  frame.set(islBcc(frame, 1, post), post + 1)
  frame[post + 5] = ISL.TERMINATOR
  return frame
}

/**
 * Build a device → host frame. Only the device simulator in the tests produces these, but
 * keeping it next to the parser documents the answer layout in one place.
 */
export function buildIslResponseFrame(seq: number, cmd: number, data: Uint8Array, status: Uint8Array): Uint8Array {
  if (status.length !== ISL_STATUS_LENGTH) throw new RangeError('ISL status must be 6 bytes')
  const frame = new Uint8Array(data.length + 17)
  frame[0] = ISL.PREAMBLE
  // LEN is one byte; a long answer can overflow it, which is why the parser never trusts it.
  frame[1] = (ISL.OFFSET + 11 + data.length) & 0xFF
  frame[2] = seq
  frame[3] = cmd
  frame.set(data, 4)
  let i = 4 + data.length
  frame[i++] = ISL.SEPARATOR
  frame.set(status, i)
  i += ISL_STATUS_LENGTH
  frame[i] = ISL.POSTAMBLE
  frame.set(islBcc(frame, 1, i), i + 1)
  frame[i + 5] = ISL.TERMINATOR
  return frame
}

export interface IslResponse {
  /** Raw SEQ byte, as echoed by the device. */
  seq: number
  cmd: number
  data: Uint8Array
  status: Uint8Array
}

export interface IslStreamParse {
  /** Every checksum-valid answer frame, in arrival order. */
  frames: IslResponse[]
  /** A bare NAK arrived outside any frame. */
  nak: boolean
  /** How many SYN (busy) bytes arrived. */
  syn: number
  /** Frames that were delimited but failed structure or checksum. */
  invalid: number
}

/**
 * Split whatever the transport collected into frames and control bytes.
 *
 * Tolerant by design: SYN runs, a stale answer to an earlier command, line noise and a
 * truncated tail are all things a real serial line delivers. The CALLER decides which frame
 * answers its request (by SEQ) — this only guarantees each returned frame is intact.
 *
 * Frame boundaries are unambiguous because inside a valid answer every byte is ≥ 20h
 * (data, LEN, SEQ, CMD), ≥ 80h (status) or 30h–3Fh (BCC), apart from the documented TAB/LF
 * in data and the 04h/05h markers — so 01h, 03h, 15h and 16h only ever appear as delimiters.
 */
export function parseIslStream(bytes: Uint8Array): IslStreamParse {
  const out: IslStreamParse = { frames: [], nak: false, syn: 0, invalid: 0 }
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b === ISL.SYN) { out.syn++; i++; continue }
    if (b === ISL.NAK) { out.nak = true; i++; continue }
    if (b !== ISL.PREAMBLE) { i++; continue }

    const end = bytes.indexOf(ISL.TERMINATOR, i + 1)
    if (end === -1) break // incomplete tail — nothing more to read yet
    const frame = decodeResponseFrame(bytes.subarray(i, end + 1))
    if (frame) out.frames.push(frame)
    else out.invalid++
    i = end + 1
  }
  return out
}

function decodeResponseFrame(f: Uint8Array): IslResponse | null {
  // Smallest answer: 01 LEN SEQ CMD 04 S×6 05 BCC×4 03 = 17 bytes.
  if (f.length < 17) return null
  const post = f.length - 6
  const sep = post - 1 - ISL_STATUS_LENGTH
  if (f[post] !== ISL.POSTAMBLE || f[sep] !== ISL.SEPARATOR || sep < 4) return null
  const bcc = islBcc(f, 1, post)
  for (let k = 0; k < 4; k++) if (f[post + 1 + k] !== bcc[k]) return null
  return {
    seq: f[2],
    cmd: f[3],
    data: f.slice(4, sep),
    status: f.slice(sep + 1, post),
  }
}

/** Hex dump for logs: "01 24 21 4A 05 30 30 3E 3F 03". */
export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}
