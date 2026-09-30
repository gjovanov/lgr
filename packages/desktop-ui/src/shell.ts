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

export interface ShellStatus {
  schemaVersion: number
  appVersion: string
  os: { platform: string; arch: string }
  serverUrl: string
  desktopName: string
  registration: { state: string; desktopId: string | null; orgSlug: string | null }
  bridge: { supported: boolean; devices: string[] }
  autostart: boolean
  openLgrOnLaunch: boolean
  logPath: string
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
