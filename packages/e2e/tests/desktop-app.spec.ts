import { test, expect } from '@playwright/test'
import {
  StubHub,
  appDataDir,
  connect,
  launchShell,
  gotoView,
  logContains,
  logCursor,
  resetAppState,
  shellPage,
  sleep,
  statusJson,
  unreachablePage,
  waitForLog,
  webPage,
  writeSettings,
} from './helpers/desktop-app'
import fs from 'node:fs'
import path from 'node:path'

/**
 * C15 §3 — the shell itself, driven over WebView2's CDP endpoint (FR-14.37; AC 3, 4, 6, 7).
 *
 * Everything else about the desktop is unit-tested or asserted against the hub. What cannot be:
 * a print dialog, a system-browser launch, a rejected `invoke` and a webview that cannot reach its
 * server are all observable only from OUTSIDE the process. This spec is that outside.
 *
 * ## It needs a built binary, and says so rather than passing
 *
 * `LGR_DESKTOP_BIN` must point at the shell executable (`desktop-ci.yml` sets it from the build
 * job's artifact). Without it the whole file skips with a reason — but ⚠ a skip is never silent:
 * the CI job that owns this spec fails if the file is absent, so "enabled but never executed",
 * which is how a smoke test rots for a year, cannot happen here.
 *
 * ## Hermetic
 *
 * Everything runs against `scripts/desktop-hub-stub.ts` on loopback. ⚠ No test here contacts
 * `lgrai.app`: a CI runner enrolling itself as a real desktop in a real org on every pull request
 * is not a test, it is a fleet of ghosts for an admin to clean up.
 *
 * ## Modal OS dialogs are the one thing CDP cannot drive
 *
 * `print_lgr` ends in the platform print dialog and a download ends in a native Save-as
 * (`web.rs#save_as`, blocking on purpose). Both BLOCK the app, and no CDP call dismisses them. So
 * the two cells that need one are gated behind `LGR_DESKTOP_ALLOW_MODAL=1`, run last, and are
 * otherwise reported as skipped with the reason. ⚠ They are C17's `print` and `downloads` cells,
 * where a guest driver on a real desktop session can answer the dialog — not a gap being hidden.
 */

const BIN = process.env.LGR_DESKTOP_BIN || ''
const CDP_PORT = Number(process.env.LGR_DESKTOP_CDP_PORT || 9222)
const HUB_PORT = Number(process.env.LGR_STUB_PORT || 4099)
const START_PATH = '/pos/'
/** Nine characters, `XXXX-XXXX`, uppercase and digits — what `is_enrollment_code` accepts. */
const CODE = 'K7Y2-9QR4'

test.skip(!BIN, 'LGR_DESKTOP_BIN is not set — build the shell first (see desktop-ci.yml)')

// One app, one debugging port: C08's single-instance plugin guarantees exactly one instance, so
// parallel workers would fight over both (C15 trap 7 / the CI job passes --workers=1).
test.describe.configure({ mode: 'serial' })

const hub = new StubHub(HUB_PORT)
let shell: ReturnType<typeof launchShell>
let browser: Awaited<ReturnType<typeof connect>>

test.beforeAll(async () => {
  // ⚠ A clean machine. A key left behind by an earlier run makes the shell report `registered`
  // against a stub that has never heard of it, and every onboarding assertion then tests nothing.
  resetAppState()
  await hub.start(START_PATH)
  writeSettings(hub.origin)
  shell = launchShell(BIN, CDP_PORT)
  browser = await connect(CDP_PORT, 60_000, shell)
})

test.afterAll(async () => {
  try { await browser?.close() } catch { /* the app may already be gone */ }
  shell?.stop()
  hub.stop()
})

