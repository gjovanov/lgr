/**
 * The shell's state: one copy of `get_status` / `get_settings`, shared by all five views.
 *
 * ⚠ Module-level refs on purpose. Every view reads the same two records and Settings writes
 * them; a per-component fetch means Overview shows a stale registration chip for as long as it
 * stays mounted, which is exactly the value an operator reads out during a support call.
 *
 * ⚠ Nothing here touches the network. These pages must render with the machine's network off
 * (FR-14.31) — everything comes from Rust over `invoke`, and in a plain browser tab it is all
 * `null`, which the views render as "opened in a browser" rather than as an error.
 */
import { computed, ref } from 'vue'
import {
  getSettings, getStatus, inShell,
  type ShellSettings, type ShellStatus,
} from '../shell'

const status = ref<ShellStatus | null>(null)
const settings = ref<ShellSettings | null>(null)
const loading = ref(false)
const loaded = ref(false)

/**
 * A `lgr://` link that arrived before any page was listening (FR-14.12).
 *
 * ⚠ Rust hands it over exactly ONCE (`take_pending_deep_link`), so whoever calls that command
 * owns it. `App.vue` is the only caller — it has to be, since the link decides which view to
 * show — and it parks the payload here for Onboarding to read. Letting Onboarding call the
 * command too would mean whichever mounted first swallowed the link and the other saw nothing.
 */
const pendingDeepLink = ref<string | null>(null)

/** ±2 minutes, per FR-14.30's banner. Below this nothing is said. */
export const CLOCK_SKEW_LIMIT_MS = 2 * 60 * 1000

export interface ShellBanner {
  /** Stable id — C15 asserts on these rather than on translated text. */
  id: 'not-registered' | 'revoked' | 'key-in-file' | 'clock-skew' | 'update-required' | 'server-unreachable'
  severity: 'info' | 'warning' | 'error'
  titleKey: string
  bodyKey: string
  /** Interpolation for both strings. */
  params?: Record<string, string | number>
  /**
   * ⚠ A banner without a fix is a complaint (C09). Where `action` is absent the body must
   * already say what the person should do — `revoked`, `key-in-file` and `clock-skew` all do.
   */
  action?: { labelKey: string; kind: 'register' | 'update' | 'retry' }
  secondary?: { labelKey: string; kind: 'diagnostics' }
}

export function useShellState() {
  async function load(): Promise<void> {
    loading.value = true
    try {
      const [s, cfg] = await Promise.all([getStatus(), getSettings()])
      status.value = s
      settings.value = cfg
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  const registration = computed(() => status.value?.registration.state ?? 'not_registered')
  const orgName = computed(() => status.value?.registration.orgSlug || '')

  /**
   * The banners, in the order an operator should act on them: what stops the app working
   * first, what merely needs attention last.
   */
  const banners = computed<ShellBanner[]>(() => {
    const s = status.value
    if (!s) return []
    const out: ShellBanner[] = []

    if (s.registration.state === 'revoked') {
      out.push({
        id: 'revoked',
        severity: 'error',
        titleKey: 'shell.banner.revoked.title',
        bodyKey: 'shell.banner.revoked.body',
        params: { org: s.registration.orgSlug || '—' },
      })
    } else if (s.registration.state === 'not_registered') {
      out.push({
        id: 'not-registered',
        severity: 'info',
        titleKey: 'shell.banner.notRegistered.title',
        bodyKey: 'shell.banner.notRegistered.body',
        action: { labelKey: 'shell.banner.notRegistered.action', kind: 'register' },
      })
    }

    if (s.update.required) {
      out.push({
        id: 'update-required',
        severity: 'error',
        titleKey: 'shell.banner.updateRequired.title',
        bodyKey: 'shell.banner.updateRequired.body',
        action: { labelKey: 'shell.banner.updateRequired.action', kind: 'update' },
      })
    }

    if (s.serverLink === 'unreachable') {
      out.push({
        id: 'server-unreachable',
        severity: 'error',
        titleKey: 'shell.banner.serverUnreachable.title',
        bodyKey: 'shell.banner.serverUnreachable.body',
        action: { labelKey: 'shell.banner.serverUnreachable.action', kind: 'retry' },
        secondary: { labelKey: 'shell.banner.serverUnreachable.diagnostics', kind: 'diagnostics' },
      })
    }

    // ⚠ Only meaningful once there IS a key. An unregistered desktop storing nothing in a file
    // is not a warning, it is the normal state.
    if (s.keyStorage === 'file') {
      out.push({
        id: 'key-in-file',
        severity: 'warning',
        titleKey: 'shell.banner.keyInFile.title',
        bodyKey: 'shell.banner.keyInFile.body',
      })
    }

    const skew = s.clockSkewMs
    if (skew !== null && Math.abs(skew) > CLOCK_SKEW_LIMIT_MS) {
      out.push({
        id: 'clock-skew',
        severity: 'warning',
        titleKey: 'shell.banner.clockSkew.title',
        bodyKey: 'shell.banner.clockSkew.body',
        // Rounded to whole minutes and always positive: "7 minutes out" is what someone says on
        // the phone, not "-412 931 ms".
        params: { minutes: Math.round(Math.abs(skew) / 60000) },
      })
    }

    return out
  })

  /** Read and clear — a link must pre-fill the setup screen once, not on every visit. */
  function takeDeepLink(): string | null {
    const v = pendingDeepLink.value
    pendingDeepLink.value = null
    return v
  }

  return {
    status, settings, loading, loaded, inShell,
    registration, orgName, banners, pendingDeepLink,
    load, takeDeepLink,
  }
}
