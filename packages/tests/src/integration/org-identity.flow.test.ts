import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { orgController } from '../../../portal-api/src/controllers/org.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Org } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { MAX_ACTIVITY_CODE_LENGTH, MAX_PLACE_OF_ISSUE_LENGTH, MAX_REPRESENTATIVE_LENGTH } from 'config/party-identity'

/**
 * FR-25a §3.7: the company's representative (МОЛ), place of issue and activity code, through `PUT /org/:orgId` as the
 * settings page sends them. Stored trimmed; one sent empty is cleared, so the company reads exactly like one that never
 * set it; one not sent keeps what is stored; each is bounded. Made-up values throughout.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let org: any
let token: string

async function put(body: Record<string, unknown>) {
  // As `unified.ts` mounts it: its error handler is what turns a refused body into the message a page shows.
  const res = await new Elysia().onError(spaErrorHandler({}) as any).use(orgController).handle(new Request(`http://localhost/org/${org._id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text }
}

const stored = async () => (await Org.findById(org._id).lean()) as any

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ name: 'Идентичност Тест', slug: 'org-identity-test' } as any)
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(org._id), role: 'admin', email: 'a@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the company\'s representative, place of issue and activity code', () => {
  it('save trimmed, and the org the page reads back carries them', async () => {
    const res = await put({ name: 'Идентичност Тест', representative: '  Лице Тестово ', placeOfIssue: ' гр. Пример ', activityCode: '47.52' })
    expect(res.status).toBe(200)
    expect(res.json.org).toMatchObject({ representative: 'Лице Тестово', placeOfIssue: 'гр. Пример', activityCode: '47.52' })
    expect(await stored()).toMatchObject({ representative: 'Лице Тестово', placeOfIssue: 'гр. Пример', activityCode: '47.52' })
  })

  it('a save that does not send them keeps them', async () => {
    expect((await put({ name: 'Идентичност Тест', taxNumber: '000000017' })).status).toBe(200)
    expect(await stored()).toMatchObject({ representative: 'Лице Тестово', placeOfIssue: 'гр. Пример', activityCode: '47.52', taxNumber: '000000017' })
  })

  it('one sent empty is cleared, not kept as an empty string, and the others stay', async () => {
    const res = await put({ name: 'Идентичност Тест', representative: '', placeOfIssue: '   ', activityCode: '47.52' })
    expect(res.status).toBe(200)
    const org = await stored()
    expect('representative' in org).toBe(false)
    expect('placeOfIssue' in org).toBe(false)
    expect(org.activityCode).toBe('47.52')
    expect('representative' in res.json.org).toBe(false)
    expect('placeOfIssue' in res.json.org).toBe(false)
  })

  it('clearing all three leaves an org exactly as one that never set them', async () => {
    expect((await put({ representative: '', placeOfIssue: '', activityCode: '' })).status).toBe(200)
    const org = await stored()
    for (const field of ['representative', 'placeOfIssue', 'activityCode']) expect(field in org).toBe(false)
    // and they can be set again
    expect((await put({ placeOfIssue: 'гр. Пример' })).status).toBe(200)
    expect((await stored()).placeOfIssue).toBe('гр. Пример')
  })
})

describe('their bounds', () => {
  it('each takes its longest value and refuses one longer, storing nothing', async () => {
    const before = await stored()
    expect((await put({ representative: 'Л'.repeat(MAX_REPRESENTATIVE_LENGTH) })).status).toBe(200)
    expect((await put({ placeOfIssue: 'П'.repeat(MAX_PLACE_OF_ISSUE_LENGTH) })).status).toBe(200)
    expect((await put({ activityCode: '4'.repeat(MAX_ACTIVITY_CODE_LENGTH) })).status).toBe(200)
    const atBound = await stored()

    expect((await put({ representative: 'Л'.repeat(MAX_REPRESENTATIVE_LENGTH + 1) })).status).toBe(422)
    expect((await put({ placeOfIssue: 'П'.repeat(MAX_PLACE_OF_ISSUE_LENGTH + 1) })).status).toBe(422)
    expect((await put({ activityCode: '4'.repeat(MAX_ACTIVITY_CODE_LENGTH + 1) })).status).toBe(422)
    expect(await stored()).toMatchObject({
      representative: atBound.representative, placeOfIssue: atBound.placeOfIssue, activityCode: atBound.activityCode,
    })
    expect(before.name).toBe(atBound.name)
  })

  it('an activity code is digits joined by dots, and a refused one says so', async () => {
    for (const ok of ['47', '47.5', '01.11.1']) expect((await put({ activityCode: ok })).status).toBe(200)
    for (const bad of ['47,52', 'G47.52', '47.', ' 47.52', '47 52']) {
      const res = await put({ activityCode: bad })
      expect(res.status).toBe(422)
      expect(res.text).toContain('activity code of digits joined by dots')
    }
    expect((await stored()).activityCode).toBe('01.11.1')
  })
})
