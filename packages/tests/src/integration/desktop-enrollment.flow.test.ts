import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeDesktopStub, enrollBody } from '../helpers/desktop-stub'
import { Desktop, DesktopEnrollmentCode, DesktopEnrollmentKey, DesktopEnrollmentKeyUse, Org } from 'db/models'
import {
  DesktopError,
  enrollDesktop,
  mintEnrollmentCode,
  mintEnrollmentKey,
  reapEphemeralDesktops,
  revokeDesktop,
  updateDesktop,
} from 'services/biz/desktop/desktop.service'

/**
 * Desktop enrollment (FR-14.19).
 *
 * ⚠ `captureRejection`, never `.rejects` — one of those matchers reaps the shared mongod on Windows
 * and cascades every later file into ECONNREFUSED (CLAUDE.md).
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function seed(opts: { ephemeralKeys?: boolean } = {}) {
  const org = await createTestOrg(
    opts.ephemeralKeys ? ({ settings: { desktop: { ephemeralKeysEnabled: true } } } as any) : {},
  )
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  return { orgId: String(org._id), userId: String(admin._id), org }
}

describe('enrollment codes', () => {
  it('mints a human-typable code and enrolls a desktop with it', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    // Crockford base32, shown as XXXX-XXXX.
    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(minted.deepLink).toContain('lgr://enroll?server=')

    const stub = makeDesktopStub()
    const res = await enrollDesktop({ ...enrollBody(stub), code: minted.code } as any)

    expect(res.orgId).toBe(orgId)
    expect(res.desktopId).toBeTruthy()
    expect(res.serverTime).toBeTruthy()
    const row = await Desktop.findById(res.desktopId).lean()
    expect((row as any).status).toBe('active')
    expect((row as any).ephemeral).toBe(false)
    expect((row as any).keyEpoch).toBe(1)
  })

  it('never stores the code in plain text', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const row: any = await DesktopEnrollmentCode.findOne({}).lean()
    expect(JSON.stringify(row)).not.toContain(minted.code.replace('-', ''))
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/)
    // The prefix is deliberately in the clear — it is what the rate limiter counts against.
    expect(minted.code.startsWith(row.codePrefix)).toBe(true)
  })

  it('accepts the code as a human would mistype it', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    // Lower case, spaces instead of the dash, and the Crockford aliases O->0 and I/L->1.
    const mistyped = minted.code.toLowerCase().replace('-', '  ').replace(/0/g, 'O').replace(/1/g, 'l')
    const stub = makeDesktopStub()
    const res = await enrollDesktop({ ...enrollBody(stub), code: mistyped } as any)
    expect(res.orgId).toBe(orgId)
  })

  it('refuses a second use of the same code', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any)

    const err = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any),
    )
    expect(err).toBeInstanceOf(DesktopError)
    expect((err as DesktopError).code).toBe('enroll_refused')
  })

  it('of desktops racing for one code, exactly one enrolls', async () => {
    // A code was checked, a desktop enrolled, and only then the code marked used: three tills
    // sending one code at the same moment all enrolled. The claim is the conditional update now.
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any)))
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect(await Desktop.countDocuments({ orgId })).toBe(1)
  })

  it('a refused enrollment does not consume the code', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const err = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), machineId: '', code: minted.code } as any),
    )
    expect(err).toBeInstanceOf(DesktopError)
    const row: any = await DesktopEnrollmentCode.findById(minted.id).lean()
    expect(row.usedAt).toBeUndefined()
    await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any)
  })

  it('refuses an expired code', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    // ⚠ The TTL index is a floor Mongo sweeps about once a minute, so the expiry check has to be
    // the date comparison in the code — which is what this asserts.
    await DesktopEnrollmentCode.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const err = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any),
    )
    expect((err as DesktopError).code).toBe('enroll_refused')
  })

  it('rate-limits repeated wrong guesses at a real code', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    // Expire it so every attempt fails and increments the counter on that row.
    await DesktopEnrollmentCode.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    let last: any
    for (let i = 0; i < 12; i++) {
      last = await captureRejection(
        enrollDesktop({ ...enrollBody(makeDesktopStub()), code: minted.code } as any),
      )
    }
    // Eventually it stops even looking: 429 rather than 400.
    expect((last as DesktopError).statusCode).toBe(429)
  })

  it('gives one flat message for unknown, used and expired codes', async () => {
    const { orgId, userId } = await seed()
    const used = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: used.code } as any)
    const expired = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    await DesktopEnrollmentCode.updateOne(
      { _id: (await DesktopEnrollmentCode.findOne({ usedAt: null }).lean() as any)._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    )

    const messages: string[] = []
    for (const code of [used.code, expired.code, 'ZZZZ-ZZZZ']) {
      const e = await captureRejection(enrollDesktop({ ...enrollBody(makeDesktopStub()), code } as any))
      messages.push((e as Error).message)
    }
    // ⚠ An enroll endpoint that distinguishes these is an oracle for probing an org's codes.
    expect(new Set(messages).size).toBe(1)
  })

  it('refuses a public key that is not Ed25519 SPKI', async () => {
    const { orgId, userId } = await seed()
    const minted = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const stub = makeDesktopStub()
    for (const bad of ['', 'x'.repeat(60), Buffer.from('nope').toString('base64')]) {
      const e = await captureRejection(
        enrollDesktop({ ...enrollBody(stub), publicKey: bad, code: minted.code } as any),
      )
      expect((e as DesktopError).code).toBe('bad_public_key')
    }
  })
})

describe('re-enrollment revives the row', () => {
  it('keeps the assignment and the admin-set name, and rotates the key', async () => {
    const { orgId, userId } = await seed()
    const stub = makeDesktopStub()
    const first = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const res1 = await enrollDesktop({ ...enrollBody(stub), code: first.code } as any)

    // An admin renames it and assigns a start path, then revokes it.
    await updateDesktop(orgId, res1.desktopId, { name: 'Till 2 (front)', startPath: '/pos/' })
    await revokeDesktop(orgId, res1.desktopId, userId, 'replacing the PC')

    // The same machine re-enrolls with a NEW keypair.
    const stub2 = makeDesktopStub({ installationId: stub.installationId, machineId: stub.machineId })
    const second = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const res2 = await enrollDesktop({ ...enrollBody(stub2), code: second.code } as any)

    // ⚠ The SAME row, revived — not a second row. That is why the unique index is partial.
    expect(res2.desktopId).toBe(res1.desktopId)
    expect(await Desktop.countDocuments({ orgId })).toBe(1)

    const row: any = await Desktop.findById(res2.desktopId).lean()
    expect(row.status).toBe('active')
    expect(row.revokedAt).toBeFalsy()
    // The admin's rename survives a reinstall; the assignment does too.
    expect(row.name).toBe('Till 2 (front)')
    expect(row.startPath).toBe('/pos/')
    // And the key rotated, so tokens minted for the old key are dead.
    expect(row.keyEpoch).toBe(2)
    expect(row.publicKey).toBe(stub2.publicKey)
  })

  it('lets the desktop rename itself only while no admin has', async () => {
    const { orgId, userId } = await seed()
    const stub = makeDesktopStub()
    const c1 = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const res = await enrollDesktop({ ...enrollBody(stub), code: c1.code, name: 'first' } as any)
    await revokeDesktop(orgId, res.desktopId, userId)

    const c2 = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    await enrollDesktop({
      ...enrollBody(makeDesktopStub({ installationId: stub.installationId })),
      code: c2.code,
      name: 'renamed by the machine',
    } as any)
    expect((await Desktop.findById(res.desktopId).lean() as any).name).toBe('renamed by the machine')
  })
})

describe('ephemeral enrollment keys', () => {
  it('refuses to mint one unless the org opted in', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: false })
    const e = await captureRejection(mintEnrollmentKey(orgId, userId, { name: 'lane' }))
    expect((e as DesktopError).code).toBe('ephemeral_keys_disabled')
  })

  it('enrolls an ephemeral desktop and records the use', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: true })
    const key = await mintEnrollmentKey(orgId, userId, { name: 'win11 lane', maxUses: 5 })
    const res = await enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)

    const row: any = await Desktop.findById(res.desktopId).lean()
    expect(row.ephemeral).toBe(true)
    expect(row.ephemeralTtlSec).toBe(900)

    const uses = await DesktopEnrollmentKeyUse.find({ orgId }).lean()
    expect(uses).toHaveLength(1)
    expect(String((uses[0] as any).desktopId)).toBe(res.desktopId)
    expect((await DesktopEnrollmentKey.findById(key.id).lean() as any).uses).toBe(1)
  })

  it('stops at maxUses, and after revocation', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: true })
    const key = await mintEnrollmentKey(orgId, userId, { name: 'one shot', maxUses: 1 })
    await enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)

    const e = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any),
    )
    expect((e as DesktopError).code).toBe('enroll_refused')

    const key2 = await mintEnrollmentKey(orgId, userId, { name: 'revoked', maxUses: 0 })
    await DesktopEnrollmentKey.updateOne({ _id: key2.id }, { $set: { revokedAt: new Date() } })
    const e2 = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key2.secret } as any),
    )
    expect((e2 as DesktopError).code).toBe('enroll_refused')
  })

  it('of desktops racing for a key\'s last use, one enrolls', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: true })
    const key = await mintEnrollmentKey(orgId, userId, { name: 'one shot', maxUses: 1 })
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)))
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect((await DesktopEnrollmentKey.findById(key.id).lean() as any).uses).toBe(1)
    expect(await DesktopEnrollmentKeyUse.countDocuments({ orgId })).toBe(1)
  })

  it('turning the org setting off revokes the whole class at once', async () => {
    const { orgId, userId, org } = await seed({ ephemeralKeys: true })
    const key = await mintEnrollmentKey(orgId, userId, { name: 'lane', maxUses: 0 })
    await enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)

    // ⚠ Checked on USE, not only at minting — that is what makes the switch a kill switch.
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.desktop.ephemeralKeysEnabled': false } })
    const e = await captureRejection(
      enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any),
    )
    expect((e as DesktopError).code).toBe('ephemeral_keys_disabled')
  })
})

describe('the reaper', () => {
  it('removes an ephemeral desktop that stopped reporting', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: true })
    const key = await mintEnrollmentKey(orgId, userId, { name: 'lane', ephemeralTtlSec: 60 })
    const res = await enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)

    expect(await reapEphemeralDesktops(new Date())).toBe(0)           // just seen
    const later = new Date(Date.now() + 120_000)
    expect(await reapEphemeralDesktops(later)).toBe(1)
    expect(await Desktop.findById(res.desktopId).lean()).toBeNull()
  })

  it('NEVER touches a permanent desktop, however long it has been away', async () => {
    // ⚠ The negative case is the one that matters. A reaper that gets this wrong deletes a
    // customer's till because the shop's internet was down.
    const { orgId, userId } = await seed()
    const code = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const res = await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: code.code } as any)
    await Desktop.updateOne({ _id: res.desktopId }, { $set: { lastSeenAt: new Date(0) } })

    expect(await reapEphemeralDesktops(new Date(Date.now() + 86_400_000))).toBe(0)
    expect(await Desktop.findById(res.desktopId).lean()).toBeTruthy()
  })
})

describe('revocation', () => {
  it('keeps a permanent row for the audit trail, and deletes an ephemeral one', async () => {
    const { orgId, userId } = await seed({ ephemeralKeys: true })

    const code = await mintEnrollmentCode(orgId, userId, 'https://lgrai.app')
    const perm = await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: code.code } as any)
    await revokeDesktop(orgId, perm.desktopId, userId, 'sold the PC')
    const permRow: any = await Desktop.findById(perm.desktopId).lean()
    expect(permRow.status).toBe('revoked')
    expect(permRow.revokeReason).toBe('sold the PC')

    const key = await mintEnrollmentKey(orgId, userId, { name: 'lane' })
    const eph = await enrollDesktop({ ...enrollBody(makeDesktopStub()), enrollmentKey: key.secret } as any)
    await revokeDesktop(orgId, eph.desktopId, userId)
    expect(await Desktop.findById(eph.desktopId).lean()).toBeNull()
  })

  it('refuses to revoke another org\'s desktop', async () => {
    const a = await seed()
    const b = await seed()
    const code = await mintEnrollmentCode(a.orgId, a.userId, 'https://lgrai.app')
    const res = await enrollDesktop({ ...enrollBody(makeDesktopStub()), code: code.code } as any)

    const e = await captureRejection(revokeDesktop(b.orgId, res.desktopId, b.userId))
    expect((e as DesktopError).statusCode).toBe(404)
    expect((await Desktop.findById(res.desktopId).lean() as any).status).toBe('active')
  })
})
