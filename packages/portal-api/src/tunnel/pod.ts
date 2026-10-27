/**
 * Where lgrai.app's other pods reach this one (FR-20.73, plan step P3-4d). A request to an org's
 * address lands on any pod; the one holding the server's uplink carries it, and the others forward
 * it there. The uplink's presence row records this address beside the pod's name (`uplink.ts`).
 *
 * - `LGR_POD_ADDR` when set (several processes on one machine: the tests);
 * - else `http://<POD_IP or the first non-internal IPv4>:<PORT>`: in Kubernetes, the pod's own IP;
 * - null when there is no such address: then nothing is ever forwarded here.
 */
import { networkInterfaces } from 'node:os'
import { config } from 'config'

let detected: string | null | undefined

function firstIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

/** `http://<host>:<port>` of this process, as another pod reaches it, or null. */
export function podAddr(): string | null {
  const set = process.env.LGR_POD_ADDR?.trim()
  if (set) return set.replace(/\/+$/, '')
  if (detected === undefined) {
    const ip = process.env.POD_IP?.trim() || firstIPv4()
    detected = ip ? `http://${ip.includes(':') ? `[${ip}]` : ip}:${config.port}` : null
  }
  return detected
}
