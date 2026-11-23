/**
 * FR-20.23 (plan step P1-3) — the API's graceful stop: what it waits for, and in what order.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { fiscalOperation } from 'fiscal/in-flight'
import { newSchedulerHealth, runTick, stopSchedulers, useLeaseReleaser, useLeaseTaker, type SchedulerDef } from 'services/scheduler/registry'
import { gracefulStop, isStopping, resetGracefulStopForTests } from '../../../api/src/front/graceful-stop'

afterEach(() => {
  resetGracefulStopForTests()
  stopSchedulers()
})

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
      stopCapture: async () => { events.push('capture stopped') },
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

  test('gives back the leases of its schedulers and stops the capture, before the database closes', async () => {
    const h = harness()
    const given: string[][] = []
    useLeaseTaker(async () => true, 'host#1')
    useLeaseReleaser(async (names, holder) => {
      given.push(names)
      h.events.push(`leases of ${holder} given back: ${names.join(',')}`)
      return names.length
    })
    const def: SchedulerDef = { name: 'job-o', intervalMs: 10_000, where: 'one', tick: async () => {} }
    await runTick(def, newSchedulerHealth(def))
    await gracefulStop('test', h.deps)
    expect(given).toEqual([['job-o']])
    const at = (e: string) => h.events.indexOf(e)
    expect(at('leases of host#1 given back: job-o')).toBeGreaterThan(at('listener stopped (close=false)'))
    expect(at('capture stopped')).toBeGreaterThan(at('leases of host#1 given back: job-o'))
    expect(at('database closed')).toBeGreaterThan(at('capture stopped'))
  })

  test('a capture that does not answer holds the stop up two seconds at most', async () => {
    const h = harness()
    h.deps.stopCapture = () => new Promise(() => {})
    const started = Date.now()
    await gracefulStop('test', h.deps)
    expect(Date.now() - started).toBeLessThan(3000)
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
