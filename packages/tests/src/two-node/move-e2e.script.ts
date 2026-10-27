/**
 * The move to a master end to end (FR-20.79, plan step P3-6a), with real processes: an org on a
 * local global (the API in role global, behind T-1's TLS front and chaos proxy), and a real
 * `lgr-server` (its own `mongod`, the API from the built package) registered for it at Full. The
 * org's admin moves it there over HTTP; global freezes it, builds the copy, the master's API takes
 * it through the supervisor's egress, and the flip makes the master its home. The mirror then
 * starts again from the move, and ends equal to the master, document for document.
 *
 * Then the org's address (FR-20.72–20.74, plan step P3-4c): `move-e2e.lgrai.app`, sent to global's
 * port, reaches the master's API over the master's own link. Its session, its writes, its pages and
 * its WebSockets, and never a stamp the client wrote. And through a second pod of lgrai.app, which
 * holds no socket of the master and forwards to the one that does (P3-4d).
 *
 * Then back (FR-20.80, plan step P3-6c): the shop makes a document with a file on the master, the
 * admin moves the org back to lgrai.app, the master freezes it and drains, global puts the file
 * where its row says and flips, and the master keeps a read-only copy. The address then answers like
 * an unknown one: an org that lives on lgrai.app has none.
 *
 * Or, with `--promote` (FR-20.81 and FR-20.84, plan steps P3-6d and P3-6e): the shop makes a
 * document with a file, then its link is CUT, and it goes on selling (a sale numbered past what the
 * site will read off its paper). The admin promotes lgrai.app's copy on evidence; global puts the file
 * where its row says and flips with the legal series frozen; numbering resumes above the site's last
 * numbers once recorded, and gives the sale's number to another. The link comes back: the server
 * learns of it, fences itself, and exports everything above the cutoff, which reaches global for
 * review with that collision named. The admin brings it into the books: the other sale arrives as
 * the site wrote it, the colliding one stays out, named.
 *
 * Or, with `--reseed` (FR-20.71, AC 36, plan step P3-7): the master's database goes back underneath
 * the mirror, the way a disk reverted to a snapshot would (the org's documents, its journal and the
 * journal's mark outside the database, all as they were minutes before). The master can no longer
 * continue the mirror's chain: it records that, locks legal numbering and tells lgrai.app. The admin
 * re-seeds it from lgrai.app's copy: what was made since comes back, what was deleted since stays
 * deleted, nothing on the mirror is deleted, what the master held is kept, and the mirror's chain
 * starts again from the master, numbering still locked until the site's last numbers are recorded.
 *
 * Or, with `--reconcile` (FR-20.70, plan step P3-7f): the master loses the record of its changes. A
 * captured collection is dropped there, as a `mongosh` slip would, and an issued sale went where the
 * capture did not see it. Its tailer starts a new journal epoch and journals every document again;
 * lgrai.app takes the epoch's pages because they continue its chain, and the master's tick asks for
 * every id lgrai.app's copy holds and journals each again. The copy loses what the master deleted,
 * keeps the issued sale with an alarm, and is the master's again, document for document. Numbering
 * stays open: the master lost a record, not its data. Then (FR-20.65, plan step P3-2c) a document
 * whose id another org holds on lgrai.app is set aside: what the shop writes next still reaches the
 * copy, the Servers page lists it, and a move back waits for it.
 *
 *   bun packages/tests/src/two-node/move-e2e.script.ts [--promote | --reseed | --reconcile]
 *
 * Needs: `cargo build` (packages/server), `bun run build` + `bun run build:server` (dist/lgr-server).
 * About three minutes. Passwords and keys are read, never printed. Exit 0 when every check passed.
 */
