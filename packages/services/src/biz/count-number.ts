import { InventoryCount } from 'db/models'
import { ensureSequenceAtLeast, getNextNumber } from './sequence.service.js'

/**
 * An inventory count's number: `IC-<year>-NNNNN`, from the org's `IC` counter.
 *
 * Until 2026-11 it was the latest + 1, read and then written, by two copies of one reader (a new count, and the
 * count a manual adjustment makes for itself when it is confirmed), with no unique index beside it: counts made
 * at the same moment were saved under ONE number, and nothing said so (#713). The counter's `$inc` gives each
 * of them its own.
 *
 * The counter is first pulled past the highest number a count already holds, as `allocateOperatorCode` does for
 * operator codes: the counts numbered before the counter existed, a restored one, an imported one. Only the
 * numbers are read, never the counts (a full count has a line per article).
 *
 * A count that is then not saved leaves its number unused. A count's number is no legal number.
 */
export const COUNT_SERIES = 'IC'

export async function nextCountNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `${COUNT_SERIES}-${year}-`
  const numbered: any[] = await InventoryCount
    .find({ orgId, countNumber: { $regex: `^${prefix}[0-9]+$` } } as any, { countNumber: 1, _id: 0 })
    .lean()
    .exec()
  const held = numbered.reduce((max, c) => Math.max(max, parseInt(String(c.countNumber).slice(prefix.length), 10) || 0), 0)
  await ensureSequenceAtLeast(orgId, COUNT_SERIES, year, held)
  return getNextNumber(orgId, COUNT_SERIES, 5, year)
}
