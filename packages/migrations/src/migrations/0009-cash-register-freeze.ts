import type { Migration } from '../types.js'
import { CashRegisterCopyError, copyCashRegisterOrg } from 'services/biz/cash-register/copy-org'

/**
 * The freeze of `postransactions` (FR-21.25, R3).
 *
 * From R3 the `POSTransaction` model refuses every write (FR-21.26), so the rows are final. This
 * copies the stragglers 0008 could not have seen: rows an older release wrote after 0008 ran, in a
 * rollback to R1 between the two. Then it re-runs the parity check over the WHOLE history of every
 * org that has POS rows: each copy against its row, every session and day, and SUPTO 18.1–18.5
 * cell for cell. Any mismatch throws, so 0009 is not recorded and runs again once it is cleared.
 *
 * The work is 0008's own (`copy-org.ts`): a row with its copy is not copied again, so on a node
 * where nothing was written since 0008 this only proves parity. Each org runs on its own, and the
 * migration throws at the end naming the orgs that failed.
 *
 * R4's startup check (FR-21.28) names this id: without it recorded, the cash-register routes answer
 * 503, because the readers stop reading `postransactions` then.
 */
export const cashRegisterFreeze: Migration = {
  id: '0009-cash-register-freeze',
  description: 'Freeze postransactions: copy any row written since 0008, then parity over the whole till history (FR-21.25)',
  async up({ db, log, orgFilter }) {
    const orgs = (await db.collection('postransactions').distinct('orgId', { ...orgFilter })).map(String).sort()
    const failed: { orgId: string; message: string }[] = []
    for (const orgId of orgs) {
      try {
        const { copied } = await copyCashRegisterOrg(db as any, orgId, log)
        if (copied) log(`org ${orgId}: ${copied} straggler(s) copied`)
      } catch (e: any) {
        log(`org ${orgId}: NOT frozen: ${e?.message || e}`)
        failed.push({ orgId, message: e?.message || String(e) })
      }
    }
    if (failed.length) throw new CashRegisterCopyError(failed.map(f => f.orgId).join(', '), failed.map(f => f.message))
    log(`orgs with till history checked: ${orgs.length}`)
  },
}
