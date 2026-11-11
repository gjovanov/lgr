/**
 * FR-28.12 — a goods receipt that names its supplier, for the PlusMinus receipt scripts.
 *
 * The scripts only have the API, so the supplier is found in the organization's own contact list: the search the
 * contacts page uses (`GET /invoicing/contact?type=supplier&search=`) brings every contact whose name holds the
 * words, and `pickSupplierByName` (`services/biz/doc-import/supplier-name.ts`, the same rule as the server's
 * `matching.ts#matchSupplierByName`) keeps the ONE active supplier whose name is exactly the partner's, or the same
 * words with other punctuation; and when nobody is named that, the one that keeps the name among its other names
 * („Also known as": the search reads those too).
 *
 * It creates nothing. A name that matches none or several resolves to nothing, and the caller reports it.
 * Answers are cached by normalized name: a day's receipts repeat their suppliers.
 */
import {
  foldName, normalizeName, pickSupplierByName, type SupplierCandidate, type SupplierNameMatch,
} from '../../packages/services/src/biz/doc-import/supplier-name.js'

/** `get` is an org-relative GET (`/invoicing/contact?...`) that returns the parsed JSON. */
export type OrgGet = (path: string) => Promise<any>

/** The contact search returns this many to a page; a name of common words may need a few. */
const PAGE = 50
const MAX_PAGES = 6

export function createSupplierResolver(get: OrgGet) {
  const cache = new Map<string, Promise<SupplierNameMatch>>()

  /** Every supplier the contact search finds for `text`, a few pages of them. */
  async function found(text: string): Promise<SupplierCandidate[]> {
    const candidates: SupplierCandidate[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await get(`/invoicing/contact?type=supplier&search=${encodeURIComponent(text)}&page=${page}&size=${PAGE}`)
      const rows: any[] = d.contacts || []
      for (const c of rows) candidates.push({ id: String(c._id ?? c.id), companyName: c.companyName, type: c.type, isActive: c.isActive, aliases: c.aliases })
      if (!rows.length || (page + 1) * PAGE >= (d.total ?? 0)) break
    }
    return candidates
  }

  /** The candidates by their own names only: what the rule read before a contact had other names. */
  const ownNames = (cs: SupplierCandidate[]): SupplierCandidate[] => cs.map((c) => ({ ...c, aliases: undefined }))

  async function lookup(name: string): Promise<SupplierNameMatch> {
    const first = await found(name)
    const exact = pickSupplierByName(name, ownNames(first))
    if (exact.status !== 'none') return exact
    // The search wants every word typed to be inside one of the contact's names, and a hyphen standing alone is a
    // word: a supplier kept as „ИВ БОДИ ЕООД" is not among the answers for „ИВ - БОДИ ЕООД". The name's words
    // without their punctuation are inside both: ask again with those, and let the rule choose among what comes back.
    const words = foldName(name)
    const second = !words || words === normalizeName(name) ? [] : await found(words)
    const alike = pickSupplierByName(name, ownNames(second))
    if (alike.status !== 'none') return alike
    // Nobody is NAMED that, in either answer. Only now the other names („Also known as") are read, among everything
    // both searches brought: a supplier's own name always comes before another supplier's other name, and asking
    // the other names of the first answer alone could decide before the second had been asked for a name.
    const seen = new Set(first.map((c) => c.id))
    return pickSupplierByName(name, [...first, ...second.filter((c) => !seen.has(c.id))])
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
