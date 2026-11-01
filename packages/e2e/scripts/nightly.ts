/**
 * The whole Playwright suite against this checkout, on a database of its own (#365). It is what
 * `.github/workflows/e2e-nightly.yml` runs, and it runs the same anywhere:
 *
 *   bun run build
 *   bun packages/tests/src/with-test-mongo.ts bun packages/e2e/scripts/nightly.ts [playwright args]
 *
 * `with-test-mongo.ts` owns the replica set. This seeds it, starts the OCR stub, the Eltrade stub and
 * the server, runs Playwright, and stops all three whatever Playwright says. Its exit code is
 * Playwright's.
 */
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..')
const PORT = process.env.E2E_PORT || '4987'
const BASE_URL = `http://127.0.0.1:${PORT}`

const replSet = process.env.LGR_TEST_MONGO_URI
if (!replSet) {
  console.error('nightly: no LGR_TEST_MONGO_URI, so run this through packages/tests/src/with-test-mongo.ts')
  process.exit(2)
}
const env = {
  ...process.env,
  // The replica set's own address and options, with the database the seed and the server use.
  MONGODB_URI: replSet.replace(/\/(\?|$)/, '/lgr$1'),
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT,
  OCR_SERVER_URL: 'http://localhost:8199',
  // The Eltrade stub is on loopback, which `fiscal/tcp-target.ts` refuses without this.
  FISCAL_TCP_ALLOW_LOOPBACK: '1',
}

const running: ReturnType<typeof Bun.spawn>[] = []
function start(cmd: string[], cwd = ROOT) {
  const child = Bun.spawn(cmd, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
  running.push(child)
  return child
}
function stopAll() {
  for (const child of running) child.kill()
}
// A cancelled job signals this process: without this the three would outlive it on a runner.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopAll(); process.exit(1) })

async function waitForServer(server: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode} before it was ready`)
    const ok = await fetch(`${BASE_URL}/api/health`).then(r => r.ok, () => false)
    if (ok) return
    await Bun.sleep(1000)
  }
  throw new Error(`the server did not answer ${BASE_URL}/api/health within 120 s`)
}

/**
 * FR-24.16/24.21: the suite runs against the one SPA (its assets under `/ui/`, FR-24.10). A server
 * that answered no shell, or another one, would make every spec fail for a reason no spec names.
 */
async function assertShell() {
  const html = await fetch(`${BASE_URL}/invoicing/`).then(r => r.text())
  if (!/(src|href)="\/ui\//.test(html)) throw new Error('the server does not serve the web app (packages/web): run `bun run build` first')
  console.log('nightly: serving the web app')
}

let code = 1
try {
  const seed = Bun.spawn(['bun', '--env-file=.env.test', 'run', 'packages/tests/src/helpers/seed.ts'], {
    cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  })
  if ((await seed.exited) !== 0) throw new Error('the seed failed')

  start(['bun', 'packages/e2e/scripts/ocr-stub.ts'])
  start(['bun', 'packages/e2e/scripts/eltrade-tcp-stub.ts'])
  const server = start(['bun', '--env-file=../../.env.test', 'src/unified.ts'], join(ROOT, 'packages', 'portal-api'))
  await waitForServer(server)
  await assertShell()

  // One worker: the suite shares this one seeded database, and specs that each pass alone fail
  // beside each other (CLAUDE.md, E2E gotcha 5).
  const playwright = Bun.spawn(
    ['bunx', 'playwright', 'test', '--workers=1', '--reporter=line,html,./scripts/night-summary.ts', ...process.argv.slice(2)],
    {
      cwd: join(ROOT, 'packages', 'e2e'),
      env: { ...env, BASE_URL, PLAYWRIGHT_HTML_OPEN: 'never' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  code = await playwright.exited
} catch (e) {
  console.error(`nightly: ${e instanceof Error ? e.message : e}`)
} finally {
  stopAll()
}
process.exit(code)
