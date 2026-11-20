import type { Migration } from '../types.js'

/**
 * FR-20.60, AC 27: global keeps the receipt of a mail it relayed for a master 60 days, no longer 7.
 *
 * A master keeps a queued item 45 days (`outbox-worker.ts`), past a 30-day outage, and the receipt is what stops its
 * retry from mailing twice: one that expires while the master may still retry lets a mail whose answer was lost go out
 * again. The schema declares the longer window, but an existing collection keeps the TTL it was made with (an index
 * with the same key and other options is refused, not rebuilt), so the window is changed here, in place.
 *
 * Skips a node without the collection or the index, and an index already at 60 days. Idempotent. Node state, not org
 * data: `orgFilter` does not apply. The 60 is written here, not imported: a released migration never changes.
 *
 * Rollback: the previous release declares 7 days over the same key and builds nothing; its receipts live 60 days,
 * which it reads the same way.
 */
const COLLECTION = 'relay_receipts'
const KEEP_SECS = 60 * 24 * 3600

export const relayReceiptsKept60Days: Migration = {
  id: '0021-relay-receipts-kept-60-days',
  description: "Keep a relayed mail's receipt 60 days, past the 45 a master keeps the mail (FR-20.60, AC 27)",
  async up({ db, log }) {
    if (!(await db.listCollections({ name: COLLECTION }, { nameOnly: true }).toArray()).length) return
    const indexes = (await db.collection(COLLECTION).indexes()) as Array<{ key: Record<string, unknown>; expireAfterSeconds?: number }>
    const ttl = indexes.find(i => JSON.stringify(i.key) === '{"at":1}' && typeof i.expireAfterSeconds === 'number')
    if (!ttl || ttl.expireAfterSeconds === KEEP_SECS) return
    await db.command({ collMod: COLLECTION, index: { keyPattern: { at: 1 }, expireAfterSeconds: KEEP_SECS } })
    log(`${COLLECTION}: receipts kept 60 days (were ${Math.round(Number(ttl.expireAfterSeconds) / 86400)})`)
  },
}
