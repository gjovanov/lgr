/**
 * A stand-in LGR hub for the desktop shell (C15 §3).
 *
 * The CDP walk drives the real shell binary, so it needs something for the shell to talk to. This
 * is that something: the handful of endpoints `packages/desktop/src-tauri/src/{presence,enroll,
 * web}.rs` actually call, plus a fake SPA to load into the `lgr-web` window.
 *
 * ⚠ **Hermetic is the whole point.** The alternative is pointing the spec at `lgrai.app`, which
 * would enrol a VM-less CI runner as a real desktop in a real org on every pull request. The same
 * reasoning produced `ocr-stub.ts`, which exists so E2E needs no Claude token.
 *
 * ⚠ **Two servers, on two ports.** `presence::probe` treats ANY HTTP answer as reachable — a 503
 * included — so "the server is down" cannot be faked with a status code. It has to be a refused
 * connection, which means the hub stops listening; and once it has, something still has to be
 * listening to turn it back on. Hence the control server on `port + 1`, which never stops.
 *
 *   bun packages/e2e/scripts/desktop-hub-stub.ts                      # hub :4099, control :4100
 *   LGR_STUB_PORT=5000 bun packages/e2e/scripts/desktop-hub-stub.ts   # hub :5000, control :5001
 *
 * Control surface (the spec uses it; nothing else should):
 *   POST /__stub/offline   stop listening  → the shell sees `server-unreachable`
 *   POST /__stub/online    listen again    → the retry loop returns to `startPath`
 *   POST /__stub/revoke    push `desktop:revoked` down the presence socket (FR-14.22)
 *   POST /__stub/update    push `desktop:update` (FR-14.28)
 *   POST /__stub/release   { version, minVersion } — what `/latest-release` offers next
 *   GET  /__stub/state     what the stub has seen, so a spec can assert on the SERVER side
 *
 * The updater (FR-14.28): with `LGR_STUB_UPDATE_FILE` (an installer) and `LGR_STUB_UPDATE_SIG` (its
 * `.sig`) set, `/api/desktop/v1/update` offers the release version with that file, served from
 * `/__stub/update-file`. Without them it answers 204, like a hub whose release has no `.sig`.
 */
const UPDATE_FILE = process.env.LGR_STUB_UPDATE_FILE || ''
const UPDATE_SIG = process.env.LGR_STUB_UPDATE_SIG || ''

/**
 * ⚠ `LGR_STUB_PORT`, never `PORT`.
 *
 * The first version read `PORT`, and on a machine where something had already exported it the stub
 * came up on **4001** — the real unified API's port — so the shell would have been driven against
 * whatever was listening there, or the stub would have failed to bind with the dev server running.
 * It printed the port it chose and nothing looked wrong. A prefixed name cannot collide.
 */
const PORT = Number(process.env.LGR_STUB_PORT || 4099)
const CONTROL_PORT = PORT + 1

/**
 * ⚠ Not `/`. The point of the `startPath` assertion is that Open LGR lands somewhere OTHER than
 * the default, because `/` is also what the fallback produces — a test that asserted `/` would
 * pass against a shell that ignored the assignment entirely.
 *
 * `/pos/` on purpose: the path the tills in the field store, which the POS app's move into
 * Invoicing left to a server-side redirect. The hub answers it the way the real one does
 * (`portal-api/src/lib/pos-redirect.ts`), so the walk proves the shell follows that 302 into a page.
 */
const START_PATH = process.env.LGR_STUB_START_PATH || '/pos/'
const TERMINAL_PATH = '/invoicing/cash-sales/new'

const state = {
  /** Enrollments the stub has accepted, so a spec can assert the shell sent a public key. */
  enrollments: [] as Array<Record<string, unknown>>,
  /** Every `PUT /self` report (FR-14.21) — version, OS, capabilities, serial ports. */
  reports: [] as Array<Record<string, unknown>>,
  tokensMinted: 0,
  /** FR-14.28 — how often the updater asked for a manifest, and downloaded the file. */
  updateChecks: 0,
  updateDownloads: 0,
  release: {
    version: process.env.LGR_STUB_OFFERED_VERSION || null as string | null,
    minVersion: process.env.LGR_STUB_MIN_VERSION || null as string | null,
  },
  online: true,
}

/** Live presence sockets, so the control server can push a revocation down them. */
const sockets = new Set<any>()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const now = () => new Date().toISOString()

