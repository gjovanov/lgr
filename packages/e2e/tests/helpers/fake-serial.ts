import type { Page } from '@playwright/test'

/** What the page did with its serial port. */
export interface SerialStats {
  requested: number
  opened: number
  closed: number
  written: number
}

/**
 * A stand-in for Web Serial, which a headless browser has no port for: one port, whose opening,
 * closing and writing are counted on `window.__serial`, and a device that answers every frame with
 * one ETX, which is all `useFiscalBridge`'s relay waits for. So `useFiscalBridge`, its WebSocket and
 * the server's end of the bridge all run for real, and only the wire is fake.
 *
 * It proves the bridge stays up and still carries commands. It proves nothing about a real printer:
 * the server gets a byte it cannot read as an answer. Use a `datecs` device with it, which the server
 * does not probe on connecting (an Eltrade would time out here and have its port reopened).
 *
 * In an init script, so it is there before the app's first line. A page load gets a fresh one, and
 * the counters start over, which is how a spec sees that the document changed.
 */
export async function installFakeSerial(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const stats = { requested: 0, opened: 0, closed: 0, written: 0 }
    ;(window as any).__serial = stats

    class FakePort extends EventTarget {
      readable: ReadableStream<Uint8Array> | null = null
      writable: WritableStream<Uint8Array> | null = null
      private device: ReadableStreamDefaultController<Uint8Array> | null = null

      async open() {
        stats.opened++
        this.readable = new ReadableStream({ start: (c) => { this.device = c } })
        this.writable = new WritableStream({
          write: () => {
            stats.written++
            this.device?.enqueue(new Uint8Array([0x03]))
          },
        })
      }

      async close() { stats.closed++ }
      async setSignals() {}
      getInfo() { return {} }
    }

    const port = new FakePort()
    const serial = Object.assign(new EventTarget(), {
      requestPort: async () => { stats.requested++; return port },
      getPorts: async () => [port],
    })
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
  })
}

export function serialStats(page: Page): Promise<SerialStats> {
  return page.evaluate(() => (window as any).__serial)
}
