/**
 * The shell's side of the Rust plumbing (FR-14.5, FR-14.10, FR-14.12).
 *
 * ⚠ Everything here goes through `invoke`, which works only from a window listed in a Tauri
 * capability. `lgr-web` is in none, so the cloud app cannot call any of it (FR-14.9) — that is the
 * boundary, not `withGlobalTauri: false`.
 *
 * ⚠ `withGlobalTauri` is **off**, so there is no `window.__TAURI__`. The API arrives as a real
 * import from `@tauri-apps/api`, which is also why this module is the only place that imports it:
 * a page that reaches for the global would silently get `undefined` at runtime.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface ShellSettings {
  serverUrl: string
  desktopName: string
  autostart: boolean
  openLgrOnLaunch: boolean
  openInSystemBrowser: boolean
  proxy: string
  locale: string
  logLevel: string
}

/** `not_registered` | `registered` | `revoked` — the three words the Overview chip shows. */
export type RegistrationState = 'not_registered' | 'registered' | 'revoked'

/** `unknown` until C10 opens `lgr-web` and learns whether the server answers. */
export type ServerLink = 'unknown' | 'connected' | 'unreachable' | 'signed_out'

/** Where the desktop key lives. `file` is the Linux fallback the Overview warns about (C11). */
export type KeyStorage = 'none' | 'keystore' | 'file'

/**
 * One fiscal device the native bridge knows about (FR-14.27, C18).
 *
 * ⚠ `state` is a string, not a union the UI switches on exhaustively: a newer shell may report a
 * state this build predates, and an unknown state must render as itself rather than as nothing.
 * The known set is `idle` · `printing` · `opening` · `in_use` · `unassigned` · `no_port` ·
 * `error` · `offline`.
 */
export interface FiscalDeviceStatus {
  id: string
  deviceNumber: string
  name: string
  port: string | null
  state: string
  /** Seconds since the last COMPLETED command — null when there has not been one. */
  lastCommandSecsAgo: number | null
  /** Why it is not working, when it is not. Cleared once the device is healthy again. */
  lastError: string | null
}

export interface ShellStatus {
  schemaVersion: number
  appVersion: string
  os: { platform: string; arch: string }
  serverUrl: string
  desktopName: string
  registration: { state: RegistrationState; desktopId: string | null; orgSlug: string | null }
  /**
   * ⚠ `devices` stays a list of IDs, and C18 did NOT change that. It is the ASSIGNMENT — what an
   * admin set — and turning it into a list of objects would change an existing field's meaning,
   * which is the one thing `schemaVersion` is bumped for (C15/C17 already parse it). The native
   * bridge's real per-device state arrived as a NEW field, `fiscal`, which is additive.
   *
   * ⚠ The two can disagree, and the disagreement is the useful part: a device in `devices` with
   * no row in `fiscal` is assigned but not opened — typically no port configured, or the shell
   * could not read the assignment from the hub.
   */
  bridge: { supported: boolean; devices: string[]; fiscal?: FiscalDeviceStatus[] }
  autostart: boolean
  openLgrOnLaunch: boolean
  logPath: string
  /** C10 fills this; `unknown` until something has actually tried to reach the server. */
  serverLink: ServerLink
  /** C11 fills this. */
  keyStorage: KeyStorage
  /** C11 fills this, from the server's `serverTime`. `null` = never measured. */
  clockSkewMs: number | null
  /** C13 fills this. */
  update: { available: boolean; required: boolean; version: string | null }
  /** The desktop's assignment (C06/C07). `managed` means an admin set `startPath`. */
  assignment: { startPath: string | null; managed: boolean }
}

/** True when running inside the Tauri shell rather than a plain browser tab. */
export const inShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Tell Rust the UI came up.
 *
 * ⚠ Not test scaffolding: it is the line in the log — and therefore in the diagnostics bundle —
 * that distinguishes "the app started but the page never rendered" from "the app never started".
 * Those look identical to a user reporting a blank window, and only one of them is a CSP problem.
 */
export async function reportReady(): Promise<void> {
  if (!inShell) return
  try {
    await invoke('shell_ready', { route: window.location.pathname })
  } catch {
    /* an older shell without the command; not worth surfacing */
  }
}

