/**
 * The move to a master end to end (FR-20.79, plan step P3-6a), with real processes: an org on a
 * local global (the API in role global, behind T-1's TLS front and chaos proxy), and a real
 * `lgr-server` (its own `mongod`, the API from the built package) registered for it at Full. The
 * org's admin moves it there over HTTP; global freezes it, builds the copy, the master's API takes
 * it through the supervisor's egress, and the flip makes the master its home. The mirror then
 * starts again from the move, and ends equal to the master, document for document.
 *
 * Then back (FR-20.80, plan step P3-6c): the shop makes a document with a file on the master, the
 * admin moves the org back to lgrai.app, the master freezes it and drains, global puts the file
 * where its row says and flips, and the master keeps a read-only copy.
 *
 * Or, with `--promote` (FR-20.81 and FR-20.84, plan steps P3-6d and P3-6e): the shop makes a
 * document with a file, then its link is CUT, and it goes on selling (a sale numbered past what the
 * site will read off its paper). The admin promotes lgrai.app's copy on evidence; global puts the file
 * where its row says and flips with the legal series frozen; numbering resumes above the site's last
 * numbers once recorded, and gives the sale's number to another. The link comes back: the server
 * learns of it, fences itself, and exports everything above the cutoff, which reaches global for
 * review with that collision named.
 *
 *   bun packages/tests/src/two-node/move-e2e.script.ts [--promote]
 *
 * Needs: `cargo build` (packages/server), `bun run build` + `bun run build:server` (dist/lgr-server).
 * About three minutes. Passwords and keys are read, never printed. Exit 0 when every check passed.
 */
import { MongoBinary, MongoMemoryReplSet } from 'mongodb-memory-server'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { makeTestCa, tlsFront } from './tls-front'
import { chaosProxy } from './chaos-proxy'
import { PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { Identity, OnpremCredential, User } from 'db/models'
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
    const series = (await asAdmin('GET', `/org/${orgId}/moves/last-numbers`)).body?.series ?? []
    const recorded = await asAdmin('POST', `/org/${orgId}/moves/last-numbers`, { series: series.map((x: any) => ({ ...x, last: x.prefix === 'SALES_DOC' ? 500 : x.last })) })
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
    check('…holding the sale and the customer it made with the link down', arrived?.summary?.byColl?.invoices >= 1 && arrived?.summary?.byColl?.contacts >= 1 && (arrived?.summary?.legal ?? []).some((l: any) => l.id === String(lateSale) && l.number === 'INV-2026-00501'))
    const here = join(DATA, 'uploads', String(orgId), 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)
    const there = join(GLOBAL_UPLOADS, String(orgId), 'docs', 'fenced', `fenced-${moveId}.ndjson.zst`)
    const shaOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
    check('…kept on both sides, the same bytes', existsSync(here) && existsSync(there) && shaOf(here) === arrived?.sha256 && shaOf(there) === arrived?.sha256)
    const review = await asAdmin('GET', `/org/${orgId}/moves/fenced-exports`)
    const listed = review.body?.exports?.[0]?.legal?.find((l: any) => l.id === String(lateSale))
    check('the review names the sale whose number lgrai.app gave to another', review.status === 200 && listed?.onGlobal === 'collision' && listed?.collidesWith?.id === String(issued.body?.invoice?.id ?? issued.body?.invoice?._id), JSON.stringify(listed))
    check('…and writes none of it into the org', !(await gdb.collection('invoices').findOne({ _id: lateSale })))
    await Bun.sleep(15_000)
    check('its pump sends nothing more of the org: lgrai.app keeps no mirror of it', (await gdb.collection('mirror_state').countDocuments({ orgId })) === 0)
  }

  if (!PROMOTE) {
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
