/**
 * The mirror end to end (FR-20.61–20.67, plan steps P3-1 and P3-2), with real processes: a real
 * `lgr-server` (its own `mongod`, the API from the built package) linked at Full to a local global
 * (the API in role global, behind T-1's TLS front and chaos proxy), home of one org. Its writes reach
 * global's mirror as they are; the link is cut, then throttled, while the master keeps writing; the
 * mirror ends equal to the master, document for document.
 *
 *   bun packages/tests/src/two-node/mirror-e2e.script.ts
 *
 * Needs: `cargo build` (packages/server), `bun run build` + `bun run build:server` (dist/lgr-server).
 * The master's mongod is mongodb-memory-server's cached one unless LGR_SERVER_MONGOD names another.
 * About four minutes. Passwords and keys are read, never printed. Exit 0 when every check passed.
 */
import { MongoBinary, MongoMemoryReplSet } from 'mongodb-memory-server'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTestCa, tlsFront } from './tls-front'
import { chaosProxy } from './chaos-proxy'
import { mongoose } from 'db/connection'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { homePart } from 'services/biz/replication/project'
import { BSON, idKey } from 'services/biz/replication/pages'

const REPO = resolve(import.meta.dir, '..', '..', '..', '..')
const EXE = join(REPO, 'packages', 'server', 'target', 'debug', process.platform === 'win32' ? 'lgr-server.exe' : 'lgr-server')
const PACKAGE = join(REPO, 'dist', 'lgr-server')
// The master's mongod: the one mongodb-memory-server keeps (downloaded once), or LGR_SERVER_MONGOD.
const MONGOD = process.env.LGR_SERVER_MONGOD ?? (await MongoBinary.getPath())
// Short: the supervisor's control socket lives under it, and an AF_UNIX path is at most 108 bytes.
const DATA = process.env.MIRROR_E2E_DATA ?? join(process.env.TEMP ?? '/tmp', 'lgrm2e')
const SCRATCH = join(process.env.TEMP ?? '/tmp', `lgr-mirror-e2e-${randomBytes(3).toString('hex')}`)
const MONGOD_PORT = 27236

let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const until = async <T>(f: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms: number, every = 1000): Promise<T | false> => {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) return false
    await Bun.sleep(every)
  }
}
const freePort = () => { const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p }
const random = () => randomBytes(48).toString('base64')

// ── global: the API in role global, behind a TLS front and the chaos proxy ───────────────────────
mkdirSync(SCRATCH, { recursive: true })
const ca = makeTestCa(join(SCRATCH, 'ca'))
const caFile = join(SCRATCH, 'ca', 'ca.crt')
const globalPort = freePort()
const front = tlsFront({ hostname: '127.0.0.1', port: globalPort }, ca)
const chaos = await chaosProxy({ hostname: '127.0.0.1', port: front.port })
const SERVER = `https://localhost:${chaos.port}`
const gmongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
const globalUri = gmongo.getUri('lgr')
const globalEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) globalEnv[k] = v
Object.assign(globalEnv, {
  NODE_ENV: 'production',
  LGR_NODE_ROLE: 'global',
  MONGODB_URI: globalUri,
  PORT: String(globalPort),
  HOST: '127.0.0.1',
  JWT_SECRET: random(),
  DESKTOP_TOKEN_SECRET: random(),
  NODE_TOKEN_SECRET: random(),
  // The audience a master's proofs are signed for: global as the master reaches it.
  OAUTH_BASE_URL: SERVER,
  OAUTH_FRONTEND_URL: SERVER,
  UPLOAD_DIR: join(SCRATCH, 'global-uploads'),
  MIGRATIONS_AUTO: 'true',
  DIGEST_CHECK_INTERVAL_MS: '0',
  BACKUP_CHECK_INTERVAL_MS: '0',
  RETENTION_CHECK_INTERVAL_MS: '0',
  DESKTOP_REAPER_INTERVAL_MS: '0',
  NODE_REAPER_INTERVAL_MS: '0',
})
const globalProc = Bun.spawn(['bun', 'src/unified.ts'], { cwd: join(REPO, 'packages', 'portal-api'), env: globalEnv, stdout: 'pipe', stderr: 'pipe' })
let globalLog = ''
for (const s of [globalProc.stdout, globalProc.stderr]) void (async () => { for await (const c of s) globalLog = (globalLog + new TextDecoder().decode(c)).slice(-40_000) })()

