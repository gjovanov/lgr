import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Driving the real shell binary over WebView2's CDP endpoint (C15 §3).
 *
 * ⚠ **A helper module, not the spec.** A spec file in this package cannot `import type` from
 * `@playwright/test` — the build dies with an opaque `BuildMessage {}` (C15 trap 2) — so every
 * type-importing line lives here.
 *
 * ⚠ **The HARNESS opens the debugging port, never the app** (C15 trap 12). An app that opened one
 * itself would ship a debugging port to customers. It arrives through
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which the spec sets on the child it spawns.
 */

/** Where the shell keeps everything on this machine (`paths.rs`, `keystore::secure_dir`). */
export function appDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'com.lgr.desktop')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.lgr.desktop')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'com.lgr.desktop')
}

export function logFile(): string {
  return path.join(appDataDir(), 'logs', 'lgr-desktop.log')
}

/**
 * Put the machine back to "never ran" — settings, the identity directory and the logs.
 *
 * ⚠ The identity directory matters most: a key left behind from an earlier run makes the shell
 * report `registered` against a stub hub that has never heard of it, and the onboarding assertions
 * then test nothing. The lanes get a fresh VM; this is the local equivalent.
 */
export function resetAppState(): void {
  fs.rmSync(appDataDir(), { recursive: true, force: true })
}

/** Point the shell at the stub hub before it starts, so its first probe already goes there. */
export function writeSettings(serverUrl: string, extra: Record<string, unknown> = {}): void {
  const dir = appDataDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      serverUrl,
      desktopName: 'E2E-TILL',
      autostart: false,
      openLgrOnLaunch: false,
      openInSystemBrowser: false,
      // ⚠ Off for the harness: the first background check would otherwise land five minutes into
      // a long walk and write update lines into a log the specs assert on.
      autoUpdate: false,
      proxy: '',
      locale: 'en',
      logLevel: 'info',
      ...extra,
    }, null, 2),
  )
}

export interface ShellProcess {
  child: ChildProcess
  /** Everything the binary wrote to stderr — the log goes there too (`logs.rs`). */
  stderr: () => string
  /** Why the child is gone, if it is: a spawn error or an exit code. */
  died: () => string | null
  /**
   * The WebView2 variables as passed to THIS child.
   *
   * ⚠ Not `process.env`. The diagnostics used to read the runner's own environment, which the
   * workflow also sets — so the line was reassuring about the wrong process and could not have
   * caught a harness that failed to forward the variable at all.
   */
  webview2Env: Record<string, string>
  stop: () => void
}

/**
 * Launch the shell with a debugging port.
 *
 * ⚠ `--view=` is an allow-list in the binary (C08), so passing one here also exercises that: an
 * unknown value produces no view line rather than a route.
 */
