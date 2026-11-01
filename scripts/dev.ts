#!/usr/bin/env bun
/**
 * Dev launcher — starts the unified API and the one SPA's Vite dev server in one process (FR-24.23).
 * The Vite server proxies `/api` and `/ws` to the API (`packages/web/vite.config.ts`), so the app
 * runs on one origin, as in production.
 *
 * Replaces the `a & b & c` chaining in package.json, which Bun's shell rejects
 * on Windows ("Background commands \"&\" are not supported yet").
 *
 * Usage:
 *   bun run dev                    # API + the web app
 *   bun run dev -- api             # just the API
 *   bun run dev -- --list          # show available services
 */

const RESET = '\x1b[0m'

type Service = {
  name: string
  cwd: string
  port: number
  color: string
}

const SERVICES: Service[] = [
  { name: 'api', cwd: 'packages/portal-api', port: 4001, color: '\x1b[36m' },
  // FR-24: the one SPA, the portal and every module in one app.
  { name: 'web', cwd: 'packages/web', port: 4200, color: '\x1b[97m' },
]

/** Child output is colourised, so strip ANSI before pattern-matching it. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * Two sources of unavoidable boot spam:
 *  - Bun's --watch walks the whole monorepo import graph and warns once per
 *    cross-package file (~180 lines on every API boot).
 *  - Node warns that FORCE_COLOR overrides NO_COLOR, once per vite child.
 */
const NOISE = [
  /^warn: File .* will not be watched$/,
  /NO_COLOR' env is ignored due to the 'FORCE_COLOR'/,
  /^\(Use `node --trace-warnings/,
  /^at (warnOnDeactivatedColors|getColorDepth|shouldColorize|refresh|internal:|loadAssertionError)/,
]

const isNoise = (line: string) => {
  const clean = stripAnsi(line).trim()
  return clean !== '' && NOISE.some((re) => re.test(clean))
}

const args = process.argv.slice(2)

if (args.includes('--list')) {
  for (const s of SERVICES) console.log(`${s.color}${s.name}${RESET}\t${s.port}\t${s.cwd}`)
  process.exit(0)
}

const wanted = args.filter((a) => !a.startsWith('-'))
const selected = wanted.length
  ? SERVICES.filter((s) => wanted.includes(s.name))
  : SERVICES

if (!selected.length) {
  console.error(`No service matched: ${wanted.join(', ')}`)
  console.error(`Available: ${SERVICES.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

const width = Math.max(...selected.map((s) => s.name.length))
const procs: { service: Service; proc: Bun.Subprocess }[] = []

/** Prefix every line with a padded, coloured service label. */
async function pump(service: Service, stream: ReadableStream<Uint8Array>) {
  const label = `${service.color}${service.name.padEnd(width)}${RESET} │ `
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (isNoise(line.trim())) continue
      console.log(label + line)
    }
  }
  if (buffer.trim() && !isNoise(buffer.trim())) console.log(label + buffer)
}

for (const service of selected) {
  const proc = Bun.spawn(['bun', 'run', 'dev'], {
    cwd: service.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Children write to a pipe, not a TTY, so they'd drop colour without this.
    // NO_COLOR must go or Node warns about the conflict once per child.
    env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: '1' },
    onExit(_p, exitCode) {
      console.log(`${service.color}${service.name}${RESET} exited with code ${exitCode}`)
    },
  })
  procs.push({ service, proc })
  pump(service, proc.stdout as ReadableStream<Uint8Array>)
  pump(service, proc.stderr as ReadableStream<Uint8Array>)
}

console.log(`\nStarting ${selected.length} service(s):`)
for (const s of selected) {
  const url = `http://localhost:${s.port}`
  console.log(`  ${s.color}${s.name.padEnd(width)}${RESET} ${url}`)
}
console.log(`\nOpen the app at http://localhost:4200 — Ctrl+C stops everything.\n`)

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nShutting down...')

  for (const { proc } of procs) {
    // `bun run dev` spawns vite as a grandchild; killing only the direct child
    // leaves the port bound. taskkill /T walks the tree on Windows.
    if (process.platform === 'win32') {
      try {
        Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      } catch {
        proc.kill()
      }
    } else {
      proc.kill()
    }
  }
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await Promise.all(procs.map(({ proc }) => proc.exited))