test.describe('the shell window', () => {
  test('comes up on the Overview and reports that its page rendered', async () => {
    const page = await shellPage(browser)
    await expect(page.locator('[data-card="this-desktop"]')).toBeVisible({ timeout: 30_000 })

    // ⚠ The `shell_ready` line is not scaffolding. It is what separates "the app started but the
    // page never rendered" from "the app never started" — identical reports from a user looking at
    // a blank window, and only one of them is a CSP problem (C08).
    await waitForLog(/ui ready \(route=/, 30_000, shell.stderr())
  })

  test('walks every view and each shows DOM only that view has', async () => {
    const page = await shellPage(browser)

    // ⚠ Real DOM per view, not "a page loaded". A router that resolved every path to the Overview
    // would pass a title check and fail this.
    const views: Array<[string, string]> = [
      ['/overview', '[data-card="this-desktop"]'],
      ['/settings', '[data-field="start-path"]'],
      ['/onboarding', '[data-field="server-url"]'],
      ['/logs', '[data-field="log-pane"]'],
      ['/diagnostics', '[data-action="create-bundle"]'],
    ]

    for (const [route, marker] of views) {
      await gotoView(page, route)
      await expect(page.locator(marker), `${route} should render its own DOM`).toBeVisible({ timeout: 10_000 })
    }

    // And the markers are genuinely distinct — the Logs pane must NOT be on the Overview.
    await gotoView(page, '/overview')
    await expect(page.locator('[data-field="log-pane"]')).toHaveCount(0)
  })

  test('--status-json answers without a window, carries a schema version and no credential', async () => {
    // ⚠ A SECOND process, deliberately: `--status-json` answers before the Tauri builder runs, so
    // it works on a machine where no window can open — which is exactly when a harness most needs
    // an answer. C08's single-instance plugin does not refuse it, because it never gets that far.
    const st = await statusJson(BIN)

    expect(typeof st.schemaVersion, 'a consumer must be able to tell a changed shape from a missing field').toBe('number')
    expect(st.serverUrl).toBe(hub.origin)
    expect(st.bridge.supported, 'C18 shipped the native bridge').toBe(true)
    expect(Array.isArray(st.bridge.fiscal)).toBe(true)
    expect(st.logPath).toContain('com.lgr.desktop')

    // ⚠ It lands in CI logs and pasted issues, so it must carry nothing secret.
    const text = JSON.stringify(st)
    for (const forbidden of [/eyJ/, /accessToken/i, /secret/i, /privateKey/i, /assertion/i]) {
      expect(text, `--status-json must not carry ${forbidden}`).not.toMatch(forbidden)
    }
  })

  test('the key and installationId live in non-roaming storage', async () => {
    // AC 10 / §1.2 #5. On a domain with roaming profiles, `app_data_dir()` would give every PC the
    // user signs into the same identity, so revoking one would revoke a machine nobody touched.
    const dir = appDataDir()
    expect(dir).not.toMatch(/Roaming/i)
    if (process.platform === 'win32') expect(dir).toMatch(/AppData[\\/]Local/i)

    const st = await statusJson(BIN)
    expect(st.logPath.toLowerCase()).not.toContain('roaming')
  })
})

test.describe('registration, against the stub hub', () => {
  test('onboarding enrolls and the Overview then shows the org', async () => {
    const page = await shellPage(browser)
    await gotoView(page, '/onboarding')

    await page.locator('[data-field="server-url"] input').fill(hub.origin)
    await page.locator('[data-action="next"]').click()
    await page.locator('[data-field="desktop-name"] input').fill('E2E-TILL')
    await page.locator('[data-action="next"]').click()
    await page.locator('[data-field="code"] input').fill(CODE)
    await page.locator('[data-action="next"]').click()

    // Step 4 appearing is the enrollment having succeeded: `onNext` only advances on success.
    await expect(page.locator('[data-field="open-on-launch"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-banner="register-failed"]')).toHaveCount(0)

    // ⚠ Asserted on the SERVER side too: the shell must have sent a PUBLIC key and nothing else.
    const state = await hub.state()
    expect(state.enrollments).toBeGreaterThan(0)
    expect(state.lastEnrollment.publicKey, 'enrollment carries the public half').toBeTruthy()
    expect(JSON.stringify(state.lastEnrollment)).not.toMatch(/privateKey|secretKey/i)

    await page.locator('[data-action="finish"]').click()
    await expect(page.locator('[data-card="this-desktop"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-field="org"]')).toContainText('Stub Org', { timeout: 20_000 })
  })

  test('the stored key proves itself by minting a token', async () => {
    // Enrollment only proves the server accepted a public key. Minting is the first thing that
    // exercises the private half out of the OS keystore — a till that is "registered" and cannot
    // authenticate would otherwise be discovered at the first sale.
    const state = await hub.state()
    expect(state.tokensMinted, 'the shell minted at least one access token').toBeGreaterThan(0)
  })

  test('--status-json reports it registered, with the key in OS storage', async () => {
    const st = await statusJson(BIN)
    expect(st.registration.state).toBe('registered')
    expect(st.registration.desktopId).toBe('stub-desktop-1')
    // `file` is the documented Linux fallback; what must never happen is `none` after enrolling.
    expect(['keystore', 'file']).toContain(st.keyStorage)
  })
})

test.describe('Open LGR', () => {
  test('lands on the assignment startPath, not on /', async () => {
    const page = await shellPage(browser)
    await gotoView(page, '/overview')
    await page.locator('[data-action="open-lgr"]').click()

    // ⚠ The log line carries the resolved URL, which is the assertion: `/` is also what the
    // FALLBACK produces, so a spec that accepted `/` would pass against a shell that ignored the
    // assignment entirely.
    const line = await waitForLog(/lgr-web: opened url=/, 30_000, shell.stderr())
    expect(line).toContain(`${hub.origin}${START_PATH}`)

    const web = await webPage(browser, hub.origin)
    await expect(web.locator('[data-testid="stub-hub"]')).toBeVisible({ timeout: 20_000 })
    await expect(web.locator('[data-testid="stub-path"]')).toHaveText(START_PATH)
  })

  test('a real invoke from the remote origin is REJECTED', async () => {
    // AC 6, and the single most important assertion in this file.
    //
    // ⚠ A missing `window.__TAURI__` proves nothing: Tauri 2 injects `__TAURI_INTERNALS__` into
    // remote pages regardless of `withGlobalTauri`, so the capability list is the real boundary and
    // only a real `invoke` being refused tests it. The stub SPA issues one on load and records the
    // outcome; `no-internals` is reported as its own value so a future Tauri that stopped
    // injecting cannot turn an untested page into a green one.
    const web = await webPage(browser, hub.origin)
    const result = web.locator('#invoke-result')
    await expect(result).not.toHaveText('probing…', { timeout: 20_000 })

    const outcome = await result.getAttribute('data-outcome')
    expect(
      outcome,
      'the remote origin must hold no capability; "no-internals" means this assertion proved nothing',
    ).toBe('rejected')
  })

  test('a navigation to an outside origin leaves the window', async () => {
    // FR-14.15's containment rule. Not observable from CDP — the page goes to the system browser —
    // so the shell's own line is the evidence.
    const web = await webPage(browser, hub.origin)
    // ⚠ `noWaitAfter`, because the point of the feature is that this navigation NEVER finishes in
    // this window — the shell cancels it and hands the URL to the system browser. Playwright's
    // default is to wait for scheduled navigations to settle, so the click times out on a
    // navigation that was correctly refused. It passed once by timing luck, which is worse.
    await web.locator('#outside').click({ noWaitAfter: true })

    const line = await waitForLog(/lgr-web: external-navigation url=/, 20_000, shell.stderr())
    expect(line).toContain('example.invalid')

    // And the window stayed where it was: the outside origin was never loaded into it.
    //
    // ⚠ **Asserted by URL, with no locator call.** The refused navigation stays PENDING as far as
    // the webview is concerned — the shell cancelled it from outside — and Playwright blocks every
    // locator action on a page with a pending navigation. A DOM assertion here therefore fails
    // with `waiting for "https://example.invalid/outside" navigation to finish`, which is the
    // containment working. It passed twice before this surfaced, so it was a flake waiting to be
    // believed.
    //
    // `url()` is a property read, needs no navigation, and answers the actual question: if the
    // outside origin had loaded, this would BE the outside origin.
    const urls = browser.contexts().flatMap(c => c.pages()).map(p => p.url())
    expect(urls.some(u => u.startsWith(hub.origin)), `still on the hub: ${urls}`).toBe(true)
    expect(urls.some(u => u.includes('example.invalid')), `the outside origin was not loaded: ${urls}`).toBe(false)
  })
})

test.describe('the server going away', () => {
  test('shows the bundled unreachable page, then returns to startPath by itself', async () => {
    // FR-14.17. The alternative is the WEBVIEW'S error page: browser chrome inside an app window,
    // in whatever language the system webview feels like, with no retry and no diagnostics — which
    // is what a till operator would otherwise be looking at.
    //
    // ⚠ The app is RESTARTED rather than having its `lgr-web` page closed over CDP. Closing the
    // page leaves the Tauri window alive, so `web::open` takes its "already open, just focus it"
    // branch and probes nothing — the first version of this test passed through that branch and
    // asserted nothing at all. A relaunch is also the honest scenario: a till that was switched on
    // while the shop's internet was down.
    //
    // ⚠ And it exercises `openLgrOnLaunch` (FR-14.16 / AC 8) on the way: after autostart the POS
    // is meant to be on screen with nobody touching it.
    await browser.close()
    shell.stop()
    await hub.offline()
    writeSettings(hub.origin, { openLgrOnLaunch: true })

    const since = logCursor()
    shell = launchShell(BIN, CDP_PORT)
    browser = await connect(CDP_PORT, 60_000, shell)

    await waitForLog(/lgr-web: server-unreachable url=/, 60_000, shell.stderr(), since)
    const down = await unreachablePage(browser)
    expect(down.url()).toContain('unreachable.html')

    // ⚠ Recovery without anyone pressing anything. The retry loop is what makes a till come back
    // after the shop's internet does, with nobody at the keyboard. The backoff reaches a minute, so
    // the budget here is generous on purpose.
    await hub.online()
    await waitForLog(/lgr-web: server-returned url=/, 120_000, shell.stderr(), since)
    const back = await webPage(browser, hub.origin, 60_000)
    await expect(back.locator('[data-testid="stub-path"]')).toHaveText(START_PATH, { timeout: 30_000 })
  })
})

test.describe('revocation', () => {
  test('the hub says so and the shell shows it within one heartbeat', async () => {
    // FR-14.22, AC 9. The row is the revocation list; the socket notice is what makes it visible
    // without waiting for the next request.
    await hub.revoke()
    await waitForLog(/revoked/i, 60_000, shell.stderr())

    const st = await statusJson(BIN)
    expect(st.registration.state).toBe('revoked')
    // ⚠ The KEY is gone, and the record is KEPT so the Overview can explain what happened. A
    // deleted record would leave a machine that merely looks unregistered and an operator with no
    // idea why the till stopped printing.
    expect(st.keyStorage).toBe('none')

    const page = await shellPage(browser)
    await gotoView(page, '/overview')
    await expect(page.locator('[data-field="registration"]')).toBeVisible({ timeout: 20_000 })
  })
})

test.describe('the diagnostics bundle', () => {
  test('writes a zip and the log carries no credential', async () => {
    const page = await shellPage(browser)
    await gotoView(page, '/diagnostics')
    await page.locator('[data-action="create-bundle"]').click()

    // ⚠ Only that one was produced: the CONTENTS are asserted by `diagnostics.rs`'s own test,
    // which generates a real zip, reads every entry back and greps it. Re-asserting that here
    // would be a second, weaker copy of a check that already exists.
    const dir = path.join(appDataDir(), 'logs')
    await expect.poll(
      () => fs.existsSync(dir) && fs.readdirSync(dir).some(f => /^lgr-diagnostics-.*\.zip$/.test(f)),
      { timeout: 30_000, message: 'a diagnostics zip should appear beside the logs' },
    ).toBe(true)

    // The log is what travels in that bundle, so nothing credential-shaped may be in it.
    expect(logContains(/eyJ[A-Za-z0-9_-]{8,}/, shell.stderr()), 'no JWT in the log').toBe(false)
    expect(logContains(/token=[A-Za-z0-9._-]{8,}/, shell.stderr()), 'no bare token in the log').toBe(false)
  })
})

/**
 * ⚠ Last, and gated. Both end in a modal OS dialog that blocks the app and that no CDP call can
 * dismiss, so running them earlier would wedge every test after them. They are C17's `print` and
 * `downloads` cells, where a guest driver on a real desktop session can answer the dialog.
 */
test.describe('paths that end in an OS dialog', () => {
  test.skip(
    process.env.LGR_DESKTOP_ALLOW_MODAL !== '1',
    'print and downloads end in a blocking OS dialog that CDP cannot dismiss — C17 lane cells',
  )

  test('print reaches the platform print path', async () => {
    const page = await shellPage(browser)
    // ⚠ Fired without awaiting: the command writes its line and THEN blocks on the dialog, so
    // awaiting the invoke would await the dialog.
    await page.evaluate(() => { (window as any).__TAURI_INTERNALS__?.invoke('print_lgr').catch(() => {}) })
    await waitForLog(/lgr-web: print-requested/, 20_000, shell.stderr())
    await sleep(500)
  })
})