/**
 * The fake SPA.
 *
 * ⚠ The `invoke` probe is the load-bearing part (AC 6, C08). Tauri 2 injects
 * `__TAURI_INTERNALS__` into REMOTE pages too, so "the global is missing" proves nothing — the
 * only proof is a real `invoke` being refused by the capability list. This page issues one and
 * writes the outcome into the DOM where CDP can read it, so a regression that granted `lgr-web` a
 * capability would turn `#invoke-result` green and fail the spec.
 */
function spa(path: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stub hub</title>
<style>body{font:14px system-ui;margin:0;padding:24px}code{background:#eee;padding:2px 4px}</style>
</head><body>
  <h1 data-testid="stub-hub">Stub hub</h1>
  <p>Path: <code data-testid="stub-path">${path}</code></p>

  <!-- For the external-navigation assertion: a different ORIGIN, which the shell must hand to
       the system browser rather than load in this window (FR-14.15). It is never fetched - the
       shell intercepts the navigation - so the host does not have to exist. -->
  <p><a id="outside" href="https://example.invalid/outside">an outside origin</a></p>

  <p>IPC from this remote origin: <strong id="invoke-result">probing…</strong></p>

  <script>
    (async () => {
      const el = document.getElementById('invoke-result')
      const internals = window.__TAURI_INTERNALS__
      if (!internals || typeof internals.invoke !== 'function') {
        // ⚠ NOT a pass. A future Tauri that stopped injecting internals would make this page
        // report "no IPC" while proving nothing about the capability list, so it is reported as
        // its own outcome and the spec treats it as inconclusive.
        el.textContent = 'NO-INTERNALS'
        el.dataset.outcome = 'no-internals'
        return
      }
      try {
        // A real command the shell exposes to its OWN window. If this resolves, the remote origin
        // holds a capability it must never have.
        await internals.invoke('open_logs')
        el.textContent = 'ACCEPTED'
        el.dataset.outcome = 'accepted'
      } catch (e) {
        el.textContent = 'REJECTED: ' + String(e)
        el.dataset.outcome = 'rejected'
      }
    })()
  </script>
</body></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function handle(req: Request): Response | Promise<Response> | undefined {
  const url = new URL(req.url)
  const p = url.pathname

  // ── What `presence::probe` asks ────────────────────────────────────────────────────────────
  if (p === '/api/health') return json({ ok: true, serverTime: now() })

  // ── Enrollment (FR-14.19) ─────────────────────────────────────────────────────────────────
  //
  // ⚠ The stub does NOT verify the public key or the code. It is standing in for the hub so the
  // shell's own flow can be driven; the cryptography is asserted against the REAL hub by
  // `packages/tests/src/integration/desktop*.flow.test.ts`, which is where it belongs.
  if (p === '/api/desktop/v1/enroll' && req.method === 'POST') {
    return req.json().then((body: any) => {
      state.enrollments.push(body)
      if (!body?.publicKey) return json({ code: 'public_key_required' }, 422)
      return json({
        desktopId: 'stub-desktop-1',
        orgId: 'stub-org-1',
        orgName: 'Stub Org',
        assignment: { startPath: START_PATH, fiscalDeviceIds: [] },
        serverTime: now(),
      })
    })
  }

  // ── Access tokens (FR-14.20) ──────────────────────────────────────────────────────────────
  if (p === '/api/desktop/v1/token' && req.method === 'POST') {
    state.tokensMinted++
    // ⚠ `serverTime` is what the shell learns its clock offset from, so it is always sent — a
    // stub that omitted it would hide the one bug this field exists to prevent (a +3 h guest
    // minting assertions the server rejects).
    return json({ accessToken: 'stub-access-token', serverTime: now() })
  }

  if (p === '/api/desktop/v1/self' && req.method === 'PUT') {
    return req.json().then((body: any) => {
      state.reports.push(body)
      return json({ ok: true })
    })
  }

  if (p === '/api/desktop/v1/fiscal-devices') {
    return json({ fiscalDevices: [], serverTime: now() })
  }

  // ── The update manifest (FR-14.28) ────────────────────────────────────────────────────────
  if (p === '/api/desktop/v1/latest-release') {
    return json({
      release: state.release.version ? { version: state.release.version } : null,
      minVersion: state.release.minVersion,
    })
  }

  // ── The updater's manifest and download (FR-14.28) ───────────────────────────────────────
  if (p === '/api/desktop/v1/update') {
    state.updateChecks++
    if (!state.release.version || !UPDATE_FILE || !UPDATE_SIG) return new Response(null, { status: 204 })
    return Bun.file(UPDATE_SIG).text().then(signature => json({
      version: state.release.version,
      url: `http://127.0.0.1:${PORT}/__stub/update-file`,
      signature: signature.trim(),
    }))
  }
  if (p === '/__stub/update-file' && UPDATE_FILE) {
    state.updateDownloads++
    return new Response(Bun.file(UPDATE_FILE))
  }

  // ── The fake SPA ──────────────────────────────────────────────────────────────────────────
  if (p === '/pos' || p.startsWith('/pos/')) return new Response(null, { status: 302, headers: { Location: TERMINAL_PATH } })

  if (p === '/' || p === START_PATH || p.startsWith(START_PATH)) return spa(p)

  // Anything else still answers HTML: the shell may navigate within the origin, and a 404 in the
  // `lgr-web` window reads like a shell bug when it is only an unmodelled path.
  return spa(p)
}

const hubOptions = {
  port: PORT,
  fetch(req: Request, server: any) {
    if (server.upgrade(req, { data: {} })) return undefined as any
    return handle(req) as any
  },
  websocket: {
    /**
     * The presence socket (FR-14.21).
     *
     * ⚠ It answers `desktop:authenticated` without checking the token, for the same reason
     * enrollment does not check the key: this stands in for the hub so the SHELL can be driven.
     * The real handshake is asserted against the real hub.
     */
    message(ws: any, raw: string) {
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg?.type === 'desktop:auth') {
        sockets.add(ws)
        ws.send(JSON.stringify({ type: 'desktop:authenticated', desktopId: 'stub-desktop-1' }))
        return
      }
      if (msg?.type === 'desktop:heartbeat') {
        ws.send(JSON.stringify({ type: 'desktop:heartbeat:ack', serverTime: now() }))
      }
    },
    close(ws: any) { sockets.delete(ws) },
  },
}

let hub: any = Bun.serve(hubOptions)

function push(type: string, extra: Record<string, unknown> = {}) {
  let sent = 0
  for (const ws of sockets) {
    try { ws.send(JSON.stringify({ type, ...extra })); sent++ } catch { /* gone */ }
  }
  return sent
}

/**
 * ⚠ A bind failure here used to kill the process AFTER the hub was already listening, so the
 * harness saw "the hub did not come up" while something was answering on the hub port — pointing
 * at the wrong port entirely. An orphaned stub from an interrupted run is the normal way to hit it.
 */
try {
Bun.serve({
  port: CONTROL_PORT,
  fetch(req: Request) {
    const p = new URL(req.url).pathname
    switch (p) {
      case '/__stub/offline':
        if (state.online) {
          // ⚠ `true` closes live connections too. A presence socket left open would keep the
          // shell believing the server is there, and the unreachable page would never appear.
          hub.stop(true)
          sockets.clear()
          state.online = false
        }
        return json({ online: false })
      case '/__stub/online':
        if (!state.online) {
          hub = Bun.serve(hubOptions)
          state.online = true
        }
        return json({ online: true })
      case '/__stub/revoke':
        return json({ pushed: push('desktop:revoked', { message: 'removed by the stub' }) })
      case '/__stub/update':
        return json({ pushed: push('desktop:update') })
      case '/__stub/release':
        return req.json().then((b: any) => {
          state.release = { version: b?.version ?? null, minVersion: b?.minVersion ?? null }
          return json(state.release)
        }) as any
      case '/__stub/state':
        return json({
          online: state.online,
          startPath: START_PATH,
          enrollments: state.enrollments.length,
          lastEnrollment: state.enrollments.at(-1) ?? null,
          reports: state.reports.length,
          lastReport: state.reports.at(-1) ?? null,
          tokensMinted: state.tokensMinted,
          presenceSockets: sockets.size,
          release: state.release,
          updateChecks: state.updateChecks,
          updateDownloads: state.updateDownloads,
        })
      default:
        return json({ error: 'unknown control path' }, 404)
    }
  },
})
} catch (e) {
  console.error(
    `[desktop-hub-stub] cannot listen on the control port ${CONTROL_PORT}: ${e}\n` +
    `Another stub is probably still running from an earlier run — stop it, or set LGR_STUB_PORT.`,
  )
  hub.stop(true)
  process.exit(1)
}

console.log(`[desktop-hub-stub] hub http://127.0.0.1:${PORT}  control http://127.0.0.1:${CONTROL_PORT}  startPath=${START_PATH}`)
