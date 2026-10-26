import type { Migration } from '../types.js'

/**
 * The `POS-OUT` session batch dispatches are records, not stock movements (FR-21.4, B-4).
 *
 * Until FR-21 the POS session-close handler wrote one `POS-OUT-…` dispatch per session (when the
 * org had an inventory account), created `completed` without `confirmMovement`. It changed no stock
 * and booked no COGS, because every POS sale had already moved its goods with its own `SM-`
 * dispatch. But it is a real `dispatch` row, so SUPTO 18.8, the FR-07 warehouse-operations report
 * and the digest's FR-11.7c materials counted every POS sale twice.
 *
 * This marks each one `recordOnly: true`, which those readers skip. Nothing is deleted: the row
 * stays as the history of what the old handler wrote, and SUPTO's rule is that no record is
 * removed. A batch is found by the session that points at it (`batchMovementId`) or by its number.
 *
 * Expand only: the previous release ignores the field and reads as before. Idempotent: a marked
 * row is not touched again.
 */
export const posOutRecordOnly: Migration = {
  id: '0006-pos-out-record-only',
  description: 'Mark the POS-OUT session batch dispatches record-only, so movement readers stop counting POS sales twice (FR-21.4)',
  async up({ db, log, orgFilter }) {
    const sessions = db.collection('possessions')
    const movements = db.collection('stockmovements')

    const ids: unknown[] = []
    for await (const s of sessions.find(
      { ...orgFilter, batchMovementId: { $exists: true, $ne: null } },
      { projection: { batchMovementId: 1 } },
    )) {
      ids.push(s.batchMovementId)
    }

    const res = await movements.updateMany(
      {
        ...orgFilter,
        recordOnly: { $ne: true },
        $or: [{ _id: { $in: ids as any[] } }, { movementNumber: { $regex: '^POS-OUT-' } }],
      },
      { $set: { recordOnly: true } },
    )
    log(`POS-OUT batch dispatches marked record-only: ${res.modifiedCount}`)
  },
}
