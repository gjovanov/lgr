/**
 * Clone ids: what a copied document is called in the test org.
 *
 * ⚠ IMPORT-PURE (no models, no database): the whole scheme is arithmetic on a 24-hex id, so it can
 * be proven in a unit test and read anywhere.
 *
 * **Why a function, not a table.** LGR is one database for every tenant, so a copy cannot keep its
 * `_id`: org A's `contacts` and org B's `contacts` are one physical collection, and the second
 * insert of an id is a duplicate-key error. The copy needs new ids and every reference rewritten
 * to match. The restore's remap (`backup-restore.service.ts#buildIdMap`) does that with RANDOM ids
 * and a map it keeps in memory, which is right for a restore that runs once. A copy that is
 * brought up to date every night needs the same source document to get the same id on every run, or
 * the second run would insert a second copy of everything. So the new id is a pure function of the
 * source id and the target org: no table to persist, nothing to lose, the same answer from any
 * process on any day.
 *
 * **The function.** An ObjectId is 4 bytes of creation time, 5 of per-process random, 3 of counter.
 * The last 8 bytes are XORed with a mask derived from the target org's id; the time stays.
 *
 * - **Injective** (XOR with a constant), so two source documents never share a copy's id.
 * - **Its own inverse**: `cloneIdHex(cloneIdHex(x, t), t) === x`, so a copy's source is recoverable.
 * - **Keeps `getTimestamp()`**, so a list sorted by `_id` still reads in creation order (to the
 *   second), and "when was this created" is still true of the copy.
 * - **Never the source id** (the mask is not zero), and it cannot meet a different live id except
 *   by chance: 2^-64 per pair within one second of creation time.
 */
import { createHash } from 'node:crypto'

export const HEX24 = /^[0-9a-f]{24}$/

const masks = new Map<string, Buffer>()

/** The 8 bytes XORed into a copied id: a function of the TARGET org only. */
export function cloneMask(targetOrgId: string): Buffer {
  const key = String(targetOrgId).toLowerCase()
  if (!HEX24.test(key)) throw new Error(`not an org id: ${JSON.stringify(targetOrgId)}`)
  let mask = masks.get(key)
  if (!mask) {
    mask = createHash('sha256').update(`lgr-org-clone/v1/${key}`).digest().subarray(0, 8)
    // A zero mask would make a copy's id equal its source's. 2^-64, but the check is one line.
    if (mask.every(b => b === 0)) throw new Error('degenerate clone mask')
    masks.set(key, mask)
  }
  return mask
}

/** The id `sourceId`'s copy carries in `targetOrgId`. Applying it again undoes it. */
export function cloneIdHex(sourceId: string, targetOrgId: string): string {
  const id = String(sourceId).toLowerCase()
  if (!HEX24.test(id)) throw new Error(`not an ObjectId: ${JSON.stringify(sourceId)}`)
  const bytes = Buffer.from(id, 'hex')
  const mask = cloneMask(targetOrgId)
  for (let i = 0; i < 8; i++) bytes[4 + i] ^= mask[i]
  return bytes.toString('hex')
}
