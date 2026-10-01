import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import {
  createLoginHandoff,
  redeemLoginHandoff,
  HandoffError,
  HANDOFF_REFUSED,
} from 'services/biz/oauth.service'
import { OAuthHandoff, User } from 'db/models'
import { isPublicRoute } from 'services/biz/public-routes'

/**
 * The OAuth sign-in handoff.
 *
 * The callback used to finish with `…/auth/oauth-callback?token=<JWT>` and the view stored
 * whatever `?token=` it was handed. So an attacker who started their own OAuth flow and sent the
 * victim that URL signed the victim into the attacker's account and org. FR-14.24 gated that
 * pattern everywhere except this route, which had to be exempted because `token` meant something
 * else there.
 *
 * ⚠ These use `captureRejection`, never `.rejects` — one `.rejects` reaps the shared mongod on
 * Windows and cascades every later file into ECONNREFUSED (CLAUDE.md).
 */

let payload: any

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

/** A real user, so the claims stored in the handoff are the claims a callback would store. */
async function seedUser() {
  const { org, user } = await register({
    orgName: 'Handoff Corp',
    orgSlug: 'handoff-corp',
    email: 'admin@handoff.test',
    username: 'admin',
    password: 'test123',
    firstName: 'Ada',
    lastName: 'Admin',
  })
  // ⚠ S-20 — `redeemLoginHandoff` now re-checks the account is still live, and `register` creates
  // users INACTIVE (they activate by email). A handoff is only ever minted after `getOrCreateUser`
  // has already refused an inactive account, so an active user is what this helper must model.
  await User.updateOne({ _id: (user as any)._id }, { $set: { isActive: true } })
  payload = {
    id: String((user as any)._id),
    email: 'admin@handoff.test',
    username: 'admin',
    firstName: 'Ada',
    lastName: 'Admin',
    role: (user as any).role,
    orgId: String((org as any)._id),
    permissions: ['admin.settings'],
    ownRecordsModules: [],
  }
  return payload
}

describe('OAuth handoff — the happy path', () => {
  it('redeems once and returns the claims the callback stored, plus the org', async () => {
    const p = await seedUser()
    const code = await createLoginHandoff(p)

    const { user, org } = await redeemLoginHandoff(code)

    expect(user.id).toBe(p.id)
    expect(user.email).toBe(p.email)
    expect(user.permissions).toEqual(p.permissions)
    expect(String(org._id)).toBe(p.orgId)
    expect(org.slug).toBe('handoff-corp')
  })

  it('stores the code HASHED — a dump of the collection yields nothing redeemable', async () => {
    const p = await seedUser()
    const code = await createLoginHandoff(p)

    const row = await OAuthHandoff.findOne({}).lean()
    expect(row).toBeTruthy()
    expect((row as any).codeHash).not.toBe(code)
    expect((row as any).codeHash).toMatch(/^[0-9a-f]{64}$/)
    // And nothing anywhere in the document equals the code.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('stores CLAIMS, never a signed token — no bearer credential sits at rest', async () => {
    const p = await seedUser()
    await createLoginHandoff(p)

    const row: any = await OAuthHandoff.findOne({}).lean()
    // A JWT is three dot-separated base64url segments. Nothing stored may look like one.
    expect(JSON.stringify(row.payload)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/)
    expect(row.payload.email).toBe(p.email)
  })

  it('mints a code long enough to be a bearer credential', async () => {
    const p = await seedUser()
    const code = await createLoginHandoff(p)
    // 32 random bytes, base64url → 43 characters, no padding.
    expect(code.length).toBeGreaterThanOrEqual(43)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('OAuth handoff — what cannot be redeemed', () => {
  it('refuses a second redemption of the same code', async () => {
    const p = await seedUser()
    const code = await createLoginHandoff(p)
    await redeemLoginHandoff(code)

    const err = await captureRejection(redeemLoginHandoff(code))
    expect(err).toBeInstanceOf(HandoffError)
    expect((err as Error).message).toBe(HANDOFF_REFUSED)
  })

  it('lets exactly ONE of two simultaneous redemptions win', async () => {
    // ⚠ This is why single use is a conditional update and not read-then-write: both of these
    // would pass a read.
    const p = await seedUser()
    const code = await createLoginHandoff(p)

    const results = await Promise.allSettled([redeemLoginHandoff(code), redeemLoginHandoff(code)])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
  })

  it('refuses an expired code', async () => {
    const p = await seedUser()
    const code = await createLoginHandoff(p)
    // The TTL index is a floor that Mongo sweeps about once a minute, so the expiry check has to
    // be the date comparison in the code — which is what this asserts.
    await OAuthHandoff.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const err = await captureRejection(redeemLoginHandoff(code))
    expect((err as Error).message).toBe(HANDOFF_REFUSED)
  })

  it('refuses an unknown code', async () => {
    await seedUser()
    const err = await captureRejection(redeemLoginHandoff('definitely-not-a-real-code'))
    expect((err as Error).message).toBe(HANDOFF_REFUSED)
  })

  it('refuses a missing or non-string code without touching the database', async () => {
    for (const bad of [undefined, null, '', 123, {}, []] as unknown[]) {
      const err = await captureRejection(redeemLoginHandoff(bad))
      expect((err as Error).message).toBe(HANDOFF_REFUSED)
    }
  })

  it('gives the SAME message for unknown, expired and used — it is not an oracle', async () => {
    const p = await seedUser()

    const used = await createLoginHandoff(p)
    await redeemLoginHandoff(used)
    const expired = await createLoginHandoff(p)
    await OAuthHandoff.updateOne(
      { _id: (await OAuthHandoff.findOne({ usedAt: null }).lean())!._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    )

    const messages = await Promise.all(
      [used, expired, 'never-existed'].map(async c =>
        (await captureRejection(redeemLoginHandoff(c)) as Error).message,
      ),
    )
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toBe(HANDOFF_REFUSED)
  })
})

describe('OAuth handoff — the route table', () => {
  it('exposes the redeem endpoint publicly, because it is what produces the token', () => {
    expect(isPublicRoute('POST', '/api/auth/oauth-code/redeem')).toBe(true)
  })

  it('does not expose it under any other method', () => {
    expect(isPublicRoute('GET', '/api/auth/oauth-code/redeem')).toBe(false)
  })
})