let sup: ReturnType<typeof Bun.spawn> | null = null
let supLog = ''
const supEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) supEnv[k] = v
Object.assign(supEnv, {
  LGR_SERVER_PACKAGE: PACKAGE,
  LGR_SERVER_DATA: DATA,
  LGR_SERVER_MONGOD: MONGOD,
  LGR_SERVER_PIPE: process.platform === 'win32' ? '\\\\.\\pipe\\lgr-server-m2e' : join(SCRATCH, 'ipc.sock'),
  // The test global's CA: what a TLS-inspecting middlebox's would be in a shop.
  LGR_SERVER_EXTRA_CA: caFile,
})
// ⚠ Never `Bun.spawnSync` here: the TLS front and the chaos proxy run in THIS process, and a blocked
// event loop forwards nothing, so a supervisor call to global waits for its own timeout.
const cli = async (...args: string[]) => {
  const p = Bun.spawn([EXE, ...args], { env: supEnv, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (out + err).trim() }
}
const supStatus = async () => { try { return JSON.parse((await cli('status', '--json')).out) } catch { return null } }

let master: InstanceType<typeof mongoose.mongo.MongoClient> | null = null
try {
  const up = await until(async () => (await fetch(`http://127.0.0.1:${globalPort}/api/health`).then(r => r.status === 200, () => false)) || (globalProc.exitCode !== null ? null : false), 120_000, 300)
  if (!up) throw new Error(`global did not come up:\n${globalLog.slice(-3000)}`)
  check('global answers through the TLS front and the chaos proxy', (await fetch(`${SERVER}/api/health`, { tls: { ca: ca.ca } } as any).then(r => r.status, () => 0)) === 200)

  // An org on global, and a code to register a master for it. (Models on global's database.)
  await mongoose.connect(globalUri)
  const org = await createTestOrg({ name: 'Mirror E2E Ltd', slug: 'mirror-e2e', description: 'a shop' } as any)
  const orgId = org._id
  const admin = await createTestUser(orgId as any, { role: 'admin' } as any)
  const { code } = await mintNodeEnrollmentCode(String(orgId), String(admin._id))

  // ── the master: a real supervisor, its own mongod, the API from the package ───────────────────
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(join(DATA, 'config'), { recursive: true })
  writeFileSync(join(DATA, 'config', 'api.env'), `MONGOD_PORT=${MONGOD_PORT}\nSETUP_PORT=4498\nOAUTH_FRONTEND_URL=http://127.0.0.1:4498\n`)
  sup = Bun.spawn([EXE, 'run'], { env: supEnv, stdout: 'ignore', stderr: 'pipe' })
  void (async () => { for await (const c of sup!.stderr as ReadableStream<Uint8Array>) supLog = (supLog + new TextDecoder().decode(c)).slice(-40_000) })()
  const apiUp = await until(async () => ((await supStatus())?.children ?? []).some((c: any) => c.name === 'api' && c.state === 'running'), 180_000)
  check('the supervisor runs its mongod and the API', !!apiUp, JSON.stringify(((await supStatus())?.children ?? []).map((c: any) => [c.name, c.state])))
  const nodeId: string = JSON.parse(readFileSync(join(DATA, 'state', 'node.json'), 'utf8')).nodeId
  console.log(`node: ${nodeId}`)

  // The org moves to the master (the move itself is P3-6): global's home record names it, and the
  // master holds the org with a home record of its own.
  await mongoose.connection.db!.collection('org_homes').insertOne({ orgId, home: nodeId, epoch: 1, state: 'active', since: new Date() })
  await mongoose.connection.db!.collection('orgs').updateOne({ _id: orgId }, { $set: { homeEpochHighWater: 1 } })
  const secrets = Object.fromEntries(readFileSync(join(DATA, 'keys', 'mongo.env'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
  master = await mongoose.mongo.MongoClient.connect(`mongodb://lgr-admin:${encodeURIComponent(secrets.MONGO_ADMIN_PASSWORD)}@127.0.0.1:${MONGOD_PORT}/?directConnection=true&authSource=admin`)
  const mdb = master.db('lgr')
  await mdb.collection('orgs').insertOne(await mongoose.connection.db!.collection('orgs').findOne({ _id: orgId }) as any)
  // The memberships move with it: the mirror's copies keep their person fields.
  await mdb.collection('users').insertMany(await mongoose.connection.db!.collection('users').find({ orgId }).toArray())
  await mdb.collection('org_homes').insertOne({ orgId, home: nodeId, epoch: 1, state: 'active', since: new Date() })
  const contact = (i: number) => ({ _id: new mongoose.Types.ObjectId(), orgId, companyName: `Client ${i}`, type: 'customer', isActive: true, notes: 'x'.repeat(400) })
  await mdb.collection('contacts').insertMany(Array.from({ length: 40 }, (_, i) => contact(i)))

  // ── registered at Full ─────────────────────────────────────────────────────────────────────────
  const reg = await cli('register', '--server', SERVER, '--code', code, '--link', 'full', '--name', 'Mirror e2e')
  check('the master registers with global at Full', reg.code === 0, reg.out.split('\n').slice(-2).join(' | '))
  if (reg.code !== 0) throw new Error(`registration failed; the supervisor said:\n${supLog.split('\n').filter(l => /WARN|ERROR|register|enroll|uplink/i.test(l)).slice(-15).join('\n')}`)
  const bulkUp = await until(async () => (await supStatus())?.uplink?.bulk?.state === 'connected', 60_000)
  check('its bulk socket connects', !!bulkUp, JSON.stringify((await supStatus())?.uplink?.bulk))

  // ── the mirror catches up ──────────────────────────────────────────────────────────────────────
  const headOf = async () => (await mdb.collection('repl_orgs').findOne({ orgId }))?.seq ?? 0
  const mirrorAt = async () => (await mongoose.connection.db!.collection('mirror_state').findOne({ orgId }))?.watermark ?? 0
  const digest = async (db: any) => {
    const out: Record<string, Record<string, string>> = {}
    for (const e of Object.values(REPLICATION_META)) {
      if ((e.class !== 'R' && e.class !== 'S') || !e.orgPath) continue
      const docs = await db.collection(e.collection).find(e.orgPath === '_id' ? { _id: orgId } : { orgId }, { promoteValues: false }).toArray()
      if (docs.length) out[e.collection] = Object.fromEntries(docs.map((d: any) => [idKey(d._id), createHash('sha256').update(BSON.serialize(homePart(d, e))).digest('hex')]))
    }
    return out
  }
  const equal = async () => {
    const [a, b] = [await digest(mdb), await digest(mongoose.connection.db)]
    return JSON.stringify(a) === JSON.stringify(b) ? a : false
  }
  const caughtUp = async (label: string, ms = 180_000) => {
    const ok = await until(async () => {
      const head = await headOf()
      return head > 0 && (await mirrorAt()) >= head && (await equal())
    }, ms, 1500)
    check(label, !!ok, `journal head ${await headOf()}, mirror ${await mirrorAt()}, contacts master ${await mdb.collection('contacts').countDocuments({ orgId })} / mirror ${await mongoose.connection.db!.collection('contacts').countDocuments({ orgId })}`)
    return !!ok
  }
  await caughtUp('the mirror holds the master\'s org, document for document')
  const g: any = await mongoose.connection.db!.collection('orgs').findOne({ _id: orgId })
  check('global kept its own fields of the org', g?.slug === 'mirror-e2e' && !!g?.subscription, JSON.stringify({ slug: g?.slug }))
  const rep = (await supStatus())?.uplink?.bulk?.replication?.[String(orgId)]
  check('`lgr-server status` shows the org\'s mirror position', rep?.watermark === (await headOf()) && !rep?.stopped, JSON.stringify(rep))

  // ── a cut: the link goes down, the shop keeps writing, the link comes back ────────────────────
  chaos.drop()
  chaos.down()
  await Bun.sleep(3000)
  await mdb.collection('contacts').insertMany(Array.from({ length: 25 }, (_, i) => contact(100 + i)))
  await mdb.collection('contacts').updateMany({ orgId, companyName: { $in: ['Client 1', 'Client 2', 'Client 3'] } }, { $set: { companyName: 'Renamed offline' } })
  await mdb.collection('contacts').deleteMany({ orgId, companyName: { $in: ['Client 4', 'Client 5'] } })
  await Bun.sleep(12_000)
  check('…while the link is down, nothing new reaches the mirror', (await mongoose.connection.db!.collection('contacts').countDocuments({ orgId, companyName: 'Renamed offline' })) === 0)
  chaos.up()
  await caughtUp('after the cut, the mirror catches up: inserts, updates and deletes', 240_000)

  // ── a slow link: throttled, with a burst of writes ────────────────────────────────────────────
  chaos.throttle(48 * 1024)
  await mdb.collection('contacts').insertMany(Array.from({ length: 400 }, (_, i) => contact(1000 + i)))
  await caughtUp('through a link throttled to 48 KB/s, a 400-document burst arrives whole', 300_000)
  chaos.throttle(null)

  // Nothing alarmed on the way.
  const st: any = await mongoose.connection.db!.collection('mirror_state').findOne({ orgId })
  check('global raised no alarm', !(st?.alarms ?? []).length, JSON.stringify(st?.alarms ?? []))
} catch (e) {
  failed++
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`)
  console.log(globalLog.slice(-2000))
  console.log(supLog.slice(-3000))
} finally {
  if (sup) {
    await cli('stop')
    await Promise.race([sup.exited, Bun.sleep(30_000)])
    sup.kill()
  }
  await master?.close().catch(() => {})
  await mongoose.disconnect().catch(() => {})
  globalProc.kill()
  await globalProc.exited
  await chaos.close()
  front.close()
  await gmongo.stop()
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
