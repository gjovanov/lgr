import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'
import { startReplSet } from '../two-node/harness'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * mongod can find the port that mongodb-memory-server chose for it taken (`startReplSet` in
 * two-node/harness.ts says how). The lane it happened in cannot make it happen on purpose, so the
 * second try is proved here, with the library's own error text from master run 42937803400.
 */
const taken = () => new Error('Port "33933" already in use')
const replSet = (name: string) => ({ name }) as unknown as MongoMemoryReplSet

describe('a replica set whose mongod found its port taken', () => {
  let warn: ReturnType<typeof spyOn>
  beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it('is started again, and the one that came up is the one returned', async () => {
    const second = replSet('second')
    let calls = 0
    const got = await startReplSet(async () => { if (++calls === 1) throw taken(); return second })
    expect(got).toBe(second)
    expect(calls).toBe(2)
    // The log says it happened: how often it does is read from there.
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      '[two-node] mongod found its port taken: starting another replica set (try 2 of 3)',
    ])
  })

  it('is given up on after three tries, with the error of the last', async () => {
    const errors: Error[] = []
    const err = await captureRejection(startReplSet(async () => { errors.push(taken()); throw errors.at(-1) }))
    expect(errors).toHaveLength(3)
    expect(err).toBe(errors[2])
  })

  it('is not started again after any other failure', async () => {
    const other = new Error('Instance closed unexpectedly with code "14" and signal "null"')
    let calls = 0
    const err = await captureRejection(startReplSet(async () => { calls++; throw other }))
    expect(err).toBe(other)
    expect(calls).toBe(1)
    expect(warn.mock.calls).toHaveLength(0)
  })

  it('is started once when nothing is in its way', async () => {
    const only = replSet('only')
    let calls = 0
    expect(await startReplSet(async () => { calls++; return only })).toBe(only)
    expect(calls).toBe(1)
  })
})
