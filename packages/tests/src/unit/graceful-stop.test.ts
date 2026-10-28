/**
 * FR-20.23 (plan step P1-3) — the API's graceful stop: what it waits for, and in what order.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { fiscalOperation } from 'fiscal/in-flight'
import { gracefulStop, isStopping, resetGracefulStopForTests } from '../../../portal-api/src/front/graceful-stop'

afterEach(() => resetGracefulStopForTests())

function harness(pending = 0) {
  const events: string[] = []
  const server = {
    pendingRequests: pending,
    stop: (close?: boolean) => { events.push(`listener stopped (close=${close})`) },
  }
  let exitCode: number | undefined
  const exited = new Promise<number>(resolve => {
    const deps = {
      server,
      waitMs: 2000,
      closeControl: () => events.push('control closed'),
      disconnect: async () => { events.push('database closed') },
      exit: (code: number) => { exitCode = code; events.push(`exit ${code}`); resolve(code) },
    }
    ;(harness as any).deps = deps
  })
  return { events, server, exited, deps: (harness as any).deps, code: () => exitCode }
}

describe('gracefulStop', () => {
  test('stops listening first, keeps open connections, and exits 0 last', async () => {
    const h = harness()
    await gracefulStop('test', h.deps)
    expect(await h.exited).toBe(0)
    expect(h.events[0]).toBe('listener stopped (close=false)')
    expect(h.events.slice(-3)).toEqual(['control closed', 'database closed', 'exit 0'])
  })

  test('waits for a receipt in flight before it disconnects anything', async () => {
    const h = harness()
    let printed = false
    const receipt = fiscalOperation(async () => {
      await Bun.sleep(300)
      printed = true
      h.events.push('receipt printed')
    })
    const started = Date.now()
    await gracefulStop('test', h.deps)
    await receipt
    expect(printed).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(h.events.indexOf('receipt printed')).toBeLessThan(h.events.indexOf('control closed'))
  })

  test('waits for the requests being served, and gives up at its deadline', async () => {
    const h = harness(1)
    h.deps.waitMs = 300
    const started = Date.now()
    await gracefulStop('test', h.deps)
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect(h.code()).toBe(0)
  })

  test('a second stop while stopping is the same stop', async () => {
    const h = harness()
    const first = gracefulStop('control socket', h.deps)
    expect(isStopping()).toBe(true)
    const second = gracefulStop('SIGTERM', h.deps)
    expect(second).toBe(first)
    await first
    expect(h.events.filter(e => e.startsWith('exit'))).toEqual(['exit 0'])
  })
})