export function launchShell(bin: string, port: number, args: string[] = []): ShellProcess {
  // ⚠ Checked BEFORE spawning. A wrong `LGR_DESKTOP_BIN` otherwise surfaced 60 s later as "no CDP
  // endpoint on 9222", which points at the debugging port — the one thing that was fine. CI hit
  // exactly that, and the real reason was nowhere in the output.
  if (!fs.existsSync(bin)) {
    throw new Error(
      `LGR_DESKTOP_BIN does not exist: ${bin}\n` +
      `Contents of ${path.dirname(bin)}: ${listDir(path.dirname(bin))}`,
    )
  }

  let buf = ''
  let dead: string | null = null
  // ⚠ **Two things were ruled OUT by experiment on 2026-10-07, so do not re-guess them**, with
  // the installed 0.1.4 on WebView2 **154.0.4258.62 — the same runtime the runner has**:
  //  · wry sets `AdditionalBrowserArguments` itself (`--disable-features=msWebOOUI,…`), and the
  //    docs say that option takes precedence over this variable. It does NOT: the browser
  //    process came up carrying both, so the variable is appended, not overridden.
  //  · Chromium's "no remote debugging on the default user data directory" rule does not bite
  //    here either — the port opened with `--user-data-dir` pointing at the app's own default
  //    `EBWebView` folder. Setting `WEBVIEW2_USER_DATA_FOLDER` is therefore not the fix it looks
  //    like, and shipping it as one would have been a guess wearing a fix's clothes.
  const webview2Env = {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  }
  const child = spawn(bin, args, {
    env: { ...process.env, ...webview2Env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', d => { buf += String(d) })
  child.stderr?.on('data', d => { buf += String(d) })
  // ⚠ Both, because they are different failures and both were invisible: `error` is "it never
  // started", `exit` is "it started and gave up".
  child.on('error', e => { dead = `the process could not be started: ${e.message}` })
  child.on('exit', (code, signal) => {
    dead = `the process exited (code=${code} signal=${signal})`
  })
  return {
    child,
    stderr: () => buf,
    died: () => dead,
    webview2Env,
    stop: () => { try { child.kill() } catch { /* already gone */ } },
  }
}

function listDir(dir: string): string {
  try { return fs.readdirSync(dir).join(', ') || '(empty)' } catch (e) { return `(unreadable: ${e})` }
}

/** Run the binary's own `--status-json` and parse it (C08: the interface, not the screen). */
export function statusJson(bin: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--status-json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', d => { out += String(d) })
    child.on('error', reject)
    child.on('close', () => {
      // ⚠ The LAST JSON line: the binary may log a line or two to stdout before answering, and a
      // harness that parsed the whole buffer would fail on a warning it does not care about.
      const line = out.split(/\r?\n/).filter(l => l.trim().startsWith('{')).at(-1)
      if (!line) return reject(new Error(`--status-json printed no JSON:\n${out}`))
      try { resolve(JSON.parse(line)) } catch (e) { reject(new Error(`${e}\n${out}`)) }
    })
  })
}

/**
 * Connect to the running app, retrying while the webview starts up.
 *
 * ⚠ `shell` is passed in so a dead child is reported AS a dead child. Without it the only symptom
 * of an app that never started was "no CDP endpoint on 9222", which names the debugging port — and
 * the debugging port is the one thing that was working.
 */
export async function connect(port: number, timeoutMs = 60_000, shell?: ShellProcess): Promise<Browser> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch (e) {
      last = e
      const dead = shell?.died()
      if (dead) {
        throw new Error(
          `the app is not running, so there is no debugging port: ${dead}\n` +
          `Its output:\n${shell!.stderr() || '(nothing)'}`,
        )
      }
      await sleep(500)
    }
  }
  throw new Error(
    `no CDP endpoint on ${port} after ${timeoutMs} ms: ${last}\n` +
    `The app is still running, so it started but never opened the port.\n` +
    `${portDiagnostics(port, shell)}\n` +
    `Its output:\n${shell?.stderr() || '(nothing captured)'}`,
  )
}

/**
 * What to know when the app is up but the debugging port is not.
 *
 * ⚠ This exists because that exact failure happened on `windows-2025-vs2026` and NOT on a
 * developer's machine with a newer WebView2 (154), so the difference is environmental and the CI
 * log is the only place it can be seen. Guessing at it costs a CI round trip per guess; printing
 * the facts costs one.
 *
 * ⚠ Best-effort and never throws. A diagnostic that can fail the test it is explaining would
 * replace a useful error with its own.
 */
