/**
 * FR-20.29 (plan step P1-6) — pairing is FR-14's enrollment, against the master: the code names the
 * master's LAN address and pins its own CA.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeDesktopStub, enrollBody } from '../helpers/desktop-stub'
import { Org, OrgHome } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { enrollDesktop, enrollmentTarget, mintEnrollmentCode } from 'services/biz/desktop/desktop.service'
import { config } from 'config'

/** The vector `unit/fingerprint-words.test.ts` shares with the desktop shell. */
const VECTOR = {
  fp: 'sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k',
  words: ['chest', 'leaf', 'question', 'voice', 'credit', 'utility'],
}
const LAN = 'https://192.168.1.10:4443'
const CONSOLE = 'http://127.0.0.1:4480'

const saved = { lan: { ...config.front.lan } }

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await clearCollections()
  forgetAllHomes()
  ;(config.node as any).role = 'global'
  ;(config.node as any).id = undefined
  Object.assign(config.front.lan, saved.lan)
})

/** An org homed on this master (`node-shop-1`), and its admin. */
async function onThisMaster() {
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  await OrgHome.create({ orgId: org._id, home: 'node-shop-1', epoch: 1 })
  await Org.updateOne({ _id: org._id }, { $set: { homeEpochHighWater: 1 } }).exec()
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'node-shop-1'
  forgetAllHomes()
  return { orgId: String(org._id), userId: String(admin._id) }
}

describe('pairing a desktop with a master (FR-20.29)', () => {
  test('the code names the LAN, pins the CA, carries its six words, and still enrolls a desktop', async () => {
    const { orgId, userId } = await onThisMaster()
    Object.assign(config.front.lan, { url: LAN, caFingerprint: VECTOR.fp })
    // The admin is on the setup console, an address no till can reach.
    const minted = await mintEnrollmentCode(orgId, userId, CONSOLE)
    expect(minted.server).toBe(LAN)
    expect(minted.fingerprint).toBe(VECTOR.fp)
    expect(minted.words).toEqual(VECTOR.words)
    expect(minted.deepLink).toBe(
      `lgr://enroll?server=${encodeURIComponent(LAN)}&code=${encodeURIComponent(minted.code)}&fp=${encodeURIComponent(VECTOR.fp)}`,
    )
    // FR-14's enrollment, unchanged: the code works on the master that minted it.
    const res = await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any)
    expect(res.orgId).toBe(orgId)
  })

  test('without its LAN ingress, a master names the address the admin is on, and pins nothing', async () => {
    const { orgId, userId } = await onThisMaster()
    Object.assign(config.front.lan, { url: undefined, caFingerprint: undefined })
    const minted = await mintEnrollmentCode(orgId, userId, CONSOLE)
    expect(minted.server).toBe(CONSOLE)
    expect(minted.deepLink).not.toContain('&fp=')
    expect(minted.words).toBeUndefined()
  })

  test('a fingerprint that is not one is never offered: no fp, no words', async () => {
    ;(config.node as any).role = 'master'
    Object.assign(config.front.lan, { url: LAN, caFingerprint: 'sha256:not-a-digest' })
    expect(enrollmentTarget(CONSOLE)).toEqual({ server: CONSOLE })
  })

  test('on lgrai.app nothing changes, even with LAN settings in the environment', async () => {
    const org = await createTestOrg()
    const admin = await createTestUser(org._id, { role: 'admin' } as any)
    Object.assign(config.front.lan, { url: LAN, caFingerprint: VECTOR.fp })
    const minted = await mintEnrollmentCode(String(org._id), String(admin._id), 'https://lgrai.app')
    expect(minted.server).toBe('https://lgrai.app')
    expect(minted.deepLink).toBe(`lgr://enroll?server=${encodeURIComponent('https://lgrai.app')}&code=${encodeURIComponent(minted.code)}`)
    expect(minted.words).toBeUndefined()
  })
})