import { MongoBinary, MongoMemoryReplSet } from 'mongodb-memory-server'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import zlib from 'node:zlib'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { makeTestCa, tlsFront } from './tls-front'
import { chaosProxy } from './chaos-proxy'
import { PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { Identity, OnpremCredential, OrgAddress, User } from 'db/models'
import { createTestContact, createTestOrg } from '../helpers/factories'
import { mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { collectionDigests } from 'services/biz/move/move-bundle'
import { homePart } from 'services/biz/replication/project'
import { BSON, idKey } from 'services/biz/replication/pages'

const REPO = resolve(import.meta.dir, '..', '..', '..', '..')
const EXE = join(REPO, 'packages', 'server', 'target', 'debug', process.platform === 'win32' ? 'lgr-server.exe' : 'lgr-server')
const PACKAGE = join(REPO, 'dist', 'lgr-server')
const MONGOD = process.env.LGR_SERVER_MONGOD ?? (await MongoBinary.getPath())
// Short: the supervisor's control socket lives under it, and an AF_UNIX path is at most 108 bytes.
const DATA = process.env.MOVE_E2E_DATA ?? join(process.env.TEMP ?? '/tmp', 'lgrmv')
const SCRATCH = join(process.env.TEMP ?? '/tmp', `lgr-move-e2e-${randomBytes(3).toString('hex')}`)
const MONGOD_PORT = 27237
const LOCAL_PASSWORD = randomBytes(12).toString('base64url')
const PROMOTE = process.argv.includes('--promote')
const RESEED = process.argv.includes('--reseed')
const RECONCILE = process.argv.includes('--reconcile')

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
const JWT_SECRET = random()
const GLOBAL_UPLOADS = join(SCRATCH, 'global-uploads')
const globalEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) globalEnv[k] = v
Object.assign(globalEnv, {
  NODE_ENV: 'production',
  LGR_NODE_ROLE: 'global',
  MONGODB_URI: globalUri,
  PORT: String(globalPort),
  HOST: '127.0.0.1',
  JWT_SECRET,
  DESKTOP_TOKEN_SECRET: random(),
  NODE_TOKEN_SECRET: random(),
  // The audience a master's proofs are signed for: global as the master reaches it.
  OAUTH_BASE_URL: SERVER,
  OAUTH_FRONTEND_URL: SERVER,
  UPLOAD_DIR: GLOBAL_UPLOADS,
  MIGRATIONS_AUTO: 'true',
  DIGEST_CHECK_INTERVAL_MS: '0',
  BACKUP_CHECK_INTERVAL_MS: '0',
  RETENTION_CHECK_INTERVAL_MS: '0',
  DESKTOP_REAPER_INTERVAL_MS: '0',
  NODE_REAPER_INTERVAL_MS: '0',
  // FR-20.73 (P3-4d): where lgrai.app's other pods reach this one.
  LGR_POD_ADDR: `http://127.0.0.1:${globalPort}`,
})
const globalProc = Bun.spawn(['bun', 'src/unified.ts'], { cwd: join(REPO, 'packages', 'portal-api'), env: globalEnv, stdout: 'pipe', stderr: 'pipe' })
let globalLog = ''
for (const s of [globalProc.stdout, globalProc.stderr]) void (async () => { for await (const c of s) globalLog = (globalLog + new TextDecoder().decode(c)).slice(-60_000) })()

let sup: ReturnType<typeof Bun.spawn> | null = null
let supLog = ''
const supEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) supEnv[k] = v
Object.assign(supEnv, {
  LGR_SERVER_PACKAGE: PACKAGE,
  LGR_SERVER_DATA: DATA,
  LGR_SERVER_MONGOD: MONGOD,
  LGR_SERVER_PIPE: process.platform === 'win32' ? '\\\\.\\pipe\\lgr-server-mv' : join(SCRATCH, 'ipc.sock'),
  // The test global's CA: what a TLS-inspecting middlebox's would be in a shop. The API trusts it
  // too, through the roots the supervisor exports for it: the move is the API's own call to global.
  LGR_SERVER_EXTRA_CA: caFile,
})
// ⚠ Never `Bun.spawnSync` here: the TLS front and the chaos proxy run in THIS process.
const cli = async (...args: string[]) => {
  const p = Bun.spawn([EXE, ...args], { env: supEnv, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (out + err).trim() }
}
const supStatus = async () => { try { return JSON.parse((await cli('status', '--json')).out) } catch { return null } }

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: JWT_SECRET })) as any).decorator.jwt
const api = (token: string) => async (method: string, path: string, body?: unknown) => {
  // The admin is on lgrai.app, not in the shop: straight to global's front, never through the shop's link.
  const res = await fetch(`https://localhost:${front.port}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    tls: { ca: ca.ca },
  } as any)
  return { status: res.status, body: await res.json().catch(() => null) as any }
}

let master: InstanceType<typeof mongoose.mongo.MongoClient> | null = null
try {
  const up = await until(async () => (await fetch(`http://127.0.0.1:${globalPort}/api/health`).then(r => r.status === 200, () => false)) || (globalProc.exitCode !== null ? null : false), 120_000, 300)
  if (!up) throw new Error(`global did not come up:\n${globalLog.slice(-3000)}`)

  // ── the shop on global: people, a local password for the site, data and a file ───────────────
  await mongoose.connect(globalUri)
  const gdb = mongoose.connection.db as any
  const org = await createTestOrg({ name: 'Move E2E Ltd', slug: 'move-e2e', description: 'a shop' } as any)
  const orgId = org._id as any
  const ana = await Identity.create({ email: 'ana@move-e2e.test', emailVerified: true, firstName: 'Ana', lastName: 'Shop', tokenVersion: 0, password: await Bun.password.hash(random()), passwordSetBy: 'self', isActive: true } as any)
  const admin = await User.create({ orgId, identityId: ana._id, email: ana.email, username: 'ana', firstName: 'Ana', lastName: 'Shop', role: 'admin', isActive: true, permissions: [], password: await Bun.password.hash(random()) } as any)
  await OnpremCredential.create({ identityId: ana._id, orgId, kind: 'password', verifier: await Bun.password.hash(LOCAL_PASSWORD, { algorithm: 'argon2id' }), tvAtSet: 0, setAt: new Date() })
  for (let i = 0; i < 60; i++) await createTestContact(orgId, { companyName: `Client ${i}`, notes: 'x'.repeat(300) } as any)
  mkdirSync(join(GLOBAL_UPLOADS, String(orgId), 'docs'), { recursive: true })
  writeFileSync(join(GLOBAL_UPLOADS, String(orgId), 'docs', 'receipt.txt'), 'касова бележка 7')
  const { code } = await mintNodeEnrollmentCode(String(orgId), String(admin._id))
  const adminToken = await signer.sign({ id: String(admin._id), email: admin.email, username: 'ana', firstName: 'Ana', lastName: 'Shop', role: 'admin', orgId: String(orgId), permissions: [...PERMISSIONS] })
  const asAdmin = api(adminToken)

  // ── the master: a real supervisor, registered at Full ─────────────────────────────────────────
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(join(DATA, 'config'), { recursive: true })
  writeFileSync(join(DATA, 'config', 'api.env'), `MONGOD_PORT=${MONGOD_PORT}\nSETUP_PORT=4497\nOAUTH_FRONTEND_URL=http://127.0.0.1:4497\n`)
  sup = Bun.spawn([EXE, 'run'], { env: supEnv, stdout: 'ignore', stderr: 'pipe' })
  void (async () => { for await (const c of sup!.stderr as ReadableStream<Uint8Array>) supLog = (supLog + new TextDecoder().decode(c)).slice(-60_000) })()
  const apiUp = await until(async () => ((await supStatus())?.children ?? []).some((c: any) => c.name === 'api' && c.state === 'running'), 180_000)
  check('the supervisor runs its mongod and the API', !!apiUp)
  const nodeId: string = JSON.parse(readFileSync(join(DATA, 'state', 'node.json'), 'utf8')).nodeId
  const reg = await cli('register', '--server', SERVER, '--code', code, '--link', 'full', '--name', 'Move e2e')
  check('the master registers with global at Full', reg.code === 0, reg.out.split('\n').slice(-2).join(' | '))
  if (reg.code !== 0) throw new Error('registration failed')
  // P3-8b (FR-20.98): the supervisor writes its account for the master's own status page, every 30 s.
  const statusFile: any = await until(() => {
    try {
      const v = JSON.parse(readFileSync(join(DATA, 'state', 'status.json'), 'utf8'))
      return v.registration?.linkLevel === 'full' && v.disk?.totalBytes > 0 ? v : false
    } catch {
      return false
    }
  }, 75_000, 1000)
  check("the supervisor writes its status for the master's own page: its processes, the disk, the link",
    !!statusFile && Date.now() - new Date(statusFile.writtenAt).getTime() < 60_000 && (statusFile.children ?? []).some((c: any) => c.name === 'api' && c.state === 'running') && statusFile.disk.freeBytes > 0,
    JSON.stringify(statusFile && { writtenAt: statusFile.writtenAt, link: statusFile.registration?.linkLevel, disk: statusFile.disk, children: (statusFile.children ?? []).map((c: any) => c.name + ':' + c.state) }))
  const secrets = Object.fromEntries(readFileSync(join(DATA, 'keys', 'mongo.env'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
  master = await mongoose.mongo.MongoClient.connect(`mongodb://lgr-admin:${encodeURIComponent(secrets.MONGO_ADMIN_PASSWORD)}@127.0.0.1:${MONGOD_PORT}/?directConnection=true&authSource=admin`)
  const mdb = master.db('lgr')

  // ── preflight: the master connected, healthy, its seal key known ─────────────────────────────
  const ready = await until(async () => {
    const r = await asAdmin('POST', `/org/${orgId}/moves/preflight`, { nodeId })
    return r.status === 200 && r.body.ok ? r.body : false
  }, 120_000, 2000)
  if (!ready) {
    const r = await asAdmin('POST', `/org/${orgId}/moves/preflight`, { nodeId })
    check('preflight passes once the master is connected and healthy', false, JSON.stringify(r.body?.checks?.filter((c: any) => !c.ok)))
    throw new Error('preflight never passed')
  }
  check('preflight passes once the master is connected and healthy', true)

  // ── the move ───────────────────────────────────────────────────────────────────────────────────
  const started = await asAdmin('POST', `/org/${orgId}/moves/`, { nodeId })
  check('the admin starts the move, and the org freezes', started.status === 200 && started.body?.move?.state === 'freezing', JSON.stringify(started.body))
  const frozen = await asAdmin('POST', `/org/${orgId}/invoicing/contact`, { type: 'customer', companyName: 'Written while frozen' })
  check('…a write to the frozen org is refused on global', frozen.status === 409 && frozen.body?.code === 'org_home_elsewhere', `${frozen.status} ${frozen.body?.code}`)
  const done = await until(async () => {
    const r = await asAdmin('GET', `/org/${orgId}/moves/current`)
    return r.body?.move && ['done', 'aborted'].includes(r.body.move.state) ? r.body.move : false
  }, 180_000, 2000)
  check('the move ends done: the copy built, taken by the master and verified', !!done && done.state === 'done', JSON.stringify(done ? { state: done.state, error: done.error, steps: done.steps?.map((s: any) => s.name) } : 'no end'))
  if (!done || done.state !== 'done') throw new Error('the move did not finish')

  // ── where the org lives now ────────────────────────────────────────────────────────────────────
  const gHome: any = await gdb.collection('org_homes').findOne({ orgId })
  check('global names the master the org\'s home, one epoch up', gHome?.home === nodeId && gHome?.epoch === 1 && gHome?.state === 'active', JSON.stringify(gHome && { home: gHome.home, epoch: gHome.epoch, state: gHome.state }))
  const mHome = await until(async () => {
    const h: any = await mdb.collection('org_homes').findOne({ orgId })
    return h?.state === 'active' ? h : false
  }, 60_000)
  check('the master makes it home there', !!mHome && (mHome as any).home === nodeId && (mHome as any).epoch === 1)
  // The master has written one thing of its own since: the arrival, in the org's audit trail.
  await until(() => mdb.collection('auditlogs').findOne({ orgId, entityType: 'org_move', entityName: 'from lgrai.app' }), 30_000)
  // Against what global froze (the move's own record): by now the mirror's first pages may have
  // rewritten global's split documents, whose fields a `$replaceWith` puts in another order.
  const moved: any = await gdb.collection('org_moves').findOne({ orgId })
  const { auditlogs: oursAudit, ...ours } = (moved?.digests ?? {}) as Record<string, { count: number; sha256: string }>
  const { auditlogs: theirsAudit, ...theirs } = await collectionDigests(mdb as any, orgId)
  const differ = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].filter(c => ours[c]?.sha256 !== theirs[c]?.sha256 || ours[c]?.count !== theirs[c]?.count)
  check('the master holds the org as global froze it, collection by collection', Object.keys(ours).length > 0 && !differ.length, differ.length ? `differ: ${differ.join(', ')}` : `${Object.keys(ours).length} collections`)
  check('…and one audit entry more, its own', (theirsAudit?.count ?? 0) === (oursAudit?.count ?? 0) + 1, `${oursAudit?.count ?? 0} → ${theirsAudit?.count ?? 0}`)
  const person: any = await mdb.collection('identities').findOne({ _id: ana._id })
  check('the org\'s people came with it, without their lgrai.app password', !!person && person.email === ana.email && person.password === undefined)
  const cred: any = await mdb.collection('local_credentials').findOne({ identityId: ana._id })
  check('their local password came sealed, and opens on the master', !!cred && (await Bun.password.verify(LOCAL_PASSWORD, cred.verifier)) && String(cred.forOrgId) === String(orgId))
  const file = join(DATA, 'uploads', String(orgId), 'docs', 'receipt.txt')
  check('the org\'s files came with it', existsSync(file) && readFileSync(file, 'utf8') === 'касова бележка 7')
  const writeHere = await asAdmin('POST', `/org/${orgId}/invoicing/contact`, { type: 'customer', companyName: 'Written on global' })
  check('global no longer writes the org', writeHere.status === 409 && writeHere.body?.code === 'org_home_elsewhere', `${writeHere.status}`)

  // ── the mirror starts again from the move ──────────────────────────────────────────────────────
  const headOf = async () => (await mdb.collection('repl_orgs').findOne({ orgId }))?.seq ?? 0
  const mirrorAt = async () => (await gdb.collection('mirror_state').findOne({ orgId }))?.watermark ?? 0
  const digest = async (db: any) => {
    const out: Record<string, Record<string, string>> = {}
    for (const e of Object.values(REPLICATION_META)) {
      if ((e.class !== 'R' && e.class !== 'S') || !e.orgPath) continue
      const docs = await db.collection(e.collection).find(e.orgPath === '_id' ? { _id: orgId } : { orgId }, { promoteValues: false }).toArray()
      if (docs.length) out[e.collection] = Object.fromEntries(docs.map((d: any) => [idKey(d._id), createHash('sha256').update(BSON.serialize(homePart(d, e))).digest('hex')]))
    }
    return out
  }
  const caughtUp = async (label: string, ms = 180_000) => {
    const ok = await until(async () => {
      const head = await headOf()
      return head > 0 && (await mirrorAt()) >= head && JSON.stringify(await digest(mdb)) === JSON.stringify(await digest(gdb))
    }, ms, 1500)
    check(label, !!ok, `journal head ${await headOf()}, mirror ${await mirrorAt()}`)
  }
  await caughtUp('the master pages the org from the move on, and the mirror holds it whole')
  await mdb.collection('contacts').insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), orgId, companyName: `Written at the shop ${i}`, type: 'customer', isActive: true })))
  await caughtUp('what the shop writes now reaches the mirror')
  const st: any = await gdb.collection('mirror_state').findOne({ orgId })
  check('global raised no alarm', !(st?.alarms ?? []).length, JSON.stringify(st?.alarms ?? []))
  const audit = await mdb.collection('auditlogs').findOne({ orgId, entityType: 'org_move', entityName: 'from lgrai.app' })
  check('the master recorded the arrival in the org\'s own trail', !!audit)

  // ── FR-20.72–20.74 (P3-4c): the org's address reaches the master over the master's own link ──────
  // The address is issued here directly: requesting and approving it is org-address.flow's.
  await OrgAddress.create({ label: 'move-e2e', orgId, state: 'active', requestedBy: String(admin._id), requestedAt: new Date(), decidedBy: 'move-e2e', decidedAt: new Date() } as any)
  // Straight to global's port with the address as the Host, the way lgrai.app's proxy hands it on.
  const viaAddress = (path: string, init: RequestInit = {}, host = 'move-e2e.lgrai.app') =>
    fetch(`http://127.0.0.1:${globalPort}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), host } })
  // A session the MASTER signed: global never holds that key, so only the master can accept it.
  const apiSecrets = Object.fromEntries(readFileSync(join(DATA, 'keys', 'api-secrets.env'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
  const masterSigner = (new Elysia().use(jwt({ name: 'jwt', secret: apiSecrets.JWT_SECRET })) as any).decorator.jwt
  const shopToken = await masterSigner.sign({ id: String(admin._id), email: admin.email, username: 'ana', firstName: 'Ana', lastName: 'Shop', role: 'admin', orgId: String(orgId), permissions: [...PERMISSIONS] })
  const bearer = { authorization: `Bearer ${shopToken}` }

  const nobody = await viaAddress('/', { headers: { accept: 'text/html' } }, 'nobody-here.lgrai.app')
  check('an address nobody has answers 404, from lgrai.app', nobody.status === 404, `${nobody.status}`)
  const anon = await viaAddress(`/api/org/${orgId}/invoicing/contact`)
  check('…and the org\'s API without a sign-in is refused at the edge', anon.status === 401 && (await anon.json().catch(() => null))?.code === 'unauthenticated', `${anon.status}`)
  const listed = await viaAddress(`/api/org/${orgId}/invoicing/contact?size=200`, { headers: bearer })
  const listedBody: any = await listed.json().catch(() => null)
  const notHere = await fetch(`http://127.0.0.1:${globalPort}/api/org/${orgId}/invoicing/contact?size=200`, { headers: bearer })
  check('a session the master signed reads the org through its address: the master answers', listed.status === 200 && (listedBody?.contacts ?? []).some((c: any) => c.companyName === 'Written at the shop 0') && notHere.status === 401, `${listed.status}, on global itself ${notHere.status}`)
  const posted = await viaAddress(`/api/org/${orgId}/invoicing/contact`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'customer', companyName: 'Written through the address', notes: 'n'.repeat(5000) }) })
  check('…and writes it: the body crosses, and the document is the master\'s', posted.status === 200 && !!(await mdb.collection('contacts').findOne({ orgId, companyName: 'Written through the address' })), `${posted.status}`)
  // FR-20.48: the master's audit trail says where that write came from.
  const viaRow: any = await until(() => mdb.collection('auditlogs').findOne({ orgId, entityType: 'contact', entityName: 'Written through the address' }), 15_000, 500)
  check('…and the master\'s audit entry for it says it came through the address', viaRow?.via === 'tunnel', JSON.stringify(viaRow ? { via: viaRow.via } : null))
  // What the client stamps never crosses: the master sees the tunnel, which may not create an org.
  const stamped = await viaAddress('/api/auth/register', { method: 'POST', headers: { ...bearer, 'x-lgr-source': 'console', 'x-lgr-front': 'forged', 'content-type': 'application/json' }, body: '{}' })
  check('…while a stamp the client writes is dropped: org creation stays the console\'s', stamped.status === 404, `${stamped.status}`)
  // The app itself, anonymously: its largest bundle, well past one stream's 256 KB window, byte for byte.
  const page = await viaAddress('/', { headers: { accept: 'text/html' } })
  const pageOk = page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html') && (await page.text()).includes('/assets/')
  const assets = join(REPO, 'packages', 'portal-ui', 'dist', 'assets')
  const bundle = readdirSync(assets).filter(f => f.endsWith('.js')).map(f => ({ f, size: statSync(join(assets, f)).size })).sort((a, b) => b.size - a.size)[0]
  const tunnelled = Buffer.from(await (await viaAddress(`/assets/${bundle.f}`)).arrayBuffer())
  check('the app\'s own pages come through the address, its largest bundle whole', pageOk && bundle.size > 256 * 1024 && tunnelled.equals(readFileSync(join(assets, bundle.f))), `${page.status} ${bundle.f}: ${tunnelled.length} of ${bundle.size} B`)
  // A WebSocket: it signs in with its first message, and the master's socket answers.
  const said = await new Promise<string[]>(res => {
    const got: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${globalPort}/ws/tasks`, { headers: { host: 'move-e2e.lgrai.app' } } as any)
    const done = () => { try { ws.close() } catch { /* closed */ } ; res(got) }
    const timer = setTimeout(done, 15_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: shopToken }))
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data))
      got.push(m.type)
      if (m.type === 'authenticated') ws.send(JSON.stringify({ type: 'ping' }))
      if (m.type === 'pong') { clearTimeout(timer); done() }
    }
    ws.onclose = () => { clearTimeout(timer); res(got) }
  })
  check('a WebSocket through the address signs in on the master and is answered', said.join(',') === 'authenticated,pong', said.join(','))

  // FR-20.73 (P3-4d): the same address, landing on another of lgrai.app's pods, one that holds no
  // socket of the master: it forwards to the pod that does. Started for this alone, on the same database.
  const podBPort = freePort()
  const podB = Bun.spawn(['bun', 'src/unified.ts'], {
    cwd: join(REPO, 'packages', 'portal-api'),
    env: { ...globalEnv, PORT: String(podBPort), LGR_POD_ADDR: `http://127.0.0.1:${podBPort}`, MIGRATIONS_AUTO: 'false' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    const bUp = await until(async () => (await fetch(`http://127.0.0.1:${podBPort}/api/health`).then(r => r.status === 200, () => false)) || (podB.exitCode !== null ? null : false), 120_000, 300)
    check('a second pod of lgrai.app comes up', !!bUp)
    const viaB = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${podBPort}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), host: 'move-e2e.lgrai.app' } })
    const readB = await viaB(`/api/org/${orgId}/invoicing/contact?size=200`, { headers: bearer })
    const readBody: any = await readB.json().catch(() => null)
    const wroteB = await viaB(`/api/org/${orgId}/invoicing/contact`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'customer', companyName: 'Written through the other pod' }) })
    check('a request landing on the other pod reaches the master through the pod holding its link: read and write',
      readB.status === 200 && (readBody?.contacts ?? []).some((c: any) => c.companyName === 'Written through the address') && wroteB.status === 200 && !!(await mdb.collection('contacts').findOne({ orgId, companyName: 'Written through the other pod' })),
      `${readB.status} ${wroteB.status}`)
    const saidB = await new Promise<string[]>(res => {
      const got: string[] = []
      const ws = new WebSocket(`ws://127.0.0.1:${podBPort}/ws/tasks`, { headers: { host: 'move-e2e.lgrai.app' } } as any)
      const timer = setTimeout(() => { try { ws.close() } catch { /* closed */ } ; res(got) }, 15_000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: shopToken }))
      ws.onmessage = e => {
        const m = JSON.parse(String(e.data))
        got.push(m.type)
        if (m.type === 'authenticated') ws.send(JSON.stringify({ type: 'ping' }))
        if (m.type === 'pong') { clearTimeout(timer); try { ws.close() } catch { /* closed */ } ; res(got) }
      }
      ws.onclose = () => { clearTimeout(timer); res(got) }
    })
    check('…and a WebSocket, opened on the pod holding the link', saidB.join(',') === 'authenticated,pong', saidB.join(','))
  } finally {
    podB.kill()
    await podB.exited
  }

  if (PROMOTE) {
    // ── FR-20.81 (P3-6d): the server is lost, and lgrai.app's copy is promoted ─────────────────────
    // A document the shop makes, its file on lgrai.app by content before the server goes.
    const made = randomBytes(40_000)
    const madeRel = `${String(orgId)}/docs/2026-10-27/made-before-the-loss.pdf`
    mkdirSync(join(DATA, 'uploads', String(orgId), 'docs', '2026-10-27'), { recursive: true })
    writeFileSync(join(DATA, 'uploads', ...madeRel.split('/')), made)
    const madeSha = createHash('sha256').update(made).digest('hex')
    await mdb.collection('docfiles').insertOne({ _id: new mongoose.Types.ObjectId(), orgId, docType: 'invoice', docNumber: 'made-before-the-loss', docDate: '2026-10-27', originalName: 'made-before-the-loss.pdf', currentPath: madeRel, currentChecksum: madeSha, version: 1, mimeType: 'application/pdf', size: made.length, status: 'uploaded', uploadedAt: new Date() })
    const held = await until(() => gdb.collection('mirror_blobs').findOne({ orgId, sha256: madeSha, state: 'ok' }), 180_000, 2000)
    check('the shop\'s new file reaches lgrai.app by content', !!held)
    const watermark = await mirrorAt()
    // The link is cut: the server goes on, and lgrai.app hears nothing more of it.
    chaos.down()
    // It goes on selling: a sale numbered past what the site's paper will say (500), so lgrai.app
    // will give its number to another sale once numbering resumes.
    const lateSale = new mongoose.Types.ObjectId()
    await mdb.collection('contacts').insertOne({ _id: new mongoose.Types.ObjectId(), orgId, companyName: 'Sold to while the link was down', type: 'customer', isActive: true })
    await mdb.collection('invoices').insertOne({ _id: lateSale, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: 'INV-2026-00501', status: 'sent', issueDate: new Date(), total: 99, currency: 'EUR', lines: [] })
    // And one lgrai.app will never number: it comes into the books as it is.
    const soldAt = new Date(Date.now() - 60_000)
    const otherSale = new mongoose.Types.ObjectId()
    await mdb.collection('invoices').insertOne({ _id: otherSale, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: 'INV-2026-00502', status: 'sent', issueDate: soldAt, createdAt: soldAt, total: 49, currency: 'EUR', lines: [] })
    const journaled = await until(async () => (await headOf()) > watermark + 1, 60_000, 500)
    check('the cut-off server goes on, and journals what it does', !!journaled, `head ${await headOf()}, cutoff ${watermark}`)
    const gone = await until(async () => {
      const r = await asAdmin('POST', `/org/${orgId}/moves/promote/preflight`, {})
      return r.status === 200 && r.body?.ok ? r.body : false
    }, 120_000, 2000)
    check('with the server gone, the promotion passes its preflight', !!gone, gone ? '' : JSON.stringify((await asAdmin('POST', `/org/${orgId}/moves/promote/preflight`, {})).body?.checks?.filter((c: any) => !c.ok)))
    const off = await asAdmin('POST', `/org/${orgId}/moves/promote`, { hardware: 'off', tillsDisconnected: true, slug: 'move-e2e' })
    check('"switched off" a minute ago is refused: 24 h of silence first', off.status === 409 && off.body?.code === 'not_silent_long_enough', `${off.status} ${off.body?.code}`)
    const promoted = await asAdmin('POST', `/org/${orgId}/moves/promote`, { hardware: 'destroyed', tillsDisconnected: true, slug: 'move-e2e' })
    check('attested destroyed, the promotion starts', promoted.status === 200 && promoted.body?.move?.kind === 'promote' && promoted.body?.move?.state === 'verifying', JSON.stringify(promoted.body))
    const pDone = await until(async () => {
      const r = await asAdmin('GET', `/org/${orgId}/moves/current`)
      return r.body?.move?.kind === 'promote' && ['done', 'aborted'].includes(r.body.move.state) ? r.body.move : false
    }, 120_000, 2000)
    check('the promotion ends done: the files put back, flipped', !!pDone && pDone.state === 'done' && pDone.placed?.missing === 0, JSON.stringify(pDone ? { state: pDone.state, error: pDone.error, placed: pDone.placed } : 'no end'))
    const gProm: any = await gdb.collection('org_homes').findOne({ orgId })
    check('global is the home, one epoch up, its legal series frozen', gProm?.home === 'global' && gProm?.epoch === 2 && gProm?.state === 'active' && !!gProm?.seriesFrozen?.since, JSON.stringify(gProm && { home: gProm.home, epoch: gProm.epoch, state: gProm.state, seriesFrozen: gProm.seriesFrozen }))
    const cutoff = ((await gdb.collection('org_moves').findOne({ orgId, kind: 'promote' })) as any)?.fenceCutoff
    check('…its fence cutoff the watermark the mirror held', cutoff === watermark, `${cutoff} vs ${watermark}`)
    const placedFile = join(GLOBAL_UPLOADS, ...madeRel.split('/'))
    check('the file the shop made is on global where its row says', existsSync(placedFile) && createHash('sha256').update(readFileSync(placedFile)).digest('hex') === madeSha)
    const customer = await asAdmin('POST', `/org/${orgId}/invoicing/contact`, { type: 'customer', companyName: 'Written after the promotion' })
    check('global writes the org again', customer.status === 200, `${customer.status} ${customer.body?.code ?? ''}`)
    const line = { description: 'Service', quantity: 1, unitPrice: 10, taxRate: 20 }
    const draft = await asAdmin('POST', `/org/${orgId}/invoices`, { type: 'invoice', direction: 'outgoing', contactId: customer.body?.contact?.id, issueDate: '2026-10-27', currency: 'EUR', lines: [line], subtotal: 10, taxTotal: 2, total: 12, paymentMethod: 'bank_transfer' })
    const refused = await asAdmin('POST', `/org/${orgId}/invoices/${draft.body?.invoice?.id}/send`, {})
    check('…but issues no legal number: it waits for the site\'s last numbers', draft.status === 200 && refused.status === 409 && refused.body?.code === 'series_frozen', `${draft.status} ${refused.status} ${refused.body?.code}`)
    const series = (await asAdmin('GET', `/org/${orgId}/numbering/last-numbers`)).body?.series ?? []
    const recorded = await asAdmin('POST', `/org/${orgId}/numbering/last-numbers`, { series: series.map((x: any) => ({ ...x, last: x.prefix === 'SALES_DOC' ? 500 : x.last })) })
    const issued = await asAdmin('POST', `/org/${orgId}/invoices/${draft.body?.invoice?.id}/send`, {})
    check('the site\'s last numbers recorded, numbering resumes above them', recorded.status === 200 && issued.status === 200 && /-00501$/.test(issued.body?.invoice?.invoiceNumber ?? ''), `${recorded.status} ${issued.status} ${issued.body?.invoice?.invoiceNumber}`)

    // The link comes back: the server learns of the promotion from its moves, and fences itself.
    chaos.up()
    const fenced: any = await until(async () => {
      const h: any = await mdb.collection('org_homes').findOne({ orgId })
      return h?.state === 'fenced' ? h : false
    }, 120_000, 2000)
    check('…and fences itself: lgrai.app the home at epoch 2, at the cutoff', !!fenced && fenced.home === 'global' && fenced.epoch === 2 && fenced.fenceCutoff === cutoff, JSON.stringify(fenced && { home: fenced.home, epoch: fenced.epoch, state: fenced.state, fenceCutoff: fenced.fenceCutoff }))
    // FR-20.84 (P3-6e): everything it did above the cutoff, exported, kept, and sent for review.
    const moveId = String(((await gdb.collection('org_moves').findOne({ orgId, kind: 'promote' })) as any)?._id)
    const arrived: any = await until(async () => {
      const r: any = await gdb.collection('fenced_exports').findOne({ orgId })
      return r && r.state !== 'receiving' ? r : false
    }, 120_000, 2000)
    check('its export reaches lgrai.app, whole and checked', arrived?.state === 'received' && arrived.cutoff === cutoff, JSON.stringify(arrived && { state: arrived.state, error: arrived.error, cutoff: arrived.cutoff, summary: arrived.summary && { documents: arrived.summary.documents, byColl: arrived.summary.byColl } }))
    check('…holding the sales and the customer it made with the link down', arrived?.summary?.byColl?.invoices >= 2 && arrived?.summary?.byColl?.contacts >= 1 && (arrived?.summary?.legal ?? []).some((l: any) => l.id === String(lateSale) && l.number === 'INV-2026-00501'))
    const here = join(DATA, 'uploads', String(orgId), 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)
    const there = join(GLOBAL_UPLOADS, String(orgId), 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)
    const shaOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
    check('…kept on both sides, the same bytes', existsSync(here) && existsSync(there) && shaOf(here) === arrived?.sha256 && shaOf(there) === arrived?.sha256)
    const review = await asAdmin('GET', `/org/${orgId}/moves/fenced-exports`)
    const listed = review.body?.exports?.[0]?.legal?.find((l: any) => l.id === String(lateSale))
    check('the review names the sale whose number lgrai.app gave to another', review.status === 200 && listed?.onGlobal === 'collision' && listed?.collidesWith?.id === String(issued.body?.invoice?.id ?? issued.body?.invoice?._id), JSON.stringify(listed))
    check('…and writes none of it into the org', !(await gdb.collection('invoices').findOne({ _id: lateSale })) && !(await gdb.collection('invoices').findOne({ _id: otherSale })))
    // The admin brings it into the books.
    const asked = await asAdmin('POST', `/org/${orgId}/moves/fenced-exports/${String(arrived?._id)}/import`, {})
    check('the admin brings it into the books', asked.status === 200, `${asked.status} ${asked.body?.code ?? ''}`)
    const imported: any = await until(async () => {
      const r: any = await gdb.collection('fenced_exports').findOne({ _id: arrived?._id })
      return r?.import?.state === 'done' ? r : false
    }, 120_000, 2000)
    check('…which lgrai.app does, to the end', !!imported, JSON.stringify(imported?.import ?? null))
    const kept: any = await gdb.collection('invoices').findOne({ _id: otherSale })
    check('the sale lgrai.app never numbered arrives as the site wrote it, with where it came from', kept?.invoiceNumber === 'INV-2026-00502' && kept?.total === 49 && new Date(kept?.issueDate).getTime() === soldAt.getTime() && kept?.importedFrom?.kind === 'fenced_export' && String(kept?.importedFrom?.exportId) === String(arrived?._id), JSON.stringify(kept && { number: kept.invoiceNumber, total: kept.total, importedFrom: kept.importedFrom }))
    check('…numbering goes on above it', (((await gdb.collection('sequences').findOne({ orgId, prefix: 'SALES_DOC', year: new Date().getFullYear() })) as any)?.lastNumber ?? 0) >= 502)
    check('the one whose number lgrai.app gave to another stays out, named', !(await gdb.collection('invoices').findOne({ _id: lateSale })) && !!(await gdb.collection('fenced_import_items').findOne({ exportId: arrived?._id, coll: 'invoices', docKey: String(lateSale), outcome: 'skipped', reason: 'number_taken' })))
    check('the customer it sold to is here', !!(await gdb.collection('contacts').findOne({ orgId, companyName: 'Sold to while the link was down' })))
    await Bun.sleep(15_000)
    check('its pump sends nothing more of the org: lgrai.app keeps no mirror of it', (await gdb.collection('mirror_state').countDocuments({ orgId })) === 0)
  }

  if (RESEED) {
    // ── FR-20.71 (P3-7): the master's database goes back underneath the mirror, and is re-seeded ────
    const replicated = Object.values(REPLICATION_META).filter(e => (e.class === 'R' || e.class === 'S') && e.orgPath)
    const scope = (e: any) => (e.orgPath === '_id' ? { _id: orgId } : { orgId })
    // What a snapshot of the disk holds now: the org's documents, its journal, and the mark beside the token.
    const snap: Record<string, any[]> = {}
    for (const e of replicated) snap[e.collection] = await mdb.collection(e.collection).find(scope(e), { promoteValues: false }).toArray()
    const snapJournal = await mdb.collection('repl_journal').find({ orgId }, { promoteValues: false }).toArray()
    const snapRepl: any = await mdb.collection('repl_orgs').findOne({ orgId }, { promoteValues: false })
    const hwm = join(DATA, 'state', 'journal-hwm.json')
    const snapHwm = existsSync(hwm) ? readFileSync(hwm) : null
    // Then the shop goes on, and the mirror follows: a customer made, one deleted.
    const madeAfter = new mongoose.Types.ObjectId()
    await mdb.collection('contacts').insertOne({ _id: madeAfter, orgId, companyName: 'Made after the snapshot', type: 'customer', isActive: true })
    const deletedAfter: any = await mdb.collection('contacts').findOne({ orgId, companyName: 'Written at the shop 3' })
    await mdb.collection('contacts').deleteOne({ _id: deletedAfter._id })
    await caughtUp('what the shop wrote after the snapshot reaches the mirror')
    const before = await digest(gdb)
    const watermark = await mirrorAt()

    // The disk goes back to the snapshot. Its writes are the disk's, never the shop's: the org is out
    // of the capture while they land, and its journal row comes back last, as the snapshot had it.
    await mdb.collection('repl_orgs').updateOne({ orgId }, { $set: { enabled: false } })
    await Bun.sleep(2_000)
    for (const e of replicated) {
      await mdb.collection(e.collection).deleteMany(scope(e))
      if (snap[e.collection].length) await mdb.collection(e.collection).insertMany(snap[e.collection])
    }
    await mdb.collection('repl_journal').deleteMany({ orgId })
    if (snapJournal.length) await mdb.collection('repl_journal').insertMany(snapJournal)
    await Bun.sleep(3_000)
    await mdb.collection('repl_orgs').replaceOne({ orgId }, snapRepl)
    if (snapHwm) writeFileSync(hwm, snapHwm)
    check('the master\'s database is back where the snapshot left it', !(await mdb.collection('contacts').findOne({ _id: madeAfter })) && !!(await mdb.collection('contacts').findOne({ _id: deletedAfter._id })) && (await headOf()) < watermark, `head ${await headOf()}, mirror ${watermark}`)

    // The master finds out on its own (its own mark went back with the disk), locks, and says so.
    const record: any = await until(async () => ((await mdb.collection('repl_orgs').findOne({ orgId })) as any)?.wentBack, 120_000, 1000)
    check('the master records that its database went back underneath the mirror', !!record && ['mirror_ahead', 'instance_changed', 'stale_journal', 'diverged'].includes(record.reason), JSON.stringify(record))
    const locked: any = await mdb.collection('org_homes').findOne({ orgId })
    check('…and its legal numbering locks with it', locked?.seriesFrozen?.reason === 'went_back' || locked?.seriesFrozen?.reason === 'restored', JSON.stringify(locked?.seriesFrozen ?? null))
    const told = await until(async () => {
      const n: any = await gdb.collection('nodes').findOne({ _id: nodeId })
      return (n?.orgState ?? []).find((o: any) => String(o.orgId) === String(orgId))?.wentBack ?? false
    }, 120_000, 2000)
    check('…and tells lgrai.app, which shows it on the Servers page', !!told, JSON.stringify(told))
    await Bun.sleep(10_000)
    check('it cannot overwrite the mirror: nothing on lgrai.app moved', JSON.stringify(await digest(gdb)) === JSON.stringify(before) && (await mirrorAt()) === watermark, `mirror at ${await mirrorAt()}`)

    // The admin re-seeds it from lgrai.app's copy.
    const pre = await until(async () => {
      const r = await asAdmin('POST', `/org/${orgId}/moves/reseed/preflight`, {})
      return r.status === 200 && r.body?.ok ? r.body : false
    }, 60_000, 2000)
    check('the re-seed passes its preflight: the server went back', !!pre && pre.wentBack?.reason, pre ? JSON.stringify(pre.wentBack) : JSON.stringify((await asAdmin('POST', `/org/${orgId}/moves/reseed/preflight`, {})).body?.checks?.filter((c: any) => !c.ok)))
    const wrongSlug = await asAdmin('POST', `/org/${orgId}/moves/reseed`, { slug: 'move-e2e-x' })
    check('…not without the slug typed', wrongSlug.status === 422 && wrongSlug.body?.code === 'slug_mismatch', `${wrongSlug.status} ${wrongSlug.body?.code}`)
    const started = await asAdmin('POST', `/org/${orgId}/moves/reseed`, { slug: 'move-e2e' })
    check('the admin starts the re-seed', started.status === 200 && started.body?.move?.kind === 'reseed' && started.body?.move?.state === 'copying', JSON.stringify(started.body))
    const rDone = await until(async () => {
      const r = await asAdmin('GET', `/org/${orgId}/moves/current`)
      return r.body?.move?.kind === 'reseed' && ['done', 'aborted'].includes(r.body.move.state) ? r.body.move : false
    }, 240_000, 2000)
    check('the re-seed ends done: the copy built, kept and taken, verified, flipped', !!rDone && rDone.state === 'done', JSON.stringify(rDone ? { state: rDone.state, error: rDone.error, steps: rDone.steps?.map((x: any) => x.name), replaced: rDone.replaced } : 'no end'))
    check('…it says what the server held that lgrai.app lacked', (rDone?.replaced?.onlyThere ?? 0) >= 1 && (rDone?.replaced?.documents ?? 0) > 0, JSON.stringify(rDone?.replaced))
    const unfrozen = await until(async () => ((await mdb.collection('org_homes').findOne({ orgId })) as any)?.state === 'active', 60_000)
    check('the master is the org\'s home still, unfrozen, at the same epoch', !!unfrozen && ((await mdb.collection('org_homes').findOne({ orgId })) as any)?.epoch === 1)
    check('what was made since the snapshot came back', !!(await mdb.collection('contacts').findOne({ _id: madeAfter })))
    check('what was deleted since stays deleted', !(await mdb.collection('contacts').findOne({ _id: deletedAfter._id })))
    const keptFile = join(DATA, 'uploads', String(orgId), 'docs', 'reseed', `${rDone?.id}.ndjson.zst`)
    check('what the master held is kept, for good, under the org\'s documents', existsSync(keptFile) && zlib.zstdDecompressSync(readFileSync(keptFile)).toString('utf8').includes('Written at the shop 3'))
    check('…and its went-back record is cleared', !((await mdb.collection('repl_orgs').findOne({ orgId })) as any)?.wentBack)
    const still: any = await mdb.collection('org_homes').findOne({ orgId })
    check('legal numbering stays locked until the site\'s last numbers are recorded', !!still?.seriesFrozen?.since, JSON.stringify(still?.seriesFrozen ?? null))
    // The mirror's chain starts again from the master, and nothing on it was deleted.
    await caughtUp('the mirror follows the master again, on a new chain', 240_000)
    check('…nothing on the mirror was deleted', !!(await gdb.collection('contacts').findOne({ _id: madeAfter })) && (await gdb.collection('contacts').countDocuments({ orgId })) === (await mdb.collection('contacts').countDocuments({ orgId })))
    await mdb.collection('contacts').insertOne({ _id: new mongoose.Types.ObjectId(), orgId, companyName: 'Written after the re-seed', type: 'customer', isActive: true })
    await caughtUp('what the shop writes after the re-seed reaches the mirror')
    const stAfter: any = await gdb.collection('mirror_state').findOne({ orgId })
    check('global raised no alarm on the new chain', !(stAfter?.alarms ?? []).length, JSON.stringify(stAfter?.alarms ?? []))
  }

  if (RECONCILE) {
    // ── FR-20.70 (P3-7f): the master loses the record of its changes; the copy is made equal to it ──
    // Tags the shop made, and an issued sale, reach the mirror.
    const tagIds = [0, 1, 2].map(() => new mongoose.Types.ObjectId())
    await mdb.collection('tags').insertMany(tagIds.map((_id, i) => ({ _id, orgId, type: 'contact', value: `dropped-${i}`, createdAt: new Date(), updatedAt: new Date() })))
    const saleId = new mongoose.Types.ObjectId()
    await mdb.collection('invoices').insertOne({ _id: saleId, orgId, invoiceNumber: 'INV-2026-00077', status: 'sent', type: 'invoice', direction: 'outgoing', currency: 'EUR', lines: [], subtotal: 1, taxTotal: 0, total: 1, issueDate: new Date(), dueDate: new Date(), createdAt: new Date(), updatedAt: new Date() })
    await caughtUp('the tags and the issued sale reach the mirror')
    const epochBefore = Number(((await mdb.collection('repl_engine').findOne({ _id: 'engine' as any })) as any)?.journalEpoch ?? 1)
    // The sale goes on the master where the capture does not see it: the org out of the capture, as for the disk above.
    await mdb.collection('repl_orgs').updateOne({ orgId }, { $set: { enabled: false } })
    await Bun.sleep(2_000)
    await mdb.collection('invoices').deleteOne({ _id: saleId })
    await Bun.sleep(3_000)
    await mdb.collection('repl_orgs').updateOne({ orgId }, { $set: { enabled: true } })
    // Then a captured collection is dropped there: a change stream says nothing of what went with it,
    // so the tailer starts a new journal epoch and journals every document again.
    await mdb.collection('tags').drop()
    const epoch = await until(async () => {
      const e: any = await mdb.collection('repl_engine').findOne({ _id: 'engine' as any })
      return Number(e?.journalEpoch ?? 1) > epochBefore ? Number(e.journalEpoch) : false
    }, 60_000)
    check('a captured collection dropped on the master starts a new journal epoch there', !!epoch, `epoch ${epochBefore} → ${epoch}`)
    const started = await until(async () => {
      const st: any = await gdb.collection('mirror_state').findOne({ orgId })
      return st?.journalEpoch === epoch && st?.reconcile?.journalEpoch === epoch ? st.reconcile : false
    }, 120_000, 2000)
    check('lgrai.app takes the new epoch\'s pages, which continue its chain, and starts reconciling its copy', !!started, JSON.stringify(started))
    const done: any = await until(async () => {
      const st: any = await gdb.collection('mirror_state').findOne({ orgId })
      return st?.reconcile?.doneAt ? st.reconcile : false
    }, 240_000, 2000)
    check('the reconcile ends done: the master journaled every id of the copy again, and the copy got there', !!done, JSON.stringify(done && { head: done.head, asked: done.asked, deleted: done.deleted, kept: done.kept?.length }))
    check('the dropped tags are gone from the copy', (await gdb.collection('tags').countDocuments({ orgId })) === 0)
    check('the issued sale the master no longer has stays on the copy, named, with an alarm', !!(await gdb.collection('invoices').findOne({ _id: saleId })) && (done?.kept ?? []).some((k: any) => k.number === 'INV-2026-00077') && (((await gdb.collection('mirror_state').findOne({ orgId })) as any)?.alarms ?? []).some((a: any) => a.kind === 'sale_kept'))
    const repl: any = await mdb.collection('repl_orgs').findOne({ orgId })
    check('the master marks the epoch reconciled', repl?.reconciledEpoch === epoch && !repl?.reconcile, JSON.stringify({ reconciledEpoch: repl?.reconciledEpoch, reconcile: repl?.reconcile }))
    // Apart from the sale it keeps, the copy is the master's again, document for document.
    const sorted = (d: Record<string, Record<string, string>>) => JSON.stringify(Object.fromEntries(Object.keys(d).sort().map(c => [c, Object.fromEntries(Object.entries(d[c]).sort(([a], [b]) => a.localeCompare(b)))])))
    const sameButTheSale = async () => {
      const g = await digest(gdb)
      if (g.invoices) delete g.invoices[idKey(saleId)]
      if (g.invoices && !Object.keys(g.invoices).length) delete g.invoices
      return sorted(await digest(mdb)) === sorted(g)
    }
    check('apart from that sale, the copy is the master\'s again, document for document', await sameButTheSale())
    const open: any = await mdb.collection('org_homes').findOne({ orgId })
    check('the master\'s legal numbering stays open: it lost a record of its changes, not its data', !open?.seriesFrozen, JSON.stringify(open?.seriesFrozen ?? null))
    await mdb.collection('contacts').insertOne({ _id: new mongoose.Types.ObjectId(), orgId, companyName: 'Written after the reconcile', type: 'customer', isActive: true })
    const after = await until(async () => (await mirrorAt()) >= (await headOf()) && (await sameButTheSale()), 120_000, 1500)
    check('what the shop writes next reaches the copy', !!after, `journal head ${await headOf()}, mirror ${await mirrorAt()}`)

    // ── FR-20.65 (P3-2c): a document lgrai.app cannot write is set aside, and the org goes on ────────
    // Another org on lgrai.app holds the id the shop's next contact gets (an org copied under another id).
    const clash = new mongoose.Types.ObjectId()
    const otherOrg = new mongoose.Types.ObjectId()
    await gdb.collection('contacts').insertOne({ _id: clash, orgId: otherOrg, companyName: 'Another org\'s', type: 'customer', isActive: true })
    await mdb.collection('contacts').insertOne({ _id: clash, orgId, companyName: 'The shop\'s', type: 'customer', isActive: true })
    const afterClash = new mongoose.Types.ObjectId()
    await mdb.collection('contacts').insertOne({ _id: afterClash, orgId, companyName: 'Written after the clash', type: 'customer', isActive: true })
    const through = await until(async () => (await mirrorAt()) >= (await headOf()) && !!(await gdb.collection('contacts').findOne({ _id: afterClash })), 120_000, 1500)
    check('a document whose id another org holds on lgrai.app does not stop the org: what follows reaches the copy', !!through, `journal head ${await headOf()}, mirror ${await mirrorAt()}`)
    const letter: any = await gdb.collection('mirror_dead_letters').findOne({ orgId, docId: clash })
    check('…it is set aside, and the other org\'s document is untouched', letter?.status === 'open' && letter.reason === 'foreign_collision' && ((await gdb.collection('contacts').findOne({ _id: clash })) as any)?.orgId?.equals(otherOrg), JSON.stringify(letter && { status: letter.status, reason: letter.reason, attempts: letter.attempts }))
    const back = await asAdmin('POST', `/org/${orgId}/moves/preflight`, { to: 'global' })
    const whole = (back.body?.checks ?? []).find((c: any) => c.name === 'mirror_whole')
    check('…and a move back waits for it', whole?.ok === false, JSON.stringify(whole))
    const shown = await asAdmin('GET', `/org/${orgId}/nodes/mirror`)
    check('…which the Servers page lists', shown.body?.mirror?.deadLetters?.open === 1 && shown.body.mirror.deadLetters.items?.[0]?.reason === 'foreign_collision', JSON.stringify(shown.body?.mirror?.deadLetters))
  }

  if (!PROMOTE && !RESEED && !RECONCILE) {
    // ── FR-20.51 (P3-7): a master that never went back keeps its numbering open ─────────────────────
    // Its boot check and its minute tick (the journal's mark, lgrai.app's alarms) have run by now.
    await Bun.sleep(65_000)
    const open: any = await mdb.collection('org_homes').findOne({ orgId })
    check('the master\'s legal numbering stays open: no restore, no clone, no history gone back', !open?.seriesFrozen && existsSync(join(DATA, 'state', 'journal-hwm.json')), JSON.stringify(open?.seriesFrozen ?? null))

    // ── FR-20.80 (P3-6c): back to lgrai.app ─────────────────────────────────────────────────────────
    // A document the shop makes on the master, with its file: global gets the file by content.
    const made = randomBytes(40_000)
    const madeRel = `${String(orgId)}/docs/2026-10-27/made-at-the-shop.pdf`
    mkdirSync(join(DATA, 'uploads', String(orgId), 'docs', '2026-10-27'), { recursive: true })
    writeFileSync(join(DATA, 'uploads', ...madeRel.split('/')), made)
    const madeSha = createHash('sha256').update(made).digest('hex')
    await mdb.collection('docfiles').insertOne({ _id: new mongoose.Types.ObjectId(), orgId, docType: 'invoice', docNumber: 'made-at-the-shop', docDate: '2026-10-27', originalName: 'made-at-the-shop.pdf', currentPath: madeRel, currentChecksum: madeSha, version: 1, mimeType: 'application/pdf', size: made.length, status: 'uploaded', uploadedAt: new Date() })
    const backReady = await until(async () => {
      const r = await asAdmin('POST', `/org/${orgId}/moves/preflight`, { to: 'global' })
      return r.status === 200 && r.body.ok ? r.body : false
    }, 120_000, 2000)
    check('the move back passes its preflight', !!backReady, backReady ? '' : JSON.stringify((await asAdmin('POST', `/org/${orgId}/moves/preflight`, { to: 'global' })).body?.checks?.filter((c: any) => !c.ok)))
    const back = await asAdmin('POST', `/org/${orgId}/moves/`, { to: 'global' })
    check('the admin starts the move back', back.status === 200 && back.body?.move?.kind === 'to_global' && back.body?.move?.state === 'freezing', JSON.stringify(back.body))
    const mFrozen = await until(async () => ((await mdb.collection('org_homes').findOne({ orgId })) as any)?.state === 'freezing', 60_000)
    check('…the master freezes the org', !!mFrozen)
    const backDone = await until(async () => {
      const r = await asAdmin('GET', `/org/${orgId}/moves/current`)
      return r.body?.move && ['done', 'aborted'].includes(r.body.move.state) ? r.body.move : false
    }, 300_000, 2000)
    check('the move back ends done: drained, verified, the files put back, flipped', !!backDone && backDone.state === 'done', JSON.stringify(backDone ? { state: backDone.state, error: backDone.error, steps: backDone.steps?.map((x: any) => x.name), placed: backDone.placed } : 'no end'))
    const gBack: any = await gdb.collection('org_homes').findOne({ orgId })
    check('global is the org\'s home again, one epoch up', gBack?.home === 'global' && gBack?.epoch === 2 && gBack?.state === 'active', JSON.stringify(gBack && { home: gBack.home, epoch: gBack.epoch, state: gBack.state }))
    const mBack = await until(async () => {
      const h: any = await mdb.collection('org_homes').findOne({ orgId })
      return h?.home === 'global' ? h : false
    }, 60_000)
    check('the master leaves it, at that epoch, keeping a read-only copy', !!mBack && (mBack as any).epoch === 2 && (mBack as any).state === 'active' && (await mdb.collection('contacts').countDocuments({ orgId })) > 0)
    const placedFile = join(GLOBAL_UPLOADS, ...madeRel.split('/'))
    check('the file the shop made is on global where its row says', existsSync(placedFile) && createHash('sha256').update(readFileSync(placedFile)).digest('hex') === madeSha)
    const writeBack = await asAdmin('POST', `/org/${orgId}/invoicing/contact`, { type: 'customer', companyName: 'Written on lgrai.app again' })
    check('global writes the org again', writeBack.status === 200, `${writeBack.status} ${writeBack.body?.code ?? ''}`)
    check('…and keeps no mirror state or content store for it', (await gdb.collection('mirror_state').countDocuments({ orgId })) === 0 && (await gdb.collection('mirror_blobs').countDocuments({ orgId })) === 0)
    // An org that lives on lgrai.app has no address there: its label answers like an unknown one.
    const unrouted = await until(async () => (await viaAddress('/', { headers: { accept: 'text/html' } })).status === 404, 30_000, 2000)
    check('its address stops reaching the server once the org is home on lgrai.app', !!unrouted)
    const leftAudit = await until(() => gdb.collection('auditlogs').findOne({ orgId, entityType: 'org_move', entityName: 'to lgrai.app' }), 10_000)
    check('the org\'s trail, written on the master before the freeze, came back with it', !!leftAudit)
  }
} catch (e) {
  failed++
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`)
  console.log(globalLog.split('\n').filter(l => /Move|move|error|ERROR|warn/i.test(l)).slice(-30).join('\n'))
  console.log(supLog.split('\n').filter(l => /WARN|ERROR|move|Move/i.test(l)).slice(-30).join('\n'))
  try {
    console.log(readFileSync(join(DATA, 'logs', 'api.log'), 'utf8').split('\n').filter(l => /Move|"level":(40|50)/.test(l)).slice(-30).join('\n'))
  } catch { /* no API log */ }
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
