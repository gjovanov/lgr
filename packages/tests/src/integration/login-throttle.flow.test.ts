import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { LoginThrottle, User } from 'db/models'
import type { Types } from 'mongoose'

/**
 * S-08 — nothing capped password attempts, and `login()` told anyone which orgs and accounts
 * existed ('Organization not found' / 'Account is disabled' / 'Please login with your OAuth
 * provider', all answered before the password was checked).
 *
 * Over HTTP, because the throttle lives in the route: it needs the caller's address, and it must
 * answer a locked-out guesser before any argon2 work. The limits are shrunk so the suite stays
 * quick; the shape is what production runs (5 / 30 / 100 failures per 15 minutes).
 *
 * What it must NOT do matters as much as what it does:
 *   - an attacker at one address must not lock the real owner out from theirs;
 *   - successful sign-ins never count (a till signs in all day);
 *   - an `X-Forwarded-For` the CLIENT wrote must not choose who gets charged.
 */

const LIMITS = { perAccountAndIp: 3, perAccount: 6, perIp: 8 }
/** The factory's password for every member it creates, and one that is never right. */
const RIGHT = 'test123'
const WRONG = 'wrong-password'
const saved = { ...config.loginThrottle }

let app: Elysia
let org: { _id: Types.ObjectId; slug: string }

async function login(
  body: { username: string; password: string; orgSlug?: string },
  headers: Record<string, string> = {},
) {
  const res = await app.handle(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ orgSlug: org.slug, ...body }),
    }),
  )
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as any }
}
const from = (ip: string) => ({ 'x-real-ip': ip })

async function member(username: string) {
  await createTestUser(org._id, { username, email: `${username}@throttle.test`, role: 'member' } as any)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  Object.assign(config.loginThrottle, { enabled: true, ...LIMITS })
  const o = await createTestOrg({ slug: 'throttle-org' } as any)
  org = { _id: o._id as Types.ObjectId, slug: 'throttle-org' }
}, 120_000)

afterAll(async () => {
  Object.assign(config.loginThrottle, saved)
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await LoginThrottle.deleteMany({}).exec()
})

describe('S-08: failed sign-ins are throttled', () => {
  it('locks a guesser at one address out of that account, even once they have the password', async () => {
    await member('pair-victim')
    for (let i = 0; i < LIMITS.perAccountAndIp; i++) {
      expect((await login({ username: 'pair-victim', password: WRONG }, from('203.0.113.10'))).status).toBe(401)
    }

    const locked = await login({ username: 'pair-victim', password: RIGHT }, from('203.0.113.10'))
    expect(locked.status).toBe(429)
    expect(locked.body.code).toBe('too_many_attempts')
    expect(Number(locked.retryAfter)).toBeGreaterThan(0)
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('does not follow the account to the owner at another address', async () => {
    await member('owner-elsewhere')
    for (let i = 0; i < LIMITS.perAccountAndIp; i++) {
      await login({ username: 'owner-elsewhere', password: WRONG }, from('203.0.113.11'))
    }
    expect((await login({ username: 'owner-elsewhere', password: RIGHT }, from('203.0.113.11'))).status).toBe(429)

    const owner = await login({ username: 'owner-elsewhere', password: RIGHT }, from('198.51.100.20'))
    expect(owner.status).toBe(200)
  })

  it('locks an account guessed from many addresses, for everyone, after perAccount failures', async () => {
    await member('botnet-victim')
    for (let i = 0; i < LIMITS.perAccount; i++) {
      expect((await login({ username: 'botnet-victim', password: WRONG }, from(`192.0.2.${10 + i}`))).status).toBe(401)
    }

    const fresh = await login({ username: 'botnet-victim', password: RIGHT }, from('192.0.2.200'))
    expect(fresh.status).toBe(429)
  })

  it('locks out one address spraying many accounts after perIp failures', async () => {
    await member('spray-real')
    for (let i = 0; i < LIMITS.perIp; i++) {
      expect((await login({ username: `spray-${i}`, password: WRONG }, from('198.51.100.66'))).status).toBe(401)
    }

    const real = await login({ username: 'spray-real', password: RIGHT }, from('198.51.100.66'))
    expect(real.status).toBe(429)
    // The same account from anywhere else is fine.
    expect((await login({ username: 'spray-real', password: RIGHT }, from('198.51.100.67'))).status).toBe(200)
  })

  it('never counts a successful sign-in', async () => {
    await member('busy-till')
    for (let i = 0; i < LIMITS.perIp + LIMITS.perAccount; i++) {
      expect((await login({ username: 'busy-till', password: RIGHT }, from('198.51.100.30'))).status).toBe(200)
    }
  })

  it('charges the last X-Forwarded-For hop (our proxy), never the one the client wrote', async () => {
    await member('xff-victim')
    // The attacker writes the victim's address first; our proxy appends the real one last.
    const spoofed = { 'x-forwarded-for': '198.51.100.99, 203.0.113.77' }
    for (let i = 0; i < LIMITS.perAccountAndIp; i++) {
      expect((await login({ username: 'xff-victim', password: WRONG }, spoofed)).status).toBe(401)
    }

    expect((await login({ username: 'xff-victim', password: RIGHT }, from('198.51.100.99'))).status).toBe(200)
    expect((await login({ username: 'xff-victim', password: RIGHT }, from('203.0.113.77'))).status).toBe(429)
  })

  it('does not charge a correct password on an account that is not activated', async () => {
    await member('pending-owner')
    await User.updateOne({ username: 'pending-owner', orgId: org._id }, { $set: { isActive: false } }).exec()

    for (let i = 0; i < LIMITS.perAccountAndIp + 1; i++) {
      const res = await login({ username: 'pending-owner', password: RIGHT }, from('198.51.100.40'))
      expect(res.status).toBe(401)
      expect(res.body.code).toBe('not_activated')
    }
  })
})

describe('S-08: sign-in failures do not say what exists', () => {
  it('a missing org, a missing user, a wrong password and an OAuth-only account answer identically', async () => {
    await member('enum-real')
    await member('enum-oauth')
    await User.updateOne({ username: 'enum-oauth', orgId: org._id }, { $unset: { password: 1 } }).exec()

    const answers = [
      await login({ orgSlug: 'no-such-org', username: 'enum-real', password: RIGHT }, from('198.51.100.50')),
      await login({ username: 'no-such-user', password: RIGHT }, from('198.51.100.51')),
      await login({ username: 'enum-real', password: WRONG }, from('198.51.100.52')),
      await login({ username: 'enum-oauth', password: RIGHT }, from('198.51.100.53')),
    ]

    for (const a of answers) {
      expect(a.status).toBe(401)
      expect(a.body).toEqual({ message: 'Invalid credentials', code: 'invalid_credentials' })
    }
  })
})
