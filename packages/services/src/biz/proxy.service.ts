import { logger } from '../logger/logger.js'

export async function proxyRequest(opts: {
  targetUrl: string
  method: string
  path: string
  headers: Record<string, string>
  body?: string
  timeout?: number
}): Promise<{ status: number; body: any }> {
  const url = `${opts.targetUrl}${opts.path}`
  try {
    const resp = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeout || 10000),
    })
    const body = await resp.json().catch(() => ({}))
    return { status: resp.status, body }
  } catch (err: any) {
    logger.error({ url, error: err.message }, 'Proxy request failed')
    return { status: 502, body: { message: 'Service unavailable' } }
  }
}
