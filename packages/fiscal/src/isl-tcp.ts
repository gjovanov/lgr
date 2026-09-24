/**
 * TCP transport for ISL-framed devices — used when the device sits behind the serial-to-TCP
 * bridge (`packages/fiscal/src/bridge.ts`) with connectionType 'tcp'.
 *
 * Mirrors the browser relay's ISL reading rules: an answer is complete when a frame carrying
 * the request's SEQ has arrived (stale frames from an earlier, timed-out command are skipped)
 * or on a bare NAK; SYN bytes mean "busy" and keep the exchange alive.
 */

import { createConnection, type Socket } from 'net'
import { parseIslStream } from './isl-frame.js'
import type { FiscalExchangeOptions } from './types.js'

/** The device answers within 60 ms; allow for the bridge and network. */
const FIRST_BYTE_MS = 2_500
/** SYN arrives every 60 ms while the device is busy; silence this long means it is gone. */
const IDLE_MS = 8_000
/** Commands budgeted beyond this (reports) are waited on without the first-byte/idle limits. */
const LONG_COMMAND_MS = 60_000

export class IslTcpTransport {
  private socket: Socket | null = null

  constructor(private readonly host: string, private readonly port: number) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port })
      const fail = (err: Error) => {
        socket.destroy()
        reject(err)
      }
      socket.setTimeout(5_000, () => fail(new Error(`TCP connect timeout (${this.host}:${this.port})`)))
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.setTimeout(0)
        socket.off('error', fail)
        socket.on('error', () => { /* surfaced through 'close' */ })
        socket.setNoDelay(true)
        this.socket = socket
        resolve()
      })
    })
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }

  exchange = (frame: Buffer, opts: FiscalExchangeOptions = {}): Promise<Buffer> => {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('Fiscal device not connected'))
    const seq = frame[2]
    const budget = opts.timeoutMs ?? 30_000
    const long = budget > LONG_COMMAND_MS
    const deadline = Date.now() + budget

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (err?: Error) => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('close', onClose)
        if (err) reject(err)
        else resolve(Buffer.concat(chunks))
      }
      const arm = (ms: number) => {
        clearTimeout(timer)
        const wait = Math.max(1, Math.min(ms, deadline - Date.now()))
        timer = setTimeout(() => finish(new Error(`Fiscal device timeout (no answer within ${wait} ms)`)), wait)
      }
      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const parsed = parseIslStream(Buffer.concat(chunks))
        if (parsed.frames.some(f => f.seq === seq) || parsed.nak) return finish()
        arm(long ? budget : IDLE_MS)
      }
      const onClose = () => finish(new Error('Fiscal device disconnected'))

      socket.on('data', onData)
      socket.once('close', onClose)
      arm(long ? budget : FIRST_BYTE_MS)
      socket.write(frame)
    })
  }
}
