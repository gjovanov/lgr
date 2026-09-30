import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { makeDesktopStub, enrollBody } from '../helpers/desktop-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { AuditLog, Desktop, DesktopEnrollmentCode } from 'db/models'

/**
 * The endpoints the Desktops page drives (FR-14.23), over the real route table.
 *
 * C06's suites cover the service layer and the auth boundary. These are the flows the PAGE adds:
 * the register dialog's mint → poll → close cycle, rename/assign, update-all, and the audit trail
 * every action must leave. The page itself is asserted in the e2e project (C15).
 *
 * ⚠ No `.rejects` / `.resolves` (CLAUDE.md).
 */

let app: any
const userSigner = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

beforeAll(async () => {
  await setupTestDB()
  app = createApiApp()
})
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

async function seed() {
  const org = await createTestOrg()
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const orgId = String(org._id)
  const token: string = await userSigner.sign({
    id: String(admin._id), email: admin.email, username: admin.username,
    firstName: admin.firstName, lastName: admin.lastName, role: 'admin',
    orgId, permissions: [...(admin.permissions as any)],
  })
  return { orgId, token, adminId: String(admin._id), org }
}

const call = (path: string, token: string, init: RequestInit = {}) =>
  app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  }))

const json = async (res: Response) => res.json() as any

describe('the register dialog flow', () => {
  it('mints a code whose state the dialog can poll until it closes itself', async () => {
    const { orgId, token } = await seed()

    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(minted.deepLink).toContain('lgr://enroll?server=')
    expect(new Date(minted.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // Before the desktop uses it, the dialog keeps counting down.
    const before = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes/${minted.id}`, token))
    expect(before.state).toBe('unused')

    // The machine enrolls, anonymously, with the code.
    const stub = makeDesktopStub()
    const enrollRes = await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(stub, { name: 'Till-2' }), code: minted.code }),
    }))
    expect(enrollRes.status).toBe(200)

    // ⚠ This is what lets the dialog close itself and say "Till-2 registered" rather than making
    // the admin guess whether it worked.
    const after = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes/${minted.id}`, token))
    expect(after.state).toBe('used')
    expect(after.usedBy).toBe('Till-2')
  })

  it('reports an expired code as expired, not as missing', async () => {
    // ⚠ Why the code row is kept for an hour past expiry: "expired" is an actionable message,
    // "no such code" makes an admin wonder whether they misread it.
    const { orgId, token } = await seed()
    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    await DesktopEnrollmentCode.updateOne({ _id: minted.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const state = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes/${minted.id}`, token))
    expect(state.state).toBe('expired')
  })

  it('never returns the code again after minting it', async () => {
    const { orgId, token } = await seed()
    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    const state = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes/${minted.id}`, token))
    // Shown once. Minting another is the recovery, which is what makes single use meaningful.
    expect(JSON.stringify(state)).not.toContain(minted.code.replace('-', ''))
  })

  it('refuses to read another org\'s code', async () => {
    const a = await seed()
    const b = await seed()
    const minted = await json(await call(`/api/org/${a.orgId}/desktops/enrollment-codes`, a.token, { method: 'POST' }))
    // Same org in the path as the token, but the code belongs to A: scoped by orgId, so 404.
    const res = await call(`/api/org/${b.orgId}/desktops/enrollment-codes/${minted.id}`, b.token)
    expect(res.status).toBe(404)
  })
})

