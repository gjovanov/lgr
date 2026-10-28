/**
 * FR-20.23 (plan step P1-3) — the fiscal in-flight count a graceful stop waits on.
 */
import { describe, expect, test } from 'bun:test'
import { fiscalInFlight, fiscalOperation, tracked, whenFiscalIdle } from 'fiscal/in-flight'

class Printer {
  calls = 0
  async closeFiscalReceipt() {
    this.calls++
    await Bun.sleep(20)
    return { fiscalReceiptNumber: '0000001' }
  }
  async fails() {
    await Bun.sleep(5)
    throw new Error('paper out')
  }
  status() {
    return 'online'
  }
}

describe('tracked printers', () => {
  test('a command counts while it runs, and only then', async () => {
    const p = tracked(new Printer())
    expect(fiscalInFlight()).toBe(0)
    const pending = p.closeFiscalReceipt()
    expect(fiscalInFlight()).toBe(1)
    expect(await pending).toEqual({ fiscalReceiptNumber: '0000001' })
    expect(fiscalInFlight()).toBe(0)
  })

  test('a failed command stops counting too', async () => {
    const p = tracked(new Printer())
    await p.fails().catch(() => {})
    expect(fiscalInFlight()).toBe(0)
  })

  test('the printer is itself: its state, its class, and the methods it lacks', () => {
    const raw = new Printer()
    const p = tracked(raw) as Printer & { cancelFiscalReceipt?: () => Promise<void> }
    expect(p.status()).toBe('online')
    expect(fiscalInFlight()).toBe(0)
    expect(p instanceof Printer).toBe(true)
    expect(p.cancelFiscalReceipt).toBeUndefined()
    void p.closeFiscalReceipt()
    expect(raw.calls).toBe(1)
    expect(p.closeFiscalReceipt).toBe(p.closeFiscalReceipt)
  })
})

describe('fiscalOperation', () => {
  test('counts from its first command to its last, the gaps between them included', async () => {
    const p = tracked(new Printer())
    const seen: number[] = []
    const op = fiscalOperation(async () => {
      await p.closeFiscalReceipt()
      seen.push(fiscalInFlight()) // between two commands: still the operation
      await p.closeFiscalReceipt()
    })
    await op
    expect(seen).toEqual([1])
    expect(fiscalInFlight()).toBe(0)
  })

  test('whenFiscalIdle waits for it, and gives up at its timeout', async () => {
    let release!: () => void
    const op = fiscalOperation(() => new Promise<void>(r => { release = r }))
    expect(await whenFiscalIdle(50, 10)).toBe(false)
    setTimeout(() => release(), 30)
    expect(await whenFiscalIdle(1000, 10)).toBe(true)
    await op
  })
})