export async function getSettings(): Promise<ShellSettings | null> {
  return inShell ? invoke<ShellSettings>('get_settings') : null
}

export async function saveSettings(settings: ShellSettings): Promise<ShellSettings> {
  return invoke<ShellSettings>('save_settings', { incoming: settings })
}

export async function getStatus(): Promise<ShellStatus | null> {
  return inShell ? invoke<ShellStatus>('get_status') : null
}

export async function readLogs(maxLines = 2000): Promise<string[]> {
  return inShell ? invoke<string[]>('read_logs', { maxLines }) : []
}

export async function createDiagnosticsBundle(): Promise<string> {
  return invoke<string>('create_diagnostics_bundle')
}

export async function openLogFolder(): Promise<void> {
  return invoke('open_log_folder')
}

/** A `--view=` argument or a tray item, consumed once (FR-14.5). */
export async function takePendingView(): Promise<string | null> {
  return inShell ? invoke<string | null>('take_pending_view') : null
}

/** A `lgr://` link that arrived before this page was listening (FR-14.12). */
export async function takePendingDeepLink(): Promise<string | null> {
  return inShell ? invoke<string | null>('take_pending_deep_link') : null
}

/**
 * Resolve a path inside the registered server origin.
 *
 * ⚠ The page never builds the URL itself. Rust checks the path's shape **and** re-checks the
 * resolved origin (FR-14.12), so `//evil.example` cannot become a navigation target no matter how
 * it reached the front end.
 */
export async function resolveServerUrl(path: string): Promise<string | null> {
  return inShell ? invoke<string | null>('resolve_server_url', { path }) : null
}

/** The tray and second-instance launches push a view this way. */
export function onViewRequested(handler: (view: string) => void): void {
  if (!inShell) return
  void listen<string>('shell:view', e => handler(e.payload))
}

/**
 * Open the cloud app (FR-14.13).
 *
 * ⚠ Takes no URL. The page says "open LGR", and Rust decides what that means — the registered
 * origin plus the assignment's `startPath`, re-validated there (FR-14.12). A front end that
 * passed a URL would be a front end that could be made to pass `//evil.example`.
 *
 * C10 implements the window; in C09 the command exists and logs.
 */
export async function openLgr(): Promise<void> {
  if (!inShell) return
  await invoke('open_lgr')
}

/**
 * Replace this desktop's keypair (FR-14.32 → C11).
 *
 * Present here so Settings is complete; the Rust side answers `not_registered` until C11.
 */
export async function rotateDesktopKey(): Promise<void> {
  return invoke('rotate_desktop_key')
}

export interface EnrollRequest {
  serverUrl: string
  name: string
  /** `XXXX-XXXX`, as minted on the Desktops page. */
  code: string
}

/**
 * Exchange a registration code for this desktop's identity (FR-14.19 → C11).
 *
 * ⚠ The keypair is generated in Rust and the private half never leaves the OS keystore, so
 * nothing about the key crosses this boundary — not to create it, not to use it. The page
 * sends a code and gets back nothing but success or a reason.
 */
export async function enrollDesktop(req: EnrollRequest): Promise<void> {
  return invoke('enroll_desktop', { req })
}

/** The shell's own status, re-read after something changes it. */
export async function refreshStatus(): Promise<ShellStatus | null> {
  return getStatus()
}

export interface UpdateCheck {
  /** A strictly newer version the hub is offering, if any. */
  available: string | null
  /** The hub refuses this build (FR-14.29). */
  required: boolean
  installKind: 'per_user' | 'per_machine'
  /**
   * ⚠ True on a per-machine install, which NEVER self-installs and never elevates. The UI must
   * say who will do it rather than offering a button that cannot work (FR-14.28 §5).
   */
  managed: boolean
}

/** Ask the hub what it is offering (FR-14.28). */
export async function checkForUpdates(): Promise<UpdateCheck> {
  return invoke<UpdateCheck>('check_for_updates')
}

/**
 * Install a version the hub offered.
 *
 * Answers `"installing"` or `"deferred"` — a till with a fiscal command in flight is not
 * interrupted, and one mid-receipt is never interrupted at all.
 */
export async function installUpdate(version: string): Promise<string> {
  return invoke<string>('install_update', { version })
}