describe('rename and assign', () => {
  async function enrolledDesktop(orgId: string, token: string) {
    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    const res = await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
    }))
    return (await json(res)).desktopId as string
  }

  it('sets the start path and the bridgeable devices, and marks the name admin-set', async () => {
    const { orgId, token, org } = await seed()
    const id = await enrolledDesktop(orgId, token)
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id)

    const res = await call(`/api/org/${orgId}/desktops/${id}`, token, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Front till', startPath: '/pos/', fiscalDeviceIds: [String(device._id)] }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.desktop.name).toBe('Front till')
    expect(body.desktop.startPath).toBe('/pos/')
    expect(body.desktop.fiscalDeviceIds).toEqual([String(device._id)])

    // ⚠ From now on the desktop's own reported name loses, including across re-enrollment.
    expect((await Desktop.findById(id).lean() as any).nameAdminSet).toBe(true)
  })

  it('rejects a start path that is not a path', async () => {
    // ⚠ `startPath` ends up in a URL the shell navigates to. FR-14.12's validation lives in the
    // shell, but the stored value is validated here too — a `//evil.example` in the database would
    // be a stored redirect waiting for a shell that trusts it.
    const { orgId, token } = await seed()
    const id = await enrolledDesktop(orgId, token)
    for (const bad of ['//evil.example', 'https://evil.example', 'pos', '/pos/?token=x', '/pos/#f']) {
      const res = await call(`/api/org/${orgId}/desktops/${id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ startPath: bad }),
      })
      expect(res.status).toBe(422)
    }
  })

  it('clears the start path with an empty string', async () => {
    const { orgId, token } = await seed()
    const id = await enrolledDesktop(orgId, token)
    await call(`/api/org/${orgId}/desktops/${id}`, token, { method: 'PUT', body: JSON.stringify({ startPath: '/pos/' }) })
    const res = await call(`/api/org/${orgId}/desktops/${id}`, token, { method: 'PUT', body: JSON.stringify({ startPath: '' }) })
    expect(res.status).toBe(200)
    expect((await json(res)).desktop.startPath).toBeUndefined()
  })
})

describe('update requests', () => {
  it('reports honestly that an offline desktop was not reached', async () => {
    const { orgId, token } = await seed()
    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    const enrolled = await json(await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
    })))

    const res = await call(`/api/org/${orgId}/desktops/${enrolled.desktopId}/update`, token, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await json(res)
    // ⚠ `delivered: false` is not an error — a till that is switched off checks on its next start.
    // Reporting a failure would invite someone to keep clicking.
    expect(body.ok).toBe(true)
    expect(body.delivered).toBe(false)
  })

  it('update-all counts what it asked and what it reached', async () => {
    const { orgId, token } = await seed()
    for (let i = 0; i < 2; i++) {
      const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
      await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
      }))
    }
    const body = await json(await call(`/api/org/${orgId}/desktops/update-all`, token, { method: 'POST' }))
    expect(body.requested).toBe(2)
    expect(body.delivered).toBe(0)
  })

  it('does not count another org\'s desktops', async () => {
    const a = await seed()
    const b = await seed()
    const minted = await json(await call(`/api/org/${a.orgId}/desktops/enrollment-codes`, a.token, { method: 'POST' }))
    await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
    }))
    const body = await json(await call(`/api/org/${b.orgId}/desktops/update-all`, b.token, { method: 'POST' }))
    expect(body.requested).toBe(0)
  })
})

describe('the audit trail', () => {
  it('records every action the page can take, and never the code itself', async () => {
    const { orgId, token } = await seed()

    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    const enrolled = await json(await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
    })))
    const id = enrolled.desktopId

    await call(`/api/org/${orgId}/desktops/${id}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Renamed' }) })
    await call(`/api/org/${orgId}/desktops/${id}/rotate-key`, token, { method: 'POST' })
    await call(`/api/org/${orgId}/desktops/${id}/update`, token, { method: 'POST' })
    await call(`/api/org/${orgId}/desktops/${id}/revoke`, token, { method: 'POST', body: JSON.stringify({ reason: 'test' }) })

    // `createAuditEntry` is fire-and-forget, so give it a tick to land.
    await Bun.sleep(150)
    const entries = await AuditLog.find({ orgId, entityType: 'desktop' }).lean()
    expect(entries.length).toBeGreaterThanOrEqual(5) // mint + rename + rotate + update + revoke

    // ⚠ An audit trail readable by every `admin.audit` holder must not contain live credentials.
    const dump = JSON.stringify(entries)
    expect(dump).not.toContain(minted.code.replace('-', ''))
    expect(dump).not.toContain(minted.code)
  })
})

describe('what the list gives the page', () => {
  it('returns presence, the named key, and no public key', async () => {
    const { orgId, token } = await seed()
    const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
    await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...enrollBody(makeDesktopStub()), code: minted.code }),
    }))

    const body = await json(await call(`/api/org/${orgId}/desktops`, token))
    expect(Array.isArray(body.desktops)).toBe(true)
    expect(body.total).toBe(1)
    const d = body.desktops[0]
    expect(['online', 'stale', 'offline']).toContain(d.presence)
    expect(d.keyEpoch).toBe(1)
    expect(JSON.stringify(body)).not.toContain('publicKey')
  })

  it('searches by name and hostname', async () => {
    const { orgId, token } = await seed()
    for (const name of ['Front till', 'Back office']) {
      const minted = await json(await call(`/api/org/${orgId}/desktops/enrollment-codes`, token, { method: 'POST' }))
      await app.handle(new Request('http://localhost/api/desktop/v1/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...enrollBody(makeDesktopStub(), { name }), code: minted.code }),
      }))
    }
    const hit = await json(await call(`/api/org/${orgId}/desktops?search=front`, token))
    expect(hit.desktops).toHaveLength(1)
    expect(hit.desktops[0].name).toBe('Front till')
  })

  it('does not let a regex in the search term break the query', async () => {
    // A user typing `(` into a search box must not produce a 500.
    const { orgId, token } = await seed()
    for (const term of ['(', '[', '.*', '\\', '$']) {
      const res = await call(`/api/org/${orgId}/desktops?search=${encodeURIComponent(term)}`, token)
      expect(res.status).toBe(200)
    }
  })
})
