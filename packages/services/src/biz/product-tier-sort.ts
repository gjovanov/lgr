import { PRICE_TIERS, PRICE_TIER_COLUMN_PREFIX } from 'config/constants'
import type { Filter, IBatchRepository, IProduct, PageResult } from 'dal'
import { findPageSortedBy } from './sorted-page.js'

/**
 * The Products list sorts by a price tier's column (`inventory-ui/.../product-price-columns.ts`).
 * A tier's price is an element of `priceTiers[]`, which a plain find cannot sort by.
 */

/** The tier a Products-list sort key names (`tier_1` → „Цена 1"), or null when it names none. */
export function tierForSortKey(sortBy: string | undefined | null): string | null {
  if (!sortBy?.startsWith(PRICE_TIER_COLUMN_PREFIX)) return null
  const slot = sortBy.slice(PRICE_TIER_COLUMN_PREFIX.length)
  return PRICE_TIERS.find((t) => t.key === slot)?.name ?? null
}

/**
 * One page of the filtered products, ordered by a tier's price: the tier found by name, spaces
 * ignored, as the list's cell finds it. An article with no price there (no such slot, or a zero
 * one) goes last either way, then by name.
 */
export function findProductsByTierPrice(
  products: IBatchRepository<IProduct>,
  filter: Filter<IProduct>,
  tierName: string,
  order: 1 | -1,
  page: number,
  size: number,
): Promise<PageResult<IProduct>> {
  const squashed = tierName.replace(/\s+/g, '')
  const tierPrice = {
    $let: {
      vars: {
        t: {
          $first: {
            $filter: {
              input: { $ifNull: ['$priceTiers', []] },
              cond: { $eq: [{ $replaceAll: { input: { $ifNull: ['$$this.name', ''] }, find: ' ', replacement: '' } }, squashed] },
            },
          },
        },
      },
      in: { $cond: [{ $gt: ['$$t.finalPrice', 0] }, '$$t.finalPrice', null] },
    },
  }
  return findPageSortedBy(products, filter, [{ $addFields: { sortKey: tierPrice } }], order, page, size, { name: 1 })
}
