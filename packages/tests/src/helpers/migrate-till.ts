import { mongoose } from 'db/connection'
import { backfillCashSaleOrigin, copyPosRows } from 'services/biz/cash-register/copy-org'
import { FREEZE_MIGRATION, resetRegisterReadiness } from 'services/biz/cash-register/freeze-check'

/**
 * FR-21 R4 — what migrations 0008/0009 do to an org's till history on a real node: every POS row
 * becomes its cash-register document, its movement is linked, the other cash sales get their
 * origin, and 0009 is recorded, so the cash-register routes answer (FR-21.28). Since R4 the readers
 * read documents only, so a test that seeds legacy POS rows (what an older release left) runs this
 * before it asserts what a reader sees.
 *
 * The copy's own steps, without the migration's preflight and parity: a fixture may hold a shape
 * the preflight blocks on a real node (a storno with no original), and each copy is still checked
 * against its row before it is written.
 */
export async function migrateTill(orgId: unknown): Promise<void> {
  const db = mongoose.connection.db as any
  await copyPosRows(db, String(orgId))
  await backfillCashSaleOrigin(db, String(orgId))
  await db.collection('_migrations').updateOne(
    { _id: FREEZE_MIGRATION },
    { $setOnInsert: { appliedAt: new Date(), appVersion: 'test', checksum: 'test' } },
    { upsert: true },
  )
  resetRegisterReadiness()
}
