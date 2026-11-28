import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { runMigrations, checksumOf, COLLECTION } from 'migrations/runner'
import { CONTRACT, MIGRATIONS, RELEASED } from 'migrations/registry'
import { forgetStartMigrations, migrateAtStart, releaseHeld, releaseSettled, startMigrationsHealth, startModeFromEnv } from 'migrations/start'
import type { Migration } from 'migrations/types'
import { startControlSocket } from '../../../api/src/front/control-socket'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * #980 (FR-20.20): a master's update is a start the update helper watches, and goes back from to the
 * version before if it fails. That version then meets the data as the new one left it, and a master
 * skips releases. So while the start is watched, the steps that remove what an older release reads
 * (`CONTRACT`) are held, and they run once the supervisor has seen the update confirmed and releases
 * them. A step that a failed version applied is applied again by the next update, because the version
 * gone back to has written in the old shape since.
 *
 * The supervisor's word is the API's environment (`config.rs#update_env`, `migration_hold.rs`): the
 * names here are the ones the Rust side writes, and its tests pin the same.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  await releaseSettled()
  forgetStartMigrations()
  await clearCollections()
})

const db = () => mongoose.connection.db!
const recorded = async () => (await db().collection(COLLECTION).find({ _id: { $ne: '__lock__' as any } }).sort({ _id: 1 }).toArray()).map(r => String(r._id))
const lock = () => db().collection(COLLECTION).findOne({ _id: '__lock__' as any })

/** A migration that counts its runs. */
function counting(id: string, sink: string[], extra: Partial<Migration> = {}): Migration {
  return { id, description: `test ${id}`, async up() { sink.push(id) }, ...extra }
}

/** What a master's supervisor puts in the API's environment. */
const watched = { LGR_SERVER_VERSION: '0.1.14', LGR_MIGRATIONS_CONTRACT: 'hold' }
const confirmed = { LGR_SERVER_VERSION: '0.1.14', LGR_MIGRATIONS_CONTRACT: 'try' }

