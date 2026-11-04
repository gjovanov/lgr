import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { ROLES } from 'config/constants'
import { Identity, Invite, Org } from 'db/models'
import { sessionFor } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'

/**
 * #510: inviting a user, over the real route table. An email invite used to store the address and
 * mail nothing; a blank address made an open link; any role string was stored.
 *
 * `fetch` is stubbed for SendGrid: nothing leaves the machine.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const realFetch = globalThis.fetch
const realKey = config.email.sendgridApiKey

let app: any
let orgId: string
let token: string
let mails: Array<{ to: string; subject: string; html: string }> = []

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** SendGrid answers `ok`; every mail it is handed is recorded. */
function mailWorks(ok = true) {
  ;(config.email as any).sendgridApiKey = 'SG.test-key'
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('sendgrid')) {
      const body = JSON.parse(init.body)
      mails.push({ to: body.personalizations[0].to[0].email, subject: body.subject, html: body.content[0].value })
    }
    return { ok, status: ok ? 202 : 400, text: async () => '' } as any
  }) as any
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  const org = await createTestOrg({ name: 'Acme Invites' } as any)
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  const identity = await Identity.create({ email: 'boss@invite.test', firstName: 'Ana', lastName: 'Boss', isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
  const admin = await createTestUser(org._id, { role: 'admin', email: 'boss@invite.test', firstName: 'Ana', lastName: 'Boss', identityId: identity._id } as any)
  token = await (signer as any).decorator.jwt.sign(await sessionFor(admin, identity))
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(() => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = realKey
  mails = []
})

describe('an email invite is mailed (#510)', () => {
  it('mails the link to the address, and answers the link and that it went out', async () => {
    mailWorks()
    const r = await call('POST', '/invite', { targetEmail: ' New.Person@Invite.test ', assignRole: 'sales' })
    expect(r.status).toBe(200)
    const code = r.json.invite.code
    expect(r.json.invite.targetEmail).toBe('new.person@invite.test')
    expect(r.json.link).toBe(`${config.email.appUrl}/invite/${code}`)
    expect(r.json.email).toEqual({ sent: true })

    expect(mails).toHaveLength(1)
    expect(mails[0].to).toBe('new.person@invite.test')
    expect(mails[0].subject).toBe('Ana Boss invited you to Acme Invites on LGR')
    expect(mails[0].html).toContain(`/invite/${code}`)
  })

  it("in the org's language, with the expiry", async () => {
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.locale': 'bg' } })
    try {
      mailWorks()
      const r = await call('POST', '/invite', { targetEmail: 'bg@invite.test', expiresInHours: 48 })
      expect(r.status).toBe(200)
      expect(mails[0].subject).toBe('Ana Boss ви покани в Acme Invites в LGR')
      expect(mails[0].html).toContain('Поканата изтича на')
    } finally {
      await Org.updateOne({ _id: orgId }, { $set: { 'settings.locale': 'en' } })
    }
  })

  it('a mail that does not go out still makes the invite, and says why', async () => {
    ;(config.email as any).sendgridApiKey = ''
    const unset = await call('POST', '/invite', { targetEmail: 'nokey@invite.test' })
    expect(unset.status).toBe(200)
    expect(unset.json.email).toEqual({ sent: false, reason: 'not_configured' })
    expect(unset.json.link).toContain(`/invite/${unset.json.invite.code}`)

    mailWorks(false)
    const refused = await call('POST', '/invite', { targetEmail: 'refused@invite.test' })
    expect(refused.status).toBe(200)
    expect(refused.json.email).toEqual({ sent: false, reason: 'provider_error' })
    expect(await Invite.countDocuments({ orgId, targetEmail: { $in: ['nokey@invite.test', 'refused@invite.test'] } })).toBe(2)
  })

  it('a shareable link mails nothing and answers its link', async () => {
    mailWorks()
    const r = await call('POST', '/invite', { maxUses: 3 })
    expect(r.status).toBe(200)
    expect(r.json.email).toBeUndefined()
    expect(r.json.link).toContain(`/invite/${r.json.invite.code}`)
    expect(mails).toHaveLength(0)
  })
})

describe('what an invite may name (#510)', () => {
  it('a blank or malformed address is refused, never stored as an open link', async () => {
    for (const targetEmail of ['', '   ', 'not-an-address', 'a@b']) {
      const before = await Invite.countDocuments({ orgId })
      const r = await call('POST', '/invite', { targetEmail })
      expect({ targetEmail, status: r.status, code: r.json?.code }).toEqual({ targetEmail, status: 422, code: 'invalid_email' })
      expect(await Invite.countDocuments({ orgId })).toBe(before)
    }
  })

  it('a role outside ROLES is refused; every role in it is accepted', async () => {
    const bad = await call('POST', '/invite', { assignRole: 'nonsense' })
    expect(bad.status).toBe(422)
    expect(bad.json.code).toBe('invalid_role')
    for (const role of ROLES) {
      const r = await call('POST', '/invite', { assignRole: role })
      expect({ role, status: r.status }).toEqual({ role, status: 200 })
      expect(r.json.invite.assignRole).toBe(role)
    }
    // No role means member, as before.
    expect((await call('POST', '/invite', {})).json.invite.assignRole).toBe('member')
  })
})