function portDiagnostics(port: number, shell?: ShellProcess): string {
  const out: string[] = []
  // What the APP was given, and what the runner happens to carry, as two separate facts.
  for (const [k, v] of Object.entries(shell?.webview2Env ?? {})) out.push(`passed to the app: ${k}=${v}`)
  out.push(`runner's own WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? '(unset)'}`)
  out.push(`runner's own WEBVIEW2_USER_DATA_FOLDER=${process.env.WEBVIEW2_USER_DATA_FOLDER ?? '(unset)'}`)
  if (process.platform === 'win32') {
    // ⚠ **The deciding measurement.** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is a REQUEST:
    // `CoreWebView2EnvironmentOptions.AdditionalBrowserArguments`, which wry sets itself, takes
    // precedence over it, and Chromium can accept the switch and then refuse to act on it. The
    // browser process's own command line separates those: either `--remote-debugging-port` is
    // not on it (something overrode us) or it is (the runtime declined, and `--user-data-dir`
    // on the same line says whether the default-profile rule is why).
    const cmdlines = run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { $_.CommandLine }",
    ]).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    // The browser process is the one without a `--type=`; the rest are its renderers and GPU.
    const browser = cmdlines.filter(l => !l.includes('--type='))
    out.push(`msedgewebview2.exe processes: ${cmdlines.length} (${browser.length} browser)`)
    for (const l of browser) out.push(`  browser process: ${l}`)
    if (!cmdlines.length) out.push('  (none running — the webview never started, whatever the window shows)')
    // ⚠ **The leading hypothesis once the command line shows the switch is THERE.** Chromium
    // has a `RemoteDebuggingAllowed` policy, and WebView2 has `WebView2AdditionalBrowserArguments`
    // which an administrator can use to replace an app's arguments per executable. Either would
    // ignore the switch in silence, on every runtime version, on a managed image only — which is
    // the exact shape of a failure that reproduces nowhere else. Absent on a developer machine
    // (verified: all three keys missing), so an EMPTY answer here is itself the useful one.
    for (const key of [
      'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
      'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge',
    ]) {
      const dump = run('reg', ['query', key, '/s'])
      const hits = dump.split(/\r?\n/).map(l => l.trim())
        .filter(l => /RemoteDebugging|WebView2|AdditionalBrowserArguments|DeveloperTools/i.test(l))
      out.push(`${key}: ${hits.length ? hits.join(' | ') : dump.includes('ERROR') ? '(key absent)' : '(no relevant values)'}`)
    }
    // ⚠ **#116's cause: an elevated host.** Since Runtime 150 WebView2 ignores every `WEBVIEW2_*`
    // environment override in an elevated process, so the variable above reaches the app and never
    // its browser. GitHub's runner runs as `runneradmin` with UAC off, and `desktop-ci.yml` opens the
    // port through the HKLM policy instead, which an elevated host still reads. Printed because an
    // elevated run anywhere else fails the same silent way.
    out.push(`elevated: ${run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ]).trim()}  user: ${run('whoami', []).trim()}`)
    out.push(`integrity: ${(run('whoami', ['/groups']).split(/\r?\n/)
      .find(l => /S-1-16-\d+/.test(l)) ?? '(not reported)').trim()}`)
    // The runtime's version, because "it works on 154 locally" is only useful next to the
    // runner's number.
    out.push(`WebView2 runtime: ${run('reg', [
      'query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      '/v', 'pv',
    ]).match(/pv\s+REG_SZ\s+(\S+)/)?.[1] ?? 'not found'}`)
    // Whether ANYTHING holds the port. `ECONNREFUSED` says nothing is listening; this says so in
    // the log, which distinguishes "never opened" from "opened and refused us".
    const net = run('netstat', ['-ano']).split(/\r?\n/).filter(l => l.includes(`:${port} `))
    out.push(`listeners on ${port}: ${net.length ? net.map(l => l.trim()).join(' | ') : 'none'}`)
  }
  return out.join('\n')
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  } catch (e: any) {
    return String(e?.stdout || e?.message || e)
  }
}

/**
 * The shell's own page (the `main` window), found by its URL rather than by index.
 *
 * ⚠ By URL, because `lgr-web` is a second page in the same browser context and which one is
 * `pages()[0]` depends on start order. The shell's pages are served from the bundle, so they are
 * `tauri://`/`http://tauri.localhost` — never the hub's origin.
 */
export async function shellPage(browser: Browser, timeoutMs = 60_000): Promise<Page> {
  return findPage(browser, u => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u), timeoutMs, 'the shell window')
}

/** The `lgr-web` page: the one on the hub's origin. */
export async function webPage(browser: Browser, hubOrigin: string, timeoutMs = 30_000): Promise<Page> {
  return findPage(browser, u => u.startsWith(hubOrigin), timeoutMs, `a page on ${hubOrigin}`)
}

/** The bundled unreachable page: served by the shell, and identifiable by its file name. */
export async function unreachablePage(browser: Browser, timeoutMs = 30_000): Promise<Page> {
  return findPage(browser, u => u.includes('unreachable.html'), timeoutMs, 'the unreachable page')
}

async function findPage(
  browser: Browser,
  match: (url: string) => boolean,
  timeoutMs: number,
  what: string,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  let seen: string[] = []
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(c => c.pages())
    seen = pages.map(p => p.url())
    const hit = pages.find(p => match(p.url()))
    if (hit) return hit
    await sleep(300)
  }
  throw new Error(`could not find ${what}. Pages seen: ${JSON.stringify(seen)}`)
}

/**
 * Wait for a line in the shell's log.
 *
 * ⚠ This is the ONLY way to assert the print path, an external open and a download: none of them
 * is observable from CDP, because each leaves the webview entirely (a platform print dialog, the
 * system browser, an OS save dialog). The shell writes a structured line for exactly that reason
 * (`web.rs`), and those lines are a contract this spec depends on.
 */
