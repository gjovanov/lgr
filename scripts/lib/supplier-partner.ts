/**
 * FR-28.12 — a goods receipt that names its supplier, for the PlusMinus receipt scripts.
 *
 * The scripts only have the API, so the supplier is found in the organization's own contact list: the search the
 * contacts page uses (`GET /invoicing/contact?type=supplier&search=`) brings every contact whose name holds the
 * words, and `pickSupplierByName` (`services/biz/doc-import/supplier-name.ts`, the same rule as the server's
 * `matching.ts#matchSupplierByName`) keeps the ONE active supplier whose name is exactly the partner's.
 *
 * It creates nothing. A name that matches none or several resolves to nothing, and the caller reports it.
 * Answers are cached by normalized name: a day's receipts repeat their suppliers.
 */
import {
  normalizeName, pickSupplierByName, type SupplierCandidate, type SupplierNameMatch,
} from '../../packages/services/src/biz/doc-import/supplier-name.js'

/** `get` is an org-relative GET (`/invoicing/contact?...`) that returns the parsed JSON. */
export type OrgGet = (path: string) => Promise<any>

/** The contact search returns this many to a page; a name of common words may need a few. */
const PAGE = 50
const MAX_PAGES = 6

export function createSupplierResolver(get: OrgGet) {
  const cache = new Map<string, Promise<SupplierNameMatch>>()

  async function lookup(name: string): Promise<SupplierNameMatch> {
    const candidates: SupplierCandidate[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await get(`/invoicing/contact?type=supplier&search=${encodeURIComponent(name)}&page=${page}&size=${PAGE}`)
      const rows: any[] = d.contacts || []
      for (const c of rows) candidates.push({ id: String(c._id ?? c.id), companyName: c.companyName, type: c.type, isActive: c.isActive })
      if (!rows.length || (page + 1) * PAGE >= (d.total ?? 0)) break
    }
    return pickSupplierByName(name, candidates)
  }

  return {
    /** The supplier this bare name is, once per name. A failed lookup is not cached: the next document asks again. */
    resolve(name: string): Promise<SupplierNameMatch> {
      const key = normalizeName(name)
      if (!key) return Promise.resolve({ status: 'none' })
      let hit = cache.get(key)
      if (!hit) {
        hit = lookup(name)
        cache.set(key, hit)
        hit.catch(() => cache.delete(key))
      }
      return hit
    },
  }
}
