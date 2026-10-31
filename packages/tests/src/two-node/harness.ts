import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chaosProxy, type ChaosProxy } from './chaos-proxy'
import { makeTestCa, tlsFront, type TestCa, type TlsFront } from './tls-front'

/**
 * The two-node harness (FR-20 plan Part F.2, step T-1): a `global` and a `master`, each its own
 * process on its own replica set, and between them the link a shop actually has.
 *
 *   MongoMemoryReplSet A ◄── global (LGR_NODE_ROLE=global) ◄── TLS front ◄── chaos proxy ◄── uplinkUrl
 *   MongoMemoryReplSet B ◄── master (LGR_NODE_ROLE=master)
 *
 * The master's side reaches global at `uplinkUrl` (`https://localhost:<chaos>`), with the run's CA,
 * so the uplink speaks HTTPS/WSS through a proxy a test can cut, slow or blackhole.
 *
 * With `LGR_SERVER_PACKAGE` (a `build:server` output) both nodes run the PACKAGE, as a master does;
 * without it they run from source.
 */

const REPO = resolve(import.meta.dir, '..', '..', '..', '..')

export interface Node {
  readonly role: 'global' | 'master'
  /** `http://127.0.0.1:<port>`: the node's own API, directly. */
  readonly url: string
  readonly mongoUri: string
  /** Where its Files app keeps bytes. */
  readonly uploadDir: string
  /** What the node was started with, its own keys included. */
  readonly env: Readonly<Record<string, string>>
  /** Its exit code, once it has exited. */
  readonly exited: Promise<number>
  /** The last of what it printed. */
  log(): string
  stop(): Promise<void>
}

export interface NodeOptions {
  /** Added to (and over) the environment the node gets. */
  env?: Record<string, string>
  /** Sent with the readiness probe: a node behind a front answers nothing without its secret. */
  probeHeaders?: Record<string, string>
  /** FR-24.54: a database another node shares (two pods of one global). Not stopped with this node. */
  mongoUri?: string
}

export interface TwoNodes {
  readonly global: Node
  readonly master: Node
  /** Between the master and global. */
  readonly chaos: ChaosProxy
  /** How the master reaches global: through the chaos proxy, then TLS. */
  readonly uplinkUrl: string
  /** The run's CA: what a client trusts to reach `uplinkUrl`. */
  readonly ca: TestCa
  stop(): Promise<void>
}

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64')
const freePort = () => { const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p }

function packageDir(): string | undefined {
  const p = process.env.LGR_SERVER_PACKAGE
  return p ? (resolve(REPO, p)) : undefined
}

export async function startNode(role: 'global' | 'master', scratch: string, opts: NodeOptions = {}): Promise<Node> {
  const mongo = opts.mongoUri ? null : await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const mongoUri = opts.mongoUri ?? mongo!.getUri('lgr')
  const port = freePort()
  const url = `http://127.0.0.1:${port}`
  const uploadDir = join(scratch, `${role}-uploads`)
  const pkg = packageDir()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    NODE_ENV: 'production',
    LGR_NODE_ROLE: role,
    MONGODB_URI: mongoUri,
    PORT: String(port),
    HOST: '127.0.0.1',
    // Each node its own keys: a token one node signs is nothing to the other.
    JWT_SECRET: random(),
    DESKTOP_TOKEN_SECRET: random(),
    NODE_TOKEN_SECRET: random(),
    OAUTH_FRONTEND_URL: url,
    UPLOAD_DIR: uploadDir,
    MIGRATIONS_AUTO: 'true',
    // No scheduler fires during a cell: no digest, backup, retention or reaper of its own accord.
    DIGEST_CHECK_INTERVAL_MS: '0',
    BACKUP_CHECK_INTERVAL_MS: '0',
    RETENTION_CHECK_INTERVAL_MS: '0',
    DESKTOP_REAPER_INTERVAL_MS: '0',
    NODE_REAPER_INTERVAL_MS: '0',
    ...(pkg ? { LGR_UI_ROOT: join(pkg, 'ui') } : {}),
    // Where the other pods reach this one (tunnel/pod.ts): its own listener.
    LGR_POD_ADDR: url,
    ...opts.env,
  })
  const cmd = pkg ? ['bun', join(pkg, 'app', 'server.js')] : ['bun', 'src/unified.ts']
  const cwd = pkg ? pkg : join(REPO, 'packages', 'portal-api')
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  let log = ''
  const collect = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) log = (log + new TextDecoder().decode(c)).slice(-20_000) }
  void collect(proc.stdout)
  void collect(proc.stderr)

  const deadline = Date.now() + 120_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${role} exited (${proc.exitCode}) before it answered:\n${log.slice(-3000)}`)
    const up = await fetch(`${url}/api/health`, { headers: opts.probeHeaders }).then(r => r.status === 200, () => false)
    if (up) break
    if (Date.now() > deadline) throw new Error(`${role} did not answer /api/health within 120 s:\n${log.slice(-3000)}`)
    await Bun.sleep(250)
  }
  return {
    role,
    url,
    mongoUri,
    uploadDir,
    env,
    exited: proc.exited,
    log: () => log,
    async stop() {
      proc.kill()
      await proc.exited
      await mongo?.stop()
    },
  }
}

export async function startTwoNodes(): Promise<TwoNodes> {
  const scratch = mkdtempSync(join(tmpdir(), 'lgr-two-node-'))
  const ca = makeTestCa(join(scratch, 'ca'))
  const [global, master] = await Promise.all([startNode('global', scratch), startNode('master', scratch)])
  const front: TlsFront = tlsFront({ hostname: '127.0.0.1', port: Number(new URL(global.url).port) }, ca)
  const chaos = await chaosProxy({ hostname: '127.0.0.1', port: front.port })
  return {
    global,
    master,
    chaos,
    uplinkUrl: `https://localhost:${chaos.port}`,
    ca,
    async stop() {
      await chaos.close()
      front.close()
      await Promise.all([global.stop(), master.stop()])
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

/** A fetch that trusts the run's CA, as the uplink does. */
export function uplinkFetch(nodes: TwoNodes, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init
  return fetch(`${nodes.uplinkUrl}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs), tls: { ca: nodes.ca.ca } } as any)
}

/**
 * FR-24.54: two pods of one global, on one database, as Kubernetes runs them with `replicas: 2`.
 * The same secrets (a token one pod signs is good on the other, as behind one Service), each its own
 * process, port and `LGR_POD_ADDR`. Neither has a front: global's pods answer directly.
 */
export interface TwoPods {
  readonly a: Node
  readonly b: Node
  readonly mongoUri: string
  /** Shared by both pods: what a test signs a session with. */
  readonly jwtSecret: string
  stop(): Promise<void>
}

export async function startTwoPods(): Promise<TwoPods> {
  const scratch = mkdtempSync(join(tmpdir(), 'lgr-two-pods-'))
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const mongoUri = mongo.getUri('lgr')
  const shared = { JWT_SECRET: random(), DESKTOP_TOKEN_SECRET: random(), NODE_TOKEN_SECRET: random(), UPLOAD_DIR: join(scratch, 'uploads') }
  // One after the other: both would run the migrations at once otherwise (the lock makes one wait).
  const a = await startNode('global', scratch, { mongoUri, env: shared })
  const b = await startNode('global', scratch, { mongoUri, env: shared })
  return {
    a,
    b,
    mongoUri,
    jwtSecret: shared.JWT_SECRET,
    async stop() {
      await Promise.all([a.stop().catch(() => undefined), b.stop().catch(() => undefined)])
      await mongo.stop()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}
