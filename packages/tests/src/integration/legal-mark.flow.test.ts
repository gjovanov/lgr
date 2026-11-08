import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { AuditLog, OrgHome, ReplOrg, Sequence } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { journalHwmTick } from 'services/biz/home/series-lock.service'
import { legalMarkFile, legalMarkOf, legalMarkTick } from 'services/biz/home/legal-mark.service'
import { recordLastNumbers, legalSeriesOf } from 'services/biz/move/promote.service'
import { generateUNP, getNextNumber, legalCounterKey } from 'services/biz/sequence.service'
import { localDisk } from 'services/biz/backup/backup-destinations.service'
import { captureOn } from 'services/biz/replication/engine'
import { numberingController } from '../../../portal-api/src/controllers/numbering.controller'

/**
 * A mark of the legal counters kept OUTSIDE the database (#549, FR-20.51, plan A.7.5): beside the
 * node token and copied to the backup drive. A database put back from outside the app locks legal
 * numbering, on an Air-gapped master too, whose journal mark sees nothing; a whole system disk put
 * back is caught by the drive's copy; the unlock resumes above the mark; and a person can lock it by
 * hand, the runbook's step for a revert nothing can see.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-legalmarktest0000'
const saved = {
  role: config.node.role,
  id: (config.node as any).id,
  tokenFile: config.outbox.tokenFile,
  upload: config.upload.dir,
  localPath: config.backup.localPath,
  sameAsData: localDisk.sameAsData,
}
let root = ''
let drive = ''
let n = 0
const year = new Date().getFullYear()
const SALES = `SALES_DOC|${year}`

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  root = mkdtempSync(join(tmpdir(), 'lgr-lm-'))
  ;(config.upload as any).dir = join(root, 'uploads')
  mkdirSync(join(root, 'uploads'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  ;(config.outbox as any).tokenFile = join(root, 'state', 'node-token.json')
  // No backup location unless a test plugs one in.
  ;(config.backup as any).localPath = ''
  drive = join(root, 'drive')
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  ;(config.upload as any).dir = saved.upload
  ;(config.backup as any).localPath = saved.localPath
  localDisk.sameAsData = saved.sameAsData
  forgetAllHomes()
  if (root) rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

/** A backup drive, plugged in: a folder the tests' `localDisk` says is another disk. */
function plugDrive() {
  mkdirSync(drive, { recursive: true })
  ;(config.backup as any).localPath = drive
  localDisk.sameAsData = async () => false
}
const driveCopy = () => join(drive, 'LGR', 'State', `legal-mark-${NODE}.json`)
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const markOf = (file: string, orgId: string, key = SALES) => read(file).orgs?.[orgId]?.[key]?.last

/** An org written on this master (active), its sales series at 120, and nothing captured: Air-gapped. */
async function homeHere(state = 'active') {
  const org = await createTestOrg({ slug: `legal-mark-${++n}` } as any)
  // Home here first: on a master, the write guard refuses an org's writes anywhere else.
  await OrgHome.collection.insertOne({ orgId: org._id, home: NODE, epoch: 1, state, since: new Date() } as any)
  forgetAllHomes()
  const admin = await createTestUser(org._id as any, { role: 'admin' } as any)
  await ReplOrg.collection.insertOne({ orgId: org._id, enabled: true, seq: 50, pages: [] } as any)
  await Sequence.collection.insertOne({ orgId: org._id, prefix: 'SALES_DOC', year, lastNumber: 120 } as any)
  forgetAllHomes()
  return { orgId: String(org._id), oid: org._id as any, admin, by: { id: String(admin._id) } }
}
/** The database put back from outside the app (raw, past every hook): the sales counter where a backup had it. */
const putBack = (oid: unknown, last: number) => Sequence.collection.updateOne({ orgId: oid, prefix: 'SALES_DOC', year } as any, { $set: { lastNumber: last } })
const frozen = async (oid: unknown) => ((await OrgHome.findOne({ orgId: oid }).lean()) as any)?.seriesFrozen
const all = async (orgId: string, last: number) => (await legalSeriesOf(orgId)).map(s => ({ ...s, last: s.prefix === 'SALES_DOC' ? last : s.last }))
async function issue(orgId: string, count: number) {
  for (let i = 0; i < count; i++) await getNextNumber(orgId, 'SALES_DOC')
}