describe('#980: the runner and the contract steps', () => {
  it('hold: the contract steps wait and the rest run; a later run applies them in order', async () => {
    const ran: string[] = []
    const migrations = [
      counting('0001-a', ran), counting('0002-drop', ran, { contract: true }), counting('0003-b', ran), counting('0004-drop', ran, { contract: true }),
    ]
    const held = await runMigrations({ db: db(), migrations, contract: 'hold' })
    expect(held.applied).toEqual(['0001-a', '0003-b'])
    expect(held.held).toEqual(['0002-drop', '0004-drop'])
    expect(await recorded()).toEqual(['0001-a', '0003-b'])
    expect(await lock()).toBeNull()

    const later = await runMigrations({ db: db(), migrations, contract: 'try' })
    expect(later.applied).toEqual(['0002-drop', '0004-drop'])
    expect(later.alreadyApplied).toEqual(['0001-a', '0003-b'])
    expect(later.held).toEqual([])
    expect(ran).toEqual(['0001-a', '0003-b', '0002-drop', '0004-drop'])
  })

  it('try: a contract step that fails waits with the contract steps after it, the others go on, and nothing throws', async () => {
    const ran: string[] = []
    let full = true
    const drop: Migration = {
      id: '0002-drop', description: 'drop', contract: true,
      async up() { if (full) throw new Error('the disk is full'); ran.push('0002-drop') },
    }
    const migrations = [counting('0001-a', ran), drop, counting('0003-b', ran), counting('0004-drop', ran, { contract: true })]
    const res = await runMigrations({ db: db(), migrations, contract: 'try' })
    expect(res.applied).toEqual(['0001-a', '0003-b'])
    expect(res.held).toEqual(['0002-drop', '0004-drop'])
    expect(res.deferred).toEqual([{ id: '0002-drop', error: 'the disk is full' }])
    expect(await recorded()).toEqual(['0001-a', '0003-b'])
    expect(await lock()).toBeNull()

    full = false
    const later = await runMigrations({ db: db(), migrations, contract: 'try' })
    expect(later.applied).toEqual(['0002-drop', '0004-drop'])
    expect(later.deferred).toEqual([])
  })

  it('apply, the default (bun run migrate, lgrai.app): a contract step that fails stops the run like any other', async () => {
    const ran: string[] = []
    const migrations = [
      counting('0001-a', ran),
      { id: '0002-drop', description: 'drop', contract: true, async up() { throw new Error('boom') } },
      counting('0003-b', ran),
    ]
    const err = await captureRejection(runMigrations({ db: db(), migrations }))
    expect((err as Error).message).toBe('boom')
    expect(ran).toEqual(['0001-a'])
  })

  it('a step that is not a contract step still stops the run when it fails, held or tried', async () => {
    for (const contract of ['hold', 'try'] as const) {
      const ran: string[] = []
      const migrations = [counting('0001-a', ran), { id: '0002-boom', description: 'fails', async up() { throw new Error(`boom ${contract}`) } }]
      const err = await captureRejection(runMigrations({ db: db(), migrations, contract }))
      expect((err as Error).message).toBe(`boom ${contract}`)
      await clearCollections()
    }
  })

  it('a step a version that failed its confirmation applied is applied again, once, and keeps its earlier run', async () => {
    const ran: string[] = []
    const all = [counting('0001-a', ran), counting('0002-b', ran), counting('0003-c', ran), counting('0004-d', ran)]
    // 0.1.12 applied 0001; the update to 0.1.14 applied 0002 and 0003, failed, and went back to 0.1.12.
    await runMigrations({ db: db(), migrations: all.slice(0, 1), appVersion: '0.1.12' })
    await runMigrations({ db: db(), migrations: all.slice(0, 3), appVersion: '0.1.14' })
    const before = await db().collection(COLLECTION).findOne({ _id: '0002-b' as any }) as any

    ran.length = 0
    const next = await runMigrations({ db: db(), migrations: all, appVersion: '0.1.15', failedVersions: ['0.1.14'] })
    expect(next.applied).toEqual(['0002-b', '0003-c', '0004-d'])
    expect(next.reapplied).toEqual(['0002-b', '0003-c'])
    expect(next.alreadyApplied).toEqual(['0001-a'])
    expect(ran).toEqual(['0002-b', '0003-c', '0004-d'])
    const rec = await db().collection(COLLECTION).findOne({ _id: '0002-b' as any }) as any
    expect(rec.appVersion).toBe('0.1.15')
    expect(rec.checksum).toBe(checksumOf(all[1]))
    expect(rec.earlier).toEqual([{ appVersion: '0.1.14', appliedAt: before.appliedAt }])

    // Recorded under 0.1.15 now: not again.
    const once = await runMigrations({ db: db(), migrations: all, appVersion: '0.1.15', failedVersions: ['0.1.14'] })
    expect(once.applied).toEqual([])
  })

  it('a record that names no version (`dev`, every runner before 0.1.14) is never applied again', async () => {
    const ran: string[] = []
    await runMigrations({ db: db(), migrations: [counting('0001-a', ran)] })
    const next = await runMigrations({ db: db(), migrations: [counting('0001-a', ran)], appVersion: '0.1.15', failedVersions: ['dev', '0.1.13'] })
    expect(next.applied).toEqual([])
    expect(ran).toEqual(['0001-a'])
  })

  it('held while watched, a contract step a failed version applied keeps that record, and is applied again after the confirmation', async () => {
    const ran: string[] = []
    const migrations = [counting('0001-drop', ran, { contract: true }), counting('0002-b', ran)]
    await runMigrations({ db: db(), migrations, appVersion: '0.1.14' })
    ran.length = 0
    const held = await runMigrations({ db: db(), migrations, appVersion: '0.1.15', failedVersions: ['0.1.14'], contract: 'hold' })
    expect(held.held).toEqual(['0001-drop'])
    expect(held.reapplied).toEqual(['0002-b'])
    expect((await db().collection(COLLECTION).findOne({ _id: '0001-drop' as any }) as any).appVersion).toBe('0.1.14')
    const later = await runMigrations({ db: db(), migrations, appVersion: '0.1.15', failedVersions: ['0.1.14'], contract: 'try' })
    expect(later.reapplied).toEqual(['0001-drop'])
    expect(ran).toEqual(['0002-b', '0001-drop'])
  })
})

