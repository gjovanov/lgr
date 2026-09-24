/**
 * When is an ISL device's answer complete? — the browser relay's half of the protocol.
 *
 * ISL = the Datecs-style framing Eltrade (and Daisy/Datecs) devices speak:
 *   answer  <01><LEN><SEQ><CMD><DATA><04><STATUS×6><05><BCC×4><03>
 *   NAK 15h — the device rejected our frame (the server resends it)
 *   SYN 16h — busy, repeated every 60 ms until the answer is ready
 *
 * The relay stops reading at the first frame that carries the SEQ of the command it just
 * wrote. A frame with another SEQ is a late answer to an earlier command that timed out; it
 * is dropped here, or it would be handed to the NEXT command and every exchange after it
 * would be answered one step behind.
 *
 * Integrity (BCC) is checked on the server, which owns the protocol; this only has to find
 * frame boundaries — unambiguous, because inside a valid answer 01h and 03h never occur.
 * Mirrors `packages/fiscal/src/isl-frame.ts` deliberately rather than importing it: no
 * `*-ui` package depends on a server package.
 */

const PREAMBLE = 0x01
const TERMINATOR = 0x03
const POSTAMBLE = 0x05
const NAK = 0x15
const SYN = 0x16

export type IslCollectState = 'more' | 'frame' | 'nak'

export class IslResponseCollector {
  private buffer: number[] = []
  private result: Uint8Array | null = null
  /** Bytes seen so far, SYN included — any byte means the device is alive. */
  received = 0

  /** @param seq the SEQ byte of the request frame (frame[2]) */
  constructor(private readonly seq: number) {}

  push(chunk: Uint8Array): IslCollectState {
    if (this.result) return this.result.length === 1 ? 'nak' : 'frame'
    this.received += chunk.length
    for (const b of chunk) this.buffer.push(b)
    return this.scan()
  }

  /** What to send back to the server: the matching frame, or a lone NAK. */
  bytes(): Uint8Array {
    return this.result ?? Uint8Array.from(this.buffer)
  }

  private scan(): IslCollectState {
    let i = 0
    let nak = false
    while (i < this.buffer.length) {
      const b = this.buffer[i]
      if (b === SYN) { i++; continue }
      if (b === NAK) { nak = true; i++; continue }
      if (b !== PREAMBLE) { i++; continue }

      const end = this.buffer.indexOf(TERMINATOR, i + 1)
      if (end === -1) {
        // Frame still arriving — keep it, drop what came before it.
        this.buffer = this.buffer.slice(i)
        return 'more'
      }
      const frame = this.buffer.slice(i, end + 1)
      i = end + 1
      // Minimal shape check (01 LEN SEQ CMD … 05 BCC×4 03) before trusting the SEQ byte.
      if (frame.length >= 17 && frame[frame.length - 6] === POSTAMBLE && frame[2] === this.seq) {
        this.result = Uint8Array.from(frame)
        return 'frame'
      }
      // Anything else is a stale answer or noise: discard and keep reading.
    }
    this.buffer = []
    if (nak) {
      this.result = Uint8Array.of(NAK)
      return 'nak'
    }
    return 'more'
  }
}
