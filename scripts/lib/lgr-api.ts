/**
 * A session against the LGR API for a script driven by a person: `LGR_TOKEN`, or `LGR_USERNAME` +
 * `LGR_PASSWORD`. A token names one org, and a token for another org stops the script.
 */
import { assertTokenOrg } from './token-org.js'

export interface LgrSession {
  orgId: string
  get: (path: string) => Promise<any>
  post: (path: string, body: unknown) => Promise<any>
}

export class LgrApiError extends Error {
  constructor(readonly status: number, readonly body: any, what: string) {
    super(`${what} → ${status}: ${body?.message ?? JSON.stringify(body).slice(0, 300)}`)
  }
}

export async function signIn(api: string, orgSlug: string): Promise<LgrSession> {
  let token = process.env.LGR_TOKEN || ''

  const http = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new LgrApiError(res.status, json, `${method} ${path.split('?')[0]}`)
    return json
  }

  let orgId: string
  if (token) {
    const me = await http('GET', '/api/auth/me')
    assertTokenOrg(me, orgSlug) // a token from a tab switched to another org must not write there
    orgId = me.user?.orgId || me.orgId
  } else {
    const { LGR_USERNAME: username, LGR_PASSWORD: password } = process.env
    if (!username || !password) {
      console.error('Set LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.')
      process.exit(2)
    }
    const res = await http('POST', '/api/auth/login', { orgSlug, username, password })
    token = res.token
    orgId = res.org?.id || res.user?.orgId
  }

  return {
    orgId,
    get: path => http('GET', `/api/org/${orgId}${path}`),
    post: (path, body) => http('POST', `/api/org/${orgId}${path}`, body),
  }
}
