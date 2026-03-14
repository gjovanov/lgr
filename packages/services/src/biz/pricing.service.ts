import { getRepos } from '../context.js'
import type { IPriceStep } from 'dal'

export interface PriceResolution {
  finalPrice: number
  steps: IPriceStep[]
}

/**
 * Resolve the effective price for a product given a contact.
 *
 * Resolution chain (each matching step overrides the previous):
 *   1. Base selling price (always present)
 *   2. Tag-based price (contact tags matched against product.tagPrices — lowest matching wins)
 *   3. Per-contact custom price (product.customPrices where contactId matches)
 *
 * User overrides happen client-side and are not resolved here.
 */
export async function resolvePrice(
  orgId: string,
  productId: string,
  contactId?: string,
  quantity?: number,
): Promise<PriceResolution> {
  const r = getRepos()

  const product = await r.products.findById(productId)
  if (!product) {
    throw new Error('Product not found')
  }

  const now = new Date()
  const qty = quantity ?? 1
  const steps: IPriceStep[] = []

  // Step 1: Base selling price
  let finalPrice = product.sellingPrice
  steps.push({ type: 'base', label: 'Selling price', price: finalPrice })

  if (!contactId) {
    return { finalPrice, steps }
  }

  // Load contact to get their tags
  const contact = await r.contacts.findById(contactId)
  if (!contact) {
    return { finalPrice, steps }
  }

  // Step 2: Tag-based pricing — find all matching tag prices, pick the lowest
  const contactTags = (contact as any).tags || []
  if (contactTags.length > 0 && product.tagPrices?.length > 0) {
    let bestTagPrice: { tag: string; price: number } | null = null

    for (const tp of product.tagPrices) {
      // Must match a contact tag
      if (!contactTags.includes(tp.tag)) continue

      // Check quantity threshold
      if (tp.minQuantity && qty < tp.minQuantity) continue

      // Check date validity
      if (tp.validFrom && new Date(tp.validFrom) > now) continue
      if (tp.validTo && new Date(tp.validTo) < now) continue

      // Pick the lowest matching tag price
      if (!bestTagPrice || tp.price < bestTagPrice.price) {
        bestTagPrice = { tag: tp.tag, price: tp.price }
      }
    }

    if (bestTagPrice) {
      finalPrice = bestTagPrice.price
      steps.push({ type: 'tag', label: `Tag '${bestTagPrice.tag}'`, price: finalPrice })
    }
  }

  // Step 3: Per-contact custom price (most specific — overrides tag price)
  if (product.customPrices?.length > 0) {
    const contactIdStr = String(contactId)
    let bestCustomPrice: number | null = null

    for (const cp of product.customPrices) {
      if (String(cp.contactId) !== contactIdStr) continue

      // Check quantity threshold
      if (cp.minQuantity && qty < cp.minQuantity) continue

      // Check date validity
      if (cp.validFrom && new Date(cp.validFrom) > now) continue
      if (cp.validTo && new Date(cp.validTo) < now) continue

      // Pick the lowest matching custom price
      if (bestCustomPrice === null || cp.price < bestCustomPrice) {
        bestCustomPrice = cp.price
      }
    }

    if (bestCustomPrice !== null) {
      finalPrice = bestCustomPrice
      steps.push({ type: 'contact', label: 'Contact custom price', price: finalPrice })
    }
  }

  return { finalPrice, steps }
}
