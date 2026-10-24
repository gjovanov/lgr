import { config } from 'config'
import { frontClientIp } from '../front/front-guard.js'

/**
 * The address a request came from, as our own front proxy saw it.
 *
 * lgrai.app reaches the pod only through the nginx container on mars
 * (`/gjovanov/nginx/conf.d/lgrai.app.conf`), and the NodePort behind it is not public. That proxy
 * sets `X-Real-IP $remote_addr`, which REPLACES anything the client sent, and appends
 * `$remote_addr` to `X-Forwarded-For`. So `X-Real-IP` is trustworthy, and so is the LAST
 * `X-Forwarded-For` entry.
 *
 * ⚠ The FIRST `X-Forwarded-For` entry is whatever the client wrote. Trusting it lets a caller choose
 * which address a request is charged to — and choose someone else's, to get them locked out by the
 * sign-in throttle (S-08). This helper replaced a copy in `desktop-v1.controller.ts` that did
 * exactly that.
 *
 * ⚠ Behind the master's supervisor (FR-20.16) there is no nginx, so `X-Real-IP` and
 * `X-Forwarded-For` are whatever the client wrote. The address is then only the one the
 * supervisor's ingress stamped, and the two headers are never read.
 *
 * `undefined` when neither header is present (a local dev server with no proxy in front).
 */
export function clientIp(headers: Record<string, string | undefined>): string | undefined {
  if (config.front.secret) return frontClientIp(headers)

  const real = headers['x-real-ip']?.trim()
  if (real) return real.slice(0, 64)

  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last.slice(0, 64)
  }
  return undefined
}
