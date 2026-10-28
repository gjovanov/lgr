import { setSession } from 'ui-shared/session/session'

/**
 * Signing in at a till with operator code + PIN (FR-20.40, plan step P1-5b).
 *
 * Offered only where the server says so: an on-prem master, asked through a desktop paired with
 * it (the shell's proxy adds the desktop's token). On lgrai.app `/auth/local/*` answers 404 and
 * none of this appears.
 *
 * Plain `fetch`, not the shared HTTP client: these calls run with no session, or with the last
 * operator's, and the client's 401 recovery would sign the tab out or send it to the portal.
 */

let offered: Promise<boolean> | undefined

/** Whether the PIN pad may be shown here. Asked once per page load. */
export function pinOffered(): Promise<boolean> {
  offered ??= fetch('/api/auth/local/methods', { credentials: 'same-origin' })
    .then(async res => res.ok && (await res.json())?.pin === true)
    .catch(() => false)
  return offered
}

export type PinFailure = { code: string; retryAfterSeconds?: number }

/** Sign in; on success this tab holds the new session. Returns the failure, or null. */
export async function signInWithPin(operatorCode: string, pin: string): Promise<PinFailure | null> {
  let res: Response
  try {
    res = await fetch('/api/auth/local/pin', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorCode, pin }),
    })
  } catch {
    return { code: 'network' }
  }
  const body: any = await res.json().catch(() => null)
  if (res.ok && body?.token) {
    setSession(body.token, body.org ?? null)
    return null
  }
  const retry = Number(res.headers.get('retry-after')) || body?.retryAfterSeconds
  return { code: body?.code || (res.status === 404 ? 'not_found' : 'failed'), ...(retry ? { retryAfterSeconds: retry } : {}) }
}
