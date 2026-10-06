import { randomUUID } from 'crypto'

/** The identity a provider account yields, as `fetchUserInfo` maps it. */
export interface FakeIdentity {
  providerId: string
  email: string
  name: string
  /**
   * Google's `verified_email`. Defaults to true, as for nearly every real Google account. Set it
   * false to test the refusals: an unverified address can neither link an account nor found one.
   */
  emailVerified?: boolean
}

/**
 * Run `run`, a request to the callback, with Google faked at `fetch`: its token endpoint and its
 * userinfo endpoint, answering for `identity`. That is all the OAuth callback asks of a provider,
 * so a test can drive `GET /api/oauth/callback/google` through the real route table with no
 * network.
 *
 * Anything else the code under test fetches is a test bug, and throws. `fetch` and the client id
 * are put back afterwards, pass or fail — they are process-wide, and the next file must not
 * inherit a fake Google.
 */
export async function withFakeGoogle(identity: FakeIdentity, run: () => Promise<Response>): Promise<Response> {
  const realFetch = globalThis.fetch
  const realClientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'provider-access-token' })
    }
    if (url.startsWith('https://www.googleapis.com/userinfo/v2/me')) {
      return Response.json({
        id: identity.providerId,
        email: identity.email,
        name: identity.name,
        verified_email: identity.emailVerified ?? true,
      })
    }
    throw new Error(`unstubbed fetch: ${url}`)
  }) as any
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
    if (realClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID
    else process.env.GOOGLE_OAUTH_CLIENT_ID = realClientId
  }
}

/**
 * Google's redirect back to us, as sent by the browser that started a flow in `mode`: the state
 * carries a nonce, and the `oauth_state` cookie the start set holds the same one (S-04).
 */
export function googleCallbackRequest(mode: 'login' | 'register'): Request {
  const nonce = randomUUID()
  const state = Buffer.from(JSON.stringify({ mode, nonce })).toString('base64url')
  return new Request(`http://localhost/api/oauth/callback/google?code=provider-code&state=${state}`, {
    headers: { cookie: `oauth_state=${nonce}` },
  })
}
