import { existsSync, readFileSync } from 'node:fs'
import { config, nodeRole } from 'config'

/**
 * FR-20.42 — whether this is a LINKED master: one registered with lgrai.app (at Control or Full),
 * whose people are lgrai.app's. Their names, addresses and passwords are changed there and reach
 * this master through the identity feed (FR-20.43). An Air-gapped master owns its people (FR-20.41).
 *
 * Registered means the supervisor keeps a node token for the API (`state/node-token.json`,
 * `LGR_NODE_TOKEN_FILE`). It removes the file when the master is not registered, and keeps it (run
 * out) while lgrai.app cannot be reached: a master in an outage is still linked, and its people's
 * edits wait for lgrai.app rather than splitting the person in two.
 */
export function isLinkedMaster(): boolean {
  return nodeRole() === 'master' && !!config.outbox.tokenFile && existsSync(config.outbox.tokenFile)
}

/** The lgrai.app this master is linked to (`https://…`, no trailing slash), or null. */
export function linkedServer(): string | null {
  if (!isLinkedMaster()) return null
  try {
    const server = JSON.parse(readFileSync(config.outbox.tokenFile, 'utf8'))?.server
    return typeof server === 'string' && /^https:\/\/[^\s/]+/.test(server) ? server.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}