describe('#980: the registry', () => {
  it('names released steps only, and marks exactly those', () => {
    const released = new Set(RELEASED.map(m => m.id))
    for (const id of CONTRACT) expect({ id, released: released.has(id) }).toEqual({ id, released: true })
    expect(MIGRATIONS.filter(m => m.contract).map(m => m.id)).toEqual([...CONTRACT].sort())
  })

  it('the legacy access is given its roles before the archive, held or not, and the line totals are not held', () => {
    const ids = MIGRATIONS.map(m => m.id)
    expect(ids.indexOf('0016-roles-before-the-archive')).toBeLessThan(ids.indexOf('0017-legacy-access-archive'))
    expect(CONTRACT.has('0016-roles-before-the-archive')).toBe(false)
    // A change of meaning the new code reads at once: held, it would misread the data while watched.
    expect(CONTRACT.has('0023-imported-line-totals-gross')).toBe(false)
  })
})

describe('#980: what the supervisor says, as the API reads it', () => {
  it('nothing named (lgrai.app, a development server): the runner as it was', () => {
    expect(startModeFromEnv({})).toEqual({ contract: 'apply', failedVersions: [], version: undefined })
    expect(startModeFromEnv({ LGR_MIGRATIONS_CONTRACT: ' ', LGR_SERVER_VERSION: '' })).toEqual({ contract: 'apply', failedVersions: [], version: undefined })
  })

  it('hold or try, the version, and the versions that failed', () => {
    expect(startModeFromEnv(watched)).toEqual({ contract: 'hold', failedVersions: [], version: '0.1.14' })
    expect(startModeFromEnv({ ...confirmed, LGR_MIGRATIONS_FAILED_VERSIONS: '0.1.12, 0.1.13,,' }))
      .toEqual({ contract: 'try', failedVersions: ['0.1.12', '0.1.13'], version: '0.1.14' })
  })

  it('a word this version does not know holds, and is named', () => {
    expect(startModeFromEnv({ LGR_MIGRATIONS_CONTRACT: 'later' })).toEqual({ contract: 'hold', failedVersions: [], version: undefined, unknown: 'later' })
  })
})

