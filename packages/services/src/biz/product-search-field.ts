import { Product } from 'db/models'
import { mongoose } from 'db/connection'
import { productSearchFieldOn } from './search.utils.js'

/**
 * FR-30.11: whether every article of the org carries the search field (`searchLower`), so a search may read it alone.
 *
 * The plugin keeps it on every write; a raw driver write and a row from before the backfill do not have it, and the
 * search then also reads such articles by their mirrors, which reads documents rather than index keys. One index read
 * (`{ orgId, searchLower }` at null), which finds nothing once the backfill has run.
 */
export async function productSearchFieldComplete(orgId: string): Promise<boolean> {
  if (!productSearchFieldOn()) return false
  return !(await Product.exists({ orgId: new mongoose.Types.ObjectId(orgId), searchLower: null }).exec())
}
