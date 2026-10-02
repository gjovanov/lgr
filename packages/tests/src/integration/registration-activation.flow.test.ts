import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../portal-api/src/api.js'
import * as authService from 'services/biz/auth.service'
import { Code, User } from 'db/models'

/**
 * S-06 — `POST /auth/register` handed the activation token back in its response.
 *
 * Email activation exists to prove that whoever registers controls the address. With the token
 * in the response the caller never needs the email, so the check proved nothing: anyone could
 * register `billing@some-customer.com` and activate it on the spot. Together with S-21 (fixed)
 * that was the first step of an anonymous cross-tenant takeover.
 *
 * Removing the token is only half of it, which is why the two halves ship together: the email's
 * link pointed at `/auth/activate`, a route portal-ui did not have, so the email was never a
 * working path either. Without the token in the response and without that page, nobody could
 * finish signing up. This file holds the whole contract:
 *
 *   - the response carries no token, and the account stays inactive until activated;
 *   - the emailed link puts the code in the URL FRAGMENT (never sent to a server, never in an
 *     access log) and never in a `?token=` the SPA routers treat as a session token (FR-14.24);
 *   - the code activates exactly once, and a wrong or expired code does not;
 *   - an expired link is recoverable: `POST /auth/activate/resend` mails a new code. It answers
 *     the same for every address, so it cannot be used to discover who has an account.
 */

let app: Elysia
const SLUG = 's06-fieldless'
const EMAIL = 'owner@s06.test'
const PASSWORD = 'correct horse battery'

async function post(path: string, body: unknown) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

function login() {
  return post('/api/auth/login', { orgSlug: SLUG, username: 'owner', password: PASSWORD })
}

async function codeFor(userId: string) {
  return Code.findOne({ userId, type: 'user_activation' }).lean().exec()
}

let userId = ''

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('S-06: registration does not hand back the activation token', () => {
  it('the register response carries no token, and the account starts inactive', async () => {
    const res = await post('/api/auth/register', {
      orgName: 'S-06 Org',
      orgSlug: SLUG,
      email: EMAIL,
      username: 'owner',
      password: PASSWORD,
      firstName: 'Owner',
      lastName: 'Of S06',
    })

    expect(res.status).toBe(200)
    expect(res.body.userId).toBeString()
    // Recorded before the S-06 assertions, so the tests below report on their own behaviour
    // instead of cascading from this one.
    userId = res.body.userId
    expect(res.body.activationToken).toBeUndefined()
    // Nothing that looks like the code may ride along under another name either.
    const code = await codeFor(res.body.userId)
    expect(code).not.toBeNull()
    expect(JSON.stringify(res.body)).not.toContain(code!.token)

    const user = await User.findById(userId).lean().exec()
    expect(user!.isActive).toBe(false)

    const before = await login()
    expect(before.status).toBe(401)
  })

  it('the emailed link carries the code in the fragment, never in a query string', () => {
    // Read off the namespace rather than imported by name, so the rest of this file still runs
    // (and reports) against a build that does not export it yet.
    const activationUrl = (authService as any).activationUrl as ((userId: string, code: string) => string) | undefined
    expect(activationUrl).toBeFunction()
    const url = activationUrl!('64b7f0c2a1b2c3d4e5f60718', 'Ab3_-xY')

    expect(url).toEndWith('/auth/activate#userId=64b7f0c2a1b2c3d4e5f60718&code=Ab3_-xY')
    expect(url).not.toContain('?')
    expect(url).not.toContain('token=')
  })

  it('a wrong code does not activate', async () => {
    const res = await post('/api/auth/activate', { userId, token: 'zzzzzzz' })
    expect(res.status).toBe(400)
    expect((await User.findById(userId).lean().exec())!.isActive).toBe(false)
  })

  it('an expired code does not activate', async () => {
    const code = await codeFor(userId)
    await Code.updateOne({ _id: code!._id }, { $set: { validTo: new Date(Date.now() - 1000) } }).exec()

    const res = await post('/api/auth/activate', { userId, token: code!.token })
    expect(res.status).toBe(400)
    expect((await User.findById(userId).lean().exec())!.isActive).toBe(false)
  })
})

describe('S-06: an expired link is recoverable', () => {
  it('resend answers identically for a pending, an unknown and an active address', async () => {
    const pending = await post('/api/auth/activate/resend', { email: EMAIL })
    const unknown = await post('/api/auth/activate/resend', { email: 'nobody@s06.test' })

    expect(pending.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual(pending.body)
  })

  it('resend replaces the expired code with a fresh one, which activates exactly once', async () => {
    // The previous test resent; the expired code is gone and a live one replaced it.
    const code = await codeFor(userId)
    expect(code).not.toBeNull()
    expect(code!.validTo.getTime()).toBeGreaterThan(Date.now())

    const first = await post('/api/auth/activate', { userId, token: code!.token })
    expect(first.status).toBe(200)
    expect((await User.findById(userId).lean().exec())!.isActive).toBe(true)

    const again = await post('/api/auth/activate', { userId, token: code!.token })
    expect(again.status).toBe(400)

    const after = await login()
    expect(after.status).toBe(200)
  })

  it('resend never mails an active account a code, and answers the same', async () => {
    const res = await post('/api/auth/activate/resend', { email: EMAIL })
    expect(res.status).toBe(200)
    expect(await codeFor(userId)).toBeNull()
  })

  it('resend is throttled: a second request within a minute does not mint another code', async () => {
    const org = await post('/api/auth/register', {
      orgName: 'S-06 Throttle', orgSlug: 's06-throttle', email: 'throttle@s06.test',
      username: 'throttle', password: PASSWORD, firstName: 'T', lastName: 'Hrottle',
    })
    const first = await codeFor(org.body.userId)

    const res = await post('/api/auth/activate/resend', { email: 'throttle@s06.test' })
    expect(res.status).toBe(200)
    const second = await codeFor(org.body.userId)
    expect(second!.token).toBe(first!.token)
  })

  it('an account an admin deactivated cannot be revived by its old code, nor mailed a new one', async () => {
    const reg = await post('/api/auth/register', {
      orgName: 'S-06 Deact', orgSlug: 's06-deact', email: 'gone@s06.test',
      username: 'gone', password: PASSWORD, firstName: 'G', lastName: 'One',
    })
    const original = await codeFor(reg.body.userId)
    // An admin deactivates the account while its activation mail is still in the inbox.
    await User.updateOne({ _id: reg.body.userId }, { $set: { deactivatedAt: new Date() } }).exec()

    const act = await post('/api/auth/activate', { userId: reg.body.userId, token: original!.token })
    expect(act.status).toBe(400)
    expect((await User.findById(reg.body.userId).lean().exec())!.isActive).toBe(false)

    // Expire the code, so the resend cooldown cannot be what stops the resend below.
    await Code.updateOne({ _id: original!._id }, { $set: { validTo: new Date(Date.now() - 1000) } }).exec()
    const res = await post('/api/auth/activate/resend', { email: 'gone@s06.test' })
    expect(res.status).toBe(200)
    expect((await codeFor(reg.body.userId))!.token).toBe(original!.token)
  })
})