describe('#980: a start', () => {
  const quiet = { log: () => {}, warn: () => {}, scope: async () => ({}) }

  it('watched: holds the contract steps until the supervisor releases them, and runs them once', async () => {
    const ran: string[] = []
    let runs = 0
    const migrations = [counting('0001-a', ran), { ...counting('0002-drop', ran, { contract: true }), async up() { runs++; ran.push('0002-drop') } }]
    const res = await migrateAtStart({ ...quiet, db: db(), migrations, env: watched })
    expect(res.held).toEqual(['0002-drop'])
    expect(startMigrationsHealth()).toMatchObject({ contract: 'hold', held: ['0002-drop'], heldBecause: 'confirmation', releasedAt: null })
    expect(ran).toEqual(['0001-a'])

    // The supervisor asks until the answer says released; a run under way is never started twice.
    expect(releaseHeld()).toEqual({ released: false, releasing: true, held: ['0002-drop'] })
    expect(releaseHeld()).toEqual({ released: false, releasing: true, held: ['0002-drop'] })
    await releaseSettled()
    expect(releaseHeld()).toEqual({ released: true, releasing: false, held: [] })
    expect(runs).toBe(1)
    expect(ran).toEqual(['0001-a', '0002-drop'])
    expect(startMigrationsHealth()).toMatchObject({ held: [], heldBecause: null })
    expect(startMigrationsHealth()?.releasedAt).toBeTruthy()
    const rec = await db().collection(COLLECTION).findOne({ _id: '0002-drop' as any }) as any
    expect(rec.appVersion).toBe('0.1.14')
  })

  it('a release that cannot run yet is tried again when the supervisor asks again', async () => {
    const ran: string[] = []
    const warned: string[] = []
    let scopes = 0
    // The database went away under the release's first run.
    const scope = async () => { if (++scopes === 2) throw new Error('the database went away'); return {} }
    await migrateAtStart({ ...quiet, scope, warn: m => warned.push(m), db: db(), migrations: [counting('0001-drop', ran, { contract: true })], env: watched })
    releaseHeld()
    await releaseSettled()
    expect(warned.join('\n')).toMatch(/could not run yet/)
    expect(startMigrationsHealth()).toMatchObject({ held: ['0001-drop'], heldBecause: 'confirmation' })
    expect(releaseHeld().released).toBe(false)
    await releaseSettled()
    expect(releaseHeld()).toEqual({ released: true, releasing: false, held: [] })
    expect(ran).toEqual(['0001-drop'])
  })

  it('a contract step that fails in the release waits for a later start, and the supervisor stops asking', async () => {
    const warned: string[] = []
    const migrations = [{ id: '0001-drop', description: 'drop', contract: true, async up() { throw new Error('the disk is full') } }]
    await migrateAtStart({ ...quiet, warn: m => warned.push(m), db: db(), migrations, env: watched })
    releaseHeld()
    await releaseSettled()
    expect(releaseHeld()).toEqual({ released: true, releasing: false, held: ['0001-drop'] })
    expect(startMigrationsHealth()).toMatchObject({ held: ['0001-drop'], heldBecause: 'failed', deferred: [{ id: '0001-drop', error: 'the disk is full' }] })
    expect(warned.join('\n')).toMatch(/0001-drop failed/)
  })

  it('a master\'s start that is not watched: a contract step that fails waits, says so, and the start goes on', async () => {
    const ran: string[] = []
    const warned: string[] = []
    const migrations = [{ id: '0001-drop', description: 'drop', contract: true, async up() { throw new Error('the disk is full') } }, counting('0002-b', ran)]
    const res = await migrateAtStart({ ...quiet, db: db(), migrations, warn: m => warned.push(m), env: confirmed })
    expect(res.applied).toEqual(['0002-b'])
    expect(startMigrationsHealth()).toMatchObject({ contract: 'try', held: ['0001-drop'], heldBecause: 'failed', deferred: [{ id: '0001-drop', error: 'the disk is full' }] })
    expect(warned.join('\n')).toMatch(/0001-drop failed/)
    // Nothing waits for a confirmation: a release answers at once, and runs nothing.
    expect(releaseHeld()).toEqual({ released: true, releasing: false, held: ['0001-drop'] })
  })

  it('every start applies again what a version that failed applied, as the supervisor names them', async () => {
    const ran: string[] = []
    const migrations = [counting('0001-a', ran)]
    await runMigrations({ db: db(), migrations, appVersion: '0.1.13' })
    await migrateAtStart({ ...quiet, db: db(), migrations, env: { ...confirmed, LGR_MIGRATIONS_FAILED_VERSIONS: '0.1.13' } })
    expect(startMigrationsHealth()).toMatchObject({ reapplied: ['0001-a'], failedVersions: ['0.1.13'] })
    expect(ran).toEqual(['0001-a', '0001-a'])
  })

  it('a word the API does not know holds, and says so', async () => {
    const ran: string[] = []
    const warned: string[] = []
    await migrateAtStart({ ...quiet, warn: m => warned.push(m), db: db(), migrations: [counting('0001-drop', ran, { contract: true })], env: { LGR_MIGRATIONS_CONTRACT: 'later' } })
    expect(ran).toEqual([])
    expect(warned.join('\n')).toMatch(/"later"/)
  })

  it('off a master it is the runner as it was: a contract step that fails stops the start', async () => {
    const migrations = [{ id: '0001-drop', description: 'drop', contract: true, async up() { throw new Error('boom') } }]
    const err = await captureRejection(migrateAtStart({ ...quiet, db: db(), migrations, env: {} }))
    expect((err as Error).message).toBe('boom')
  })
})

