/**
 * "Sign in with LGR" in the browser (FR-20.39, plan step P2-4): the PKCE pair, the state, and where
 * the person comes back to.
 *
 * - **On a master**, `startLgrSignIn` keeps the verifier in THIS tab's sessionStorage under its state
 *   and sends the tab to lgrai.app's authorize page; the callback page takes it back by the state.
 *   The verifier never travels: lgrai.app sees only its S256 challenge.
 * - **On lgrai.app**, an authorize page reached while signed out keeps its own address
 *   (`IDP_RESUME_KEY`) and sends the person to sign in; the sign-in pages come back to it.
 */

export const IDP_RESUME_KEY = 'lgr_idp_resume'
const FLOW_PREFIX = 'lgr_idp:'

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge: b64url(digest) }
}

/** On a master: off to lgrai.app, to come back to this origin's callback page. */
export async function startLgrSignIn(cfg: { server: string; clientId: string }): Promise<void> {
  const { verifier, challenge } = await pkce()
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)))
  const redirectUri = `${window.location.origin}/auth/idp/callback`
  sessionStorage.setItem(`${FLOW_PREFIX}${state}`, JSON.stringify({ verifier, redirectUri, at: Date.now() }))
  const to = new URL('/idp/authorize', cfg.server)
  to.searchParams.set('client_id', cfg.clientId)
  to.searchParams.set('redirect_uri', redirectUri)
  to.searchParams.set('state', state)
  to.searchParams.set('code_challenge', challenge)
  to.searchParams.set('code_challenge_method', 'S256')
  window.location.assign(to.toString())
}

/** On a master: the flow this tab started under `state`, once (an hour at most). */
export function takeLgrSignIn(state: string): { verifier: string; redirectUri: string } | null {
  const key = `${FLOW_PREFIX}${state}`
  const raw = sessionStorage.getItem(key)
  sessionStorage.removeItem(key)
  try {
    const flow = raw ? JSON.parse(raw) : null
    return flow && typeof flow.verifier === 'string' && Date.now() - Number(flow.at) < 3600_000 ? flow : null
  } catch {
    return null
  }
}

/** On lgrai.app: the authorize page to come back to after signing in, once. Nothing else is honoured. */
export function takeIdpResume(): string | null {
  const path = sessionStorage.getItem(IDP_RESUME_KEY)
  sessionStorage.removeItem(IDP_RESUME_KEY)
  return path && path.startsWith('/idp/authorize?') ? path : null
}