describe('the legal counters\' mark, outside the database (#549)', () => {
  it('is written from the counters, rises as numbers are issued (sales documents, cash sales, УНП), and locks nothing', async () => {
    const s = await homeHere()
    const file = legalMarkFile()!
    expect(existsSync(file)).toBe(false)
    expect(await legalMarkTick()).toBe(0)
    expect(markOf(file, s.orgId)).toBe(120)
    expect(read(file).node).toBe(NODE)

    await issue(s.orgId, 3)
    await getNextNumber(s.orgId, 'CASH_SALE')
    expect(await generateUNP(s.orgId, 'AB123456', '0001')).toBe('AB123456-0001-0000001')
    expect(await legalMarkTick()).toBe(0)
    expect(markOf(file, s.orgId)).toBe(123)
    expect(markOf(file, s.orgId, `CASH_SALE|${year}`)).toBe(1)
    expect(markOf(file, s.orgId, 'UNP-AB123456|0')).toBe(1)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(await legalMarkOf(s.orgId)).toEqual([
      { prefix: 'CASH_SALE', year, last: 1, from: 'local' },
      { prefix: 'SALES_DOC', year, last: 123, from: 'local' },
      { prefix: 'UNP-AB123456', year: 0, last: 1, from: 'local' },
    ])
  }, 60_000)

  it('an Air-gapped master whose database alone went back: the journal\'s mark sees nothing, the legal mark locks', async () => {
    const s = await homeHere()
    // Air-gapped: nothing captures, so the journal's `seq` never moves with the sales.
    expect(captureOn()).toBe(false)
    expect(await journalHwmTick()).toBe(0)
    expect(await legalMarkTick()).toBe(0)
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    expect(markOf(legalMarkFile()!, s.orgId)).toBe(125)

    // The database is put back from outside the app (a copied data folder, a dump): sales at 120.
    await putBack(s.oid, 120)
    // Fail-first: the journal's own mark, the only check before #549, finds nothing to see.
    expect(await journalHwmTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(await legalMarkTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({
      reason: 'restored',
      detail: expect.stringMatching(new RegExp(`SALES_DOC ${year} is at 120 here, and this server had issued up to 125 \\(its mark beside the database\\)`)),
    })
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
    // The mark stays as the evidence: never lowered, and a second tick locks nothing more.
    expect(markOf(legalMarkFile()!, s.orgId)).toBe(125)
    expect(await legalMarkTick()).toBe(0)
    expect(markOf(legalMarkFile()!, s.orgId)).toBe(125)
  }, 60_000)

  it('a whole system disk put back: the mark beside the database went back with it, the backup drive\'s copy did not', async () => {
    plugDrive()
    const s = await homeHere()
    const file = legalMarkFile()!
    expect(await legalMarkTick()).toBe(0)
    const atImage = readFileSync(file, 'utf8')
    // The copy on the drive is the mark itself.
    expect(readFileSync(driveCopy(), 'utf8')).toBe(atImage)
    await issue(s.orgId, 10)
    expect(await legalMarkTick()).toBe(0)
    expect(markOf(driveCopy(), s.orgId)).toBe(130)

    // The disk image goes back on: database AND the mark beside it, as they were at 120.
    writeFileSync(file, atImage)
    await putBack(s.oid, 120)
    expect(await legalMarkTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: expect.stringContaining('up to 130 (its mark on the backup drive)') })
    // The mark beside the database learns the drive's: never lower again.
    expect(markOf(file, s.orgId)).toBe(130)
    expect(await legalMarkOf(s.orgId)).toContainEqual({ prefix: 'SALES_DOC', year, last: 130, from: 'local' })
  }, 60_000)

  it('no drive, a drive that is not there, or one on the data\'s own disk: no copy and no error, and the mark beside the database still locks', async () => {
    const s = await homeHere()
    // Configured, but unplugged: the location is never created.
    ;(config.backup as any).localPath = join(root, 'unplugged')
    expect(await legalMarkTick()).toBe(0)
    expect(existsSync(join(root, 'unplugged'))).toBe(false)
    // There, but on the disk the data is on (an empty mount point left behind): no copy goes there.
    mkdirSync(drive, { recursive: true })
    ;(config.backup as any).localPath = drive
    localDisk.sameAsData = async () => true
    await issue(s.orgId, 2)
    expect(await legalMarkTick()).toBe(0)
    expect(existsSync(join(drive, 'LGR'))).toBe(false)
    expect(markOf(legalMarkFile()!, s.orgId)).toBe(122)
    // The mark beside the database still sees the database go back.
    await putBack(s.oid, 121)
    expect(await legalMarkTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored' })
  }, 60_000)

  it('an older copy on the drive (a rotated drive brought back) locks nothing and is brought up to date; another server\'s copy is no evidence', async () => {
    plugDrive()
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    // Last month's drive: its copy says 100.
    const copy = read(driveCopy())
    copy.orgs[s.orgId][SALES].last = 100
    writeFileSync(driveCopy(), JSON.stringify(copy))
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(markOf(driveCopy(), s.orgId)).toBe(125)
    // A copy that names another server, however high, says nothing of this one, and is replaced.
    writeFileSync(driveCopy(), JSON.stringify({ v: 1, node: 'master-someoneelse00000', orgs: { [s.orgId]: { [SALES]: { last: 999, at: new Date().toISOString() } } } }))
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(read(driveCopy()).node).toBe(NODE)
    expect(markOf(driveCopy(), s.orgId)).toBe(125)
  }, 60_000)

  it('the unlock resumes above the mark, even under a lower reading, says so in the audit, and the next tick is quiet', async () => {
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    await putBack(s.oid, 120)
    expect(await legalMarkTick()).toBe(1)
    // The person reads 122 off the paper: the mark knows this server issued up to 125.
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 122))
    expect(await frozen(s.oid)).toBeUndefined()
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00126`)
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    let audit: any = null
    for (let i = 0; i < 100 && !audit; i++) {
      audit = await AuditLog.findOne({ orgId: s.oid, entityType: 'sequence', entityName: 'last numbers issued at the site' }).lean()
      if (!audit) await Bun.sleep(20)
    }
    expect(audit.changes).toContainEqual(expect.objectContaining({ field: `SALES_DOC ${year}: this server's mark (beside the database)`, oldValue: 122, newValue: 125 }))
  }, 60_000)

  it('off a master, for an org written elsewhere, or for one a move is still bringing in (frozen): nothing', async () => {
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    const file = legalMarkFile()!
    // lgrai.app keeps no mark.
    ;(config.node as any).role = 'global'
    await putBack(s.oid, 100)
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    ;(config.node as any).role = 'master'
    // The org left: not this server's to lock, and its mark stays as it was.
    await OrgHome.updateOne({ orgId: s.oid }, { $set: { home: 'global' } })
    forgetAllHomes()
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(markOf(file, s.orgId)).toBe(125)
    // It comes back by a move: frozen while its copy is imported, every counter empty meanwhile.
    await OrgHome.updateOne({ orgId: s.oid }, { $set: { home: NODE, state: 'frozen', epoch: 3 } })
    forgetAllHomes()
    await Sequence.collection.deleteMany({ orgId: s.oid } as any)
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    // Imported whole, lgrai.app's counters above this server's old mark; active: the mark follows.
    await Sequence.collection.insertOne({ orgId: s.oid, prefix: 'SALES_DOC', year, lastNumber: 140 } as any)
    await OrgHome.updateOne({ orgId: s.oid }, { $set: { state: 'active' } })
    forgetAllHomes()
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(markOf(file, s.orgId)).toBe(140)
  }, 60_000)

  it('legacy per-operator УНП rows, display overrides and other series are no legal counter; a damaged mark is no floor', async () => {
    expect(legalCounterKey('SALES_DOC', year)).toBe(SALES)
    expect(legalCounterKey('CASH_SALE', year)).toBe(`CASH_SALE|${year}`)
    expect(legalCounterKey('UNP-AB123456', 0)).toBe('UNP-AB123456|0')
    expect(legalCounterKey('SALES_DOC', 0)).toBeNull()
    expect(legalCounterKey('UNP-AB123456-0001', 0)).toBeNull()
    expect(legalCounterKey('BILL', year)).toBeNull()
    const s = await homeHere()
    await Sequence.collection.insertMany([
      { orgId: s.oid, prefix: 'UNP-AB123456-0001', year: 0, lastNumber: 50 },
      { orgId: s.oid, prefix: 'SALES_DOC', year: 0, lastNumber: 0, displayPrefix: 'ФАК' },
      { orgId: s.oid, prefix: 'BILL', year, lastNumber: 9 },
    ] as any)
    expect(await legalMarkTick()).toBe(0)
    expect(Object.keys(read(legalMarkFile()!).orgs[s.orgId])).toEqual([SALES])
    // A mark file carrying what no counter could hold (damage, or a hand edit) is read without it.
    const file = legalMarkFile()!
    const damaged = read(file)
    damaged.orgs[s.orgId][SALES].last = 10 ** 12
    damaged.orgs[s.orgId]['UNP-AB123456-0001|0'] = { last: 999, at: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(damaged))
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
    expect(read(file).orgs[s.orgId]).toEqual({ [SALES]: { last: 120, at: expect.any(String) } })
    // One that is not JSON is kept aside under a dated name, never lost (a second one too), and a new mark starts.
    writeFileSync(file, '{ not json')
    expect(await legalMarkTick(new Date('2026-11-08T10:00:00Z'))).toBe(0)
    writeFileSync(file, 'damaged again')
    expect(await legalMarkTick(new Date('2026-11-08T10:01:00Z'))).toBe(0)
    const aside = readdirSync(dirname(file)).filter(f => f.startsWith('legal-mark.json.unreadable-')).sort()
    expect(aside.map(f => readFileSync(join(dirname(file), f), 'utf8'))).toEqual(['{ not json', 'damaged again'])
    expect(markOf(file, s.orgId)).toBe(120)
  }, 60_000)

  it('a backup share that does not answer: the tick ends within its bound, the database is still checked, and the hung share is not asked again', async () => {
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    // A share whose server went away: the check of its disk never answers.
    mkdirSync(drive, { recursive: true })
    ;(config.backup as any).localPath = drive
    let calls = 0
    let release!: (same: boolean) => void
    localDisk.sameAsData = () => {
      calls++
      return new Promise<boolean>(resolve => { release = resolve })
    }
    await putBack(s.oid, 120)
    const t0 = Date.now()
    expect(await legalMarkTick()).toBe(1)
    expect(Date.now() - t0).toBeLessThan(12_000)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: expect.stringContaining('up to 125 (its mark beside the database)') })
    expect(calls).toBe(1)
    // A minute later the earlier request still hangs: the share is not asked again, and the tick is quick.
    const t1 = Date.now()
    expect(await legalMarkTick()).toBe(0)
    expect(Date.now() - t1).toBeLessThan(2_000)
    expect(calls).toBe(1)
    // The share answers again: its request ends, and the copy there is kept again.
    localDisk.sameAsData = async () => false
    release(false)
    for (let i = 0; i < 50 && !existsSync(driveCopy()); i++) {
      await legalMarkTick()
      await Bun.sleep(20)
    }
    expect(markOf(driveCopy(), s.orgId)).toBe(125)
  }, 60_000)

  it('a mark that cannot be READ is no damage: left as it is, not replaced, and the unlock waits for it; the rollback is caught once it reads', async () => {
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    const file = legalMarkFile()!
    const held = readFileSync(file, 'utf8')
    // Something holds it this minute: a folder in its place reads as an I/O error, as a lock does.
    const hold = () => { rmSync(file, { recursive: true, force: true }); mkdirSync(file) }
    const letGo = () => { rmSync(file, { recursive: true, force: true }); writeFileSync(file, held) }
    hold()
    await putBack(s.oid, 120)
    expect(await legalMarkTick()).toBe(0)
    // Left as it is: never set aside as damage, never replaced by a mark made of the counters.
    expect(statSync(file).isDirectory()).toBe(true)
    expect(readdirSync(dirname(file)).filter(f => f.includes('unreadable'))).toEqual([])
    expect(await frozen(s.oid)).toBeUndefined()
    // It reads again: the mark it held still stands, and the rollback is caught.
    letGo()
    expect(await legalMarkTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored' })
    // An unlock while it cannot be read is refused, with nothing written.
    hold()
    const refused: any = await captureRejection(recordLastNumbers(s.orgId, s.by, await all(s.orgId, 121)))
    expect([refused?.statusCode, refused?.code]).toEqual([503, 'mark_unreadable'])
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored' })
    expect(((await Sequence.collection.findOne({ orgId: s.oid, prefix: 'SALES_DOC', year } as any)) as any)?.lastNumber).toBe(120)
    letGo()
    await recordLastNumbers(s.orgId, s.by, await all(s.orgId, 121))
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00126`)
  }, 60_000)

  it('with the mark beside the database unreadable, the backup drive\'s copy still catches a rollback', async () => {
    plugDrive()
    const s = await homeHere()
    await issue(s.orgId, 5)
    expect(await legalMarkTick()).toBe(0)
    const file = legalMarkFile()!
    rmSync(file)
    mkdirSync(file)
    await putBack(s.oid, 120)
    expect(await legalMarkTick()).toBe(1)
    expect(await frozen(s.oid)).toMatchObject({ reason: 'restored', detail: expect.stringContaining('up to 125 (its mark on the backup drive)') })
    expect(statSync(file).isDirectory()).toBe(true)
    expect(markOf(driveCopy(), s.orgId)).toBe(125)
  }, 60_000)

  it('a mark that cannot be written is logged, never thrown, and the database is still checked', async () => {
    const s = await homeHere()
    await issue(s.orgId, 1)
    // The state folder is a file: nothing can be read or written there.
    writeFileSync(join(root, 'blocked'), 'x')
    ;(config.outbox as any).tokenFile = join(root, 'blocked', 'node-token.json')
    expect(await legalMarkTick()).toBe(0)
    expect(await frozen(s.oid)).toBeUndefined()
  }, 60_000)
})

describe('numbering locked by hand (#549, the runbook)', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const app = new Elysia().use(numberingController)
  const token = (u: any, orgId: string, role: string) => (signer as any).decorator.jwt.sign({ id: String(u._id), orgId, role, email: `${role}@lock.test`, username: role, firstName: 'Ана', lastName: 'Петрова', permissions: [] })
  async function call(method: string, path: string, bearer: string, body?: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))
    let json: any = null
    try { json = await res.json() } catch { /* empty */ }
    return { status: res.status, json }
  }

  it('an admin locks it on the org\'s server, once; a member may not; the series and the mark are shown', async () => {
    const s = await homeHere()
    await issue(s.orgId, 4)
    expect(await legalMarkTick()).toBe(0)
    const member = await createTestUser(s.oid as Types.ObjectId, { role: 'member' } as any)
    const admin = await token(s.admin, s.orgId, 'admin')

    const shown = await call('GET', `/org/${s.orgId}/numbering/last-numbers`, admin)
    expect(shown.status).toBe(200)
    expect(shown.json).toMatchObject({ frozen: false, mark: [{ prefix: 'SALES_DOC', year, last: 124, from: 'local' }] })

    expect((await call('POST', `/org/${s.orgId}/numbering/lock`, await token(member, s.orgId, 'member'), { note: 'x' })).status).toBe(403)
    expect(await frozen(s.oid)).toBeUndefined()

    const locked = await call('POST', `/org/${s.orgId}/numbering/lock`, admin, { note: 'restored from the Friday image' })
    expect(locked.status).toBe(200)
    expect(locked.json).toMatchObject({ locked: true, already: false, reason: 'restored', detail: 'locked by Ана Петрова: restored from the Friday image' })
    expect((await captureRejection(getNextNumber(s.orgId, 'SALES_DOC')))?.code).toBe('series_frozen')
    let audit: any = null
    for (let i = 0; i < 100 && !audit; i++) {
      audit = await AuditLog.findOne({ orgId: s.oid, entityName: 'legal numbering locked by hand' }).lean()
      if (!audit) await Bun.sleep(20)
    }
    expect(audit.changes).toContainEqual(expect.objectContaining({ field: 'note', oldValue: null, newValue: 'restored from the Friday image' }))

    // Again: nothing changes, and it says so.
    const again = await call('POST', `/org/${s.orgId}/numbering/lock`, admin, {})
    expect(again.json).toMatchObject({ locked: true, already: true, detail: 'locked by Ана Петрова: restored from the Friday image' })
    expect(await AuditLog.countDocuments({ orgId: s.oid, entityName: 'legal numbering locked by hand' })).toBe(1)

    // The card shows why, and the unlock resumes above the person's reading and the mark.
    const waiting = await call('GET', `/org/${s.orgId}/numbering/last-numbers`, admin)
    expect(waiting.json).toMatchObject({ frozen: true, reason: 'restored', detail: expect.stringContaining('Friday image') })
    const series = waiting.json.series.map((x: any) => ({ prefix: x.prefix, year: x.year, last: x.prefix === 'SALES_DOC' ? 126 : x.last }))
    expect((await call('POST', `/org/${s.orgId}/numbering/last-numbers`, admin, { series })).status).toBe(200)
    expect(await getNextNumber(s.orgId, 'SALES_DOC')).toBe(`SALES_DOC-${year}-00127`)
  }, 60_000)

  it('409 for an org not written here, and 404 on lgrai.app', async () => {
    const s = await homeHere()
    const admin = await token(s.admin, s.orgId, 'admin')
    await OrgHome.updateOne({ orgId: s.oid }, { $set: { home: 'master-elsewhere0000000' } })
    forgetAllHomes()
    expect((await call('POST', `/org/${s.orgId}/numbering/lock`, admin, {})).status).toBe(409)
    expect(await frozen(s.oid)).toBeUndefined()
    ;(config.node as any).role = 'global'
    await OrgHome.deleteOne({ orgId: s.oid })
    forgetAllHomes()
    expect((await call('POST', `/org/${s.orgId}/numbering/lock`, admin, {})).status).toBe(404)
  }, 60_000)
})