describe('#980: the release on the control socket', () => {
  const SECRET = 'migrations-release-secret'
  let dir: string
  let socket: string
  let ctl: { close: () => void }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lgr-release-'))
    socket = join(dir, 'api.sock')
    ctl = startControlSocket(socket, SECRET, {
      status: () => ({ ok: true }),
      stop: () => {},
      migrations: { release: async () => ({ ...releaseHeld() }) },
    })
  })

  afterAll(() => {
    ctl.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** The supervisor's request (`migration_hold.rs`, through `control.rs`), and everything it got back. */
  const post = (path: string, secret = SECRET) =>
    new Promise<string>(resolve => {
      let raw = ''
      const s = connect(socket, () =>
        s.write(`POST ${path} HTTP/1.1\r\nHost: lgr-api\r\nx-lgr-front: ${secret}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),
      )
      s.on('data', d => { raw += d.toString() })
      s.on('close', () => resolve(raw))
      s.on('error', () => resolve(raw))
    })
  const body = (raw: string) => JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))

  it('answers with the release, and only to the front secret', async () => {
    const ran: string[] = []
    await migrateAtStart({ log: () => {}, warn: () => {}, scope: async () => ({}), db: db(), migrations: [counting('0001-drop', ran, { contract: true })], env: watched })
    expect((await post('/migrations/release', 'wrong')).split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden')
    expect(ran).toEqual([])

    const first = await post('/migrations/release')
    expect(first.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(body(first)).toEqual({ released: false, releasing: true, held: ['0001-drop'] })
    await releaseSettled()
    expect(body(await post('/migrations/release'))).toEqual({ released: true, releasing: false, held: [] })
    expect(ran).toEqual(['0001-drop'])
  })
})

describe('#980: from 0.1.12, watched, with the real registry', () => {
  /** What 0.1.12 had applied, as it recorded it (`dev`). */
  async function as0112() {
    const upTo = MIGRATIONS.findIndex(m => m.id === '0015-roles-from-sets')
    await db().collection(COLLECTION).insertMany(MIGRATIONS.slice(0, upTo + 1).map(m => ({
      _id: m.id as any, description: m.description, appliedAt: new Date(), durationMs: 1, appVersion: 'dev', checksum: checksumOf(m),
    })))
  }

  it('keeps what 0.1.12 reads until the update is confirmed, then contracts', async () => {
    await as0112()
    const org = await createTestOrg({ slug: 'watched-update' } as any)
    const admin = await createTestUser(org._id, { email: 'founder@watched.test', username: 'founder-watched', role: 'admin' } as any)
    await db().collection('users').updateOne({ _id: admin._id }, { $unset: { roleId: 1 } })
    await db().collection('products').createIndex({ name: 'text' }, { name: 'name_text' })
    const textIndex = async () => (await db().collection('products').indexes()).some((i: any) => i.key?._fts === 'text')
    const person = () => db().collection('users').findOne({ _id: admin._id }) as Promise<any>

    const res = await migrateAtStart({ db: db(), scope: async () => ({}), log: () => {}, warn: () => {}, env: watched })
    expect(res.held).toEqual([...CONTRACT].sort())
    // What 0.1.12 reads is there while the update is watched: the person's legacy access, the index it declares.
    expect((await person()).role).toBe('admin')
    expect(await textIndex()).toBe(true)
    // And the expand steps ran: the person has the role 0.1.12 serves an org on `roles` by (#979).
    expect((await person()).roleId).toBeTruthy()
    expect(await recorded()).not.toContain('0017-legacy-access-archive')

    // The supervisor saw the update confirmed.
    releaseHeld()
    await releaseSettled()
    expect(releaseHeld()).toEqual({ released: true, releasing: false, held: [] })
    const after = await person()
    expect(after.role).toBeUndefined()
    expect(after.legacyArchive).toBeUndefined()
    expect(await textIndex()).toBe(false)
    expect(await recorded()).toEqual(MIGRATIONS.map(m => m.id).sort())
  }, 60_000)
})
