import type { Migration } from '../types.js'
import { copyCashRegisterOrg } from 'services/biz/cash-register/copy-org'

/**
 * Every POS transaction becomes its cash-register document (FR-21.21, §5.3).
 *
 * Since R2 the till writes its sales and stornos as `Invoice` documents (`cash_sale`, `cash_storno`,
 * with the `register` block). This copies the history: each `postransactions` row is inserted into
 * `invoices` under its own `_id`, keeping its number (`TXN-…`), УНП and times, and its stock
 * movement is linked by `invoiceId`. The org's other cash sales get `register.origin`.
 *
 * Per org (`services/biz/cash-register/copy-org.ts`, which a restore of an older bundle runs too):
 * a preflight that throws on a blocker before anything is written, the copy in batches of 500,
 * and a parity check over every row, session, day and SUPTO 18.1–18.5 cell that throws on any
 * mismatch. A migration that throws is not recorded, so it runs again once the blocker is cleared.
 *
 * Expand only: the rows stay where they are, and R1 reads both stores, de-duplicated by `_id`.
 * Idempotent: a row with its copy is not copied again, a linked movement is not relinked, an origin
 * already set is kept, and parity holds a second time.
 */
export const cashRegisterCopy: Migration = {
  id: '0008-cash-register-copy',
  description: 'Copy every POS transaction into its cash-register document, keeping its _id, number, УНП and times; parity-checked (FR-21.21)',
  async up({ db, log, orgFilter }) {
    const orgs = new Set<string>([
      ...(await db.collection('postransactions').distinct('orgId', { ...orgFilter })).map(String),
      ...(await db.collection('invoices').distinct('orgId', { ...orgFilter, type: 'cash_sale', 'register.origin': { $exists: false } })).map(String),
    ])
    for (const orgId of [...orgs].sort()) await copyCashRegisterOrg(db as any, orgId, log)
    log(`orgs copied: ${orgs.size}`)
  },
}
