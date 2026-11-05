import { config } from 'config'
import { Invoice } from 'db/models'
import { meetsMinimum } from '../desktop/version.js'

/**
 * #453: the first server release that reads FR-23's documents: a receipt for a payment on an invoice
 * (`payment_receipt`, R1) and a refund's storno (`payment_storno`, R2). An older master given an org that holds them
 * reads them by older rules: each reader with no `type` takes one for one more paid document, and R1's `bookingOf`
 * posts a refund as a sale, its money as money in (FR-23 §3, "Two versions at once").
 *
 * ⚠ 0.1.9, not 0.1.8: `server-v0.1.8` is cut from `release/server-0.1.8`, master at f31d1327 (2026-10-31) plus #418's
 * fix, before R1 (#416) and R2 (#441) merged, so it has neither, like 0.1.7. Name only a release whose own commit
 * carries both: what a master reports is its supervisor's Cargo version, never what its code knows.
 *
 * ⚠ Raise `NODE_MIN_MASTER_VERSION` to this once `server-v0.1.9` is out: then the uplink tells every older master
 * to update. Not before it is: every master in the field would be outdated with nothing to update to.
 */
export const FR23_MASTER_VERSION = '0.1.9'

const FR23_TYPES = ['payment_receipt', 'payment_storno'] as const

/** What the master says it runs: its last health report, else what it enrolled with. */
export function masterVersionOf(node: any): string | undefined {
  return node?.health?.versions?.app ?? node?.versions?.app ?? undefined
}

/**
 * Why this master may not take this org's data (a move or a re-seed), or null when it may. A master that names no
 * version is too old, as the uplink reads one (FR-20.58).
 */
export async function masterVersionRefusal(orgId: unknown, node: any): Promise<string | null> {
  const runs = masterVersionOf(node)
  const shown = runs ? String(runs).slice(0, 40) : 'an unknown version'
  if (!meetsMinimum(runs, config.node.minMasterVersion)) {
    return `the server runs ${shown}; lgrai.app needs ${config.node.minMasterVersion} or later: update it first`
  }
  if (!meetsMinimum(runs, FR23_MASTER_VERSION) && (await Invoice.exists({ orgId, type: { $in: [...FR23_TYPES] } }).exec())) {
    return `the server runs ${shown}, and the organisation has receipts or refunds for invoices that a server before ${FR23_MASTER_VERSION} reads as sales: update it first`
  }
  return null
}