export async function waitForLog(
  pattern: RegExp,
  timeoutMs = 20_000,
  extra = '',
  since = 0,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const file = logFile()
  let text = ''
  while (Date.now() < deadline) {
    // ⚠ `since` is what stops a line from EARLIER in this serial run satisfying a later
    // assertion. The log is append-only and shared by every case in the file, so without it a case
    // could pass on evidence produced before the thing it is testing happened.
    text = `${extra}\n${readIfPresent(file).slice(since)}`
    const hit = text.split(/\r?\n/).find(l => pattern.test(l))
    if (hit) return hit
    await sleep(250)
  }
  throw new Error(`no log line matching ${pattern} within ${timeoutMs} ms. Log tail:\n${tail(text)}`)
}

/** How much log there is right now — pass it back as `since` to ignore everything before. */
export function logCursor(): number {
  return readIfPresent(logFile()).length
}

/** Assert a line is ABSENT — used where the point is that nothing happened. */
export function logContains(pattern: RegExp, extra = ''): boolean {
  const text = `${extra}\n${readIfPresent(logFile())}`
  return text.split(/\r?\n/).some(l => pattern.test(l))
}

function readIfPresent(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function tail(text: string, lines = 40): string {
  return text.split(/\r?\n/).slice(-lines).join('\n')
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Navigate the shell by clicking its own navigation, not by pushing history.
 *
 * ⚠ The real path on purpose. `history.pushState` + a synthetic `popstate` would route the app
 * while proving nothing about the drawer, and a broken nav link would still pass. The drawer
 * renders a plain `<a href="/settings">` per item (Vuetify `v-list-item` with `:to`), so the href
 * is the stable handle — the labels are translated and the icons are not text.
 */
export async function gotoView(page: Page, route: string): Promise<void> {
  await page.locator(`a[href="${route}"]`).click()
  await page.waitForFunction(r => window.location.pathname === r, route, { timeout: 10_000 })
}

/** The stub hub's control surface (see `scripts/desktop-hub-stub.ts`). */
export class StubHub {
  readonly origin: string
  private readonly control: string
  private proc: ChildProcess | null = null

  constructor(readonly port: number) {
    this.origin = `http://127.0.0.1:${port}`
    this.control = `http://127.0.0.1:${port + 1}`
  }

  private output = ''

  async start(startPath: string): Promise<void> {
    const script = path.join(__dirname, '..', '..', 'scripts', 'desktop-hub-stub.ts')
    // ⚠ **No `shell: true`.** On Windows that wraps the child in `cmd.exe`, so `kill()` kills the
    // shell and leaves `bun` running — and the orphan then holds the control port, which makes the
    // NEXT run fail to start for a reason that has nothing to do with the next run. Spawning
    // `bun.exe` directly means the handle we kill is the process we started.
    this.proc = spawn(process.platform === 'win32' ? 'bun.exe' : 'bun', [script], {
      env: { ...process.env, LGR_STUB_PORT: String(this.port), LGR_STUB_START_PATH: startPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // ⚠ Captured so a failure to start says WHY. An orphan from an earlier run holding the control
    // port made the stub exit on a bind error, and the only thing reported was "the hub did not
    // come up" — which points at the wrong thing entirely.
    this.proc.stdout?.on('data', d => { this.output += String(d) })
    this.proc.stderr?.on('data', d => { this.output += String(d) })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.origin}/api/health`)
        if (res.ok) return
      } catch { /* not listening yet */ }
      if (this.proc.exitCode !== null) break
      await sleep(250)
    }
    throw new Error(
      `the stub hub did not come up on ${this.origin} (control ${this.control}).\n` +
      `Something may already be listening on ${this.port} or ${this.port + 1}.\n` +
      `Stub output:\n${this.output || '(nothing)'}`,
    )
  }

  offline() { return this.post('offline') }
  online() { return this.post('online') }
  revoke() { return this.post('revoke') }
  requestUpdate() { return this.post('update') }
  state() { return fetch(`${this.control}/__stub/state`).then(r => r.json()) }

  offer(version: string | null, minVersion: string | null = null) {
    return fetch(`${this.control}/__stub/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, minVersion }),
    }).then(r => r.json())
  }

  private post(what: string) {
    return fetch(`${this.control}/__stub/${what}`, { method: 'POST' }).then(r => r.json())
  }

  stop() { try { this.proc?.kill() } catch { /* already gone */ } }
}
