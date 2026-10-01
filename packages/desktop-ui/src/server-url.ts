/**
 * The onboarding server-address rule (FR-14.11), as a pure function so it can be tested
 * without a webview.
 *
 * ⚠ `http://` is upgraded to `https://` **except for loopback**. The exception is not a
 * convenience: a developer's `http://localhost:4001` is the normal way to run the hub, and
 * upgrading it would make the shell unable to talk to a dev server at all. Everything else is
 * a real network, where a desktop credential and a session cookie must not cross it in clear.
 *
 * ⚠ Loopback is decided by HOSTNAME, never by the string containing "localhost". `http://localhost.evil.example`
 * is not loopback, and neither is `http://127.0.0.1.evil.example`.
 */

export interface NormalisedServerUrl {
  /** The address to store, or `null` when the input cannot be read as one. */
  url: string | null
  /** True when `http://` was rewritten, so the screen can say so rather than silently changing it. */
  upgraded: boolean
}

/** Exactly the hosts that may stay on `http://`. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true
  // The whole 127.0.0.0/8 block answers locally on every OS this ships to.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

export function normaliseServerUrl(raw: string): NormalisedServerUrl {
  const input = String(raw || '').trim()
  if (!input) return { url: null, upgraded: false }

  // A bare host is what people type. Assume https rather than rejecting it.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { url: null, upgraded: false }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, upgraded: false }
  }
  if (!parsed.hostname) return { url: null, upgraded: false }

  let upgraded = false
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    parsed.protocol = 'https:'
    upgraded = true
    // ⚠ Drop a port that only meant something under http. Keeping `:80` turns a working
    // `http://host:80` into a dead `https://host:80`, which reads as "the address I typed is
    // broken" rather than "the scheme changed".
    if (parsed.port === '80') parsed.port = ''
  }

  // Store an origin: the path comes from the desktop's assignment (FR-14.16), never from what
  // somebody pasted into the setup screen.
  return { url: parsed.origin, upgraded }
}
