import { getRepos } from '../context.js'
import type { RepositoryRegistry } from 'dal'
import type { IPriceStep } from 'dal'

export interface PriceResolution {
  finalPrice: number
  steps: IPriceStep[]
}

export interface PriceOption {
  key: string
  name: string
  price: number
  type: 'base' | 'tag' | 'contact' | 'category' | 'tier'
}

export interface PriceOptionsResult {
  options: PriceOption[]
  resolvedKey: string
}

/**
 * Resolve the effective price for a product given a contact.
 *
 * Resolution chain (each matching step overrides the previous):
 *   1. Base selling price (always present)
 *   2. Category-based price (product.categoryPrices — lowest matching wins)
 *   3. Tag-based price (contact tags matched against product.tagPrices — lowest matching wins)
 *   4. Price tier (product.priceTiers with filters — lowest matching wins).
 *      Filterless tiers (no contactIds, no tags, no minQuantity, no validity) are
 *      display/storage slots only and never participate in resolution.
 *   5. Per-contact custom price (product.customPrices where contactId matches)
 *
 * User overrides happen client-side and are not resolved here.
 */
export async function resolvePrice(
  orgId: string,
  productId: string,
  contactId?: string,
  quantity?: number,
  repos?: RepositoryRegistry,
): Promise<PriceResolution> {
  const r = repos ?? getRepos()

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

  // Step 2: Category-based pricing — find matching category prices on the product
  if ((product as any).categoryPrices?.length > 0) {
    let bestCategoryPrice: { name: string; price: number } | null = null

    for (const cp of (product as any).categoryPrices) {
      // Check quantity threshold
      if (cp.minQuantity && qty < cp.minQuantity) continue
      // Check date validity
      if (cp.validFrom && new Date(cp.validFrom) > now) continue
      if (cp.validTo && new Date(cp.validTo) < now) continue
      // Pick the lowest matching category price
      if (!bestCategoryPrice || cp.price < bestCategoryPrice.price) {
        bestCategoryPrice = { name: cp.name, price: cp.price }
      }
    }

    if (bestCategoryPrice) {
      finalPrice = bestCategoryPrice.price
      steps.push({ type: 'category' as any, label: bestCategoryPrice.name || 'Category price', price: finalPrice })
    }
  }

  if (!contactId) {
    return { finalPrice, steps }
  }

  // Load contact to get their tags
  const contact = await r.contacts.findById(contactId)
  if (!contact) {
    return { finalPrice, steps }
  }

  // Step 3: Tag-based pricing — find all matching tag prices, pick the lowest
  const contactTags = (contact as any).tags || []
  if (contactTags.length > 0 && product.tagPrices?.length > 0) {
    let bestTagPrice: { name: string; tag: string; price: number } | null = null

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
        bestTagPrice = { name: tp.name, tag: tp.tag, price: tp.price }
      }
    }

    if (bestTagPrice) {
      finalPrice = bestTagPrice.price
      const label = bestTagPrice.name || `Tag '${bestTagPrice.tag}'`
      steps.push({ type: 'tag', label, price: finalPrice })
    }
  }

  // Step 4: Price tiers — filtered slots participate; filterless slots never do.
  if ((product as any).priceTiers?.length > 0) {
    let bestTier: { name: string; price: number } | null = null
    const contactIdStr = String(contactId)
    for (const t of (product as any).priceTiers) {
      const hasContactFilter = Array.isArray(t.contactIds) && t.contactIds.length > 0
      const hasTagFilter = Array.isArray(t.tags) && t.tags.length > 0
      const hasQtyFilter = t.minQuantity != null
      const hasDateFilter = t.validFrom != null || t.validTo != null
      // Filterless tiers are display-only — skip.
      if (!hasContactFilter && !hasTagFilter && !hasQtyFilter && !hasDateFilter) continue
      // All present filters must match (AND semantics).
      if (hasContactFilter && !t.contactIds.map(String).includes(contactIdStr)) continue
      if (hasTagFilter && !t.tags.some((tag: string) => contactTags.includes(tag))) continue
      if (hasQtyFilter && qty < t.minQuantity) continue
      if (t.validFrom && new Date(t.validFrom) > now) continue
      if (t.validTo && new Date(t.validTo) < now) continue
      if (!bestTier || t.finalPrice < bestTier.price) {
        bestTier = { name: t.name, price: t.finalPrice }
      }
    }
    if (bestTier) {
      finalPrice = bestTier.price
      steps.push({ type: 'tier', label: bestTier.name || 'Price tier', price: finalPrice })
    }
  }

  // Step 5: Per-contact custom price (most specific — overrides tier/tag price)
  if (product.customPrices?.length > 0) {
    const contactIdStr = String(contactId)
    let bestCustomPrice: { name: string; price: number } | null = null

    for (const cp of product.customPrices) {
      if (String(cp.contactId) !== contactIdStr) continue

      // Check quantity threshold
      if (cp.minQuantity && qty < cp.minQuantity) continue

      // Check date validity
      if (cp.validFrom && new Date(cp.validFrom) > now) continue
      if (cp.validTo && new Date(cp.validTo) < now) continue

      // Pick the lowest matching custom price
      if (!bestCustomPrice || cp.price < bestCustomPrice.price) {
        bestCustomPrice = { name: cp.name, price: cp.price }
      }
    }

    if (bestCustomPrice) {
      finalPrice = bestCustomPrice.price
      const label = bestCustomPrice.name || 'Contact custom price'
      steps.push({ type: 'contact', label, price: finalPrice })
    }
  }

  return { finalPrice, steps }
}

/**
 * List all available price options for a product (optionally filtered by contact).
 *
 * Returns every applicable price entry (base, category, tag, contact) along with
 * the key that the resolve chain would auto-select.
 */
export async function listPriceOptions(
  orgId: string,
  productId: string,
  contactId?: string,
  quantity?: number,
  repos?: RepositoryRegistry,
): Promise<PriceOptionsResult> {
  const r = repos ?? getRepos()
  const product = await r.products.findById(productId)
  if (!product) return { options: [], resolvedKey: '' }

  const options: PriceOption[] = []
  const now = new Date()
  const qty = quantity || 1

  // 1. Base selling price
  if (product.sellingPrice != null) {
    options.push({ key: 'selling', name: 'Selling price', price: product.sellingPrice, type: 'base' })
  }

  // 2. Category prices
  const categoryPrices = (product as any).categoryPrices || []
  categoryPrices.forEach((cp: any, i: number) => {
    if (!cp.price) return
    if (cp.minQuantity && qty < cp.minQuantity) return
    if (cp.validFrom && new Date(cp.validFrom) > now) return
    if (cp.validTo && new Date(cp.validTo) < now) return
    options.push({ key: `category-${i}`, name: cp.name || `Category price ${i + 1}`, price: cp.price, type: 'category' })
  })

  // 3. Tag prices (match against contact tags if contactId provided)
  let contactTags: string[] = []
  if (contactId) {
    const contact = await r.contacts.findById(contactId)
    contactTags = (contact as any)?.tags || []
  }

  const tagPrices = (product as any).tagPrices || []
  tagPrices.forEach((tp: any, i: number) => {
    if (!tp.price) return
    if (tp.minQuantity && qty < tp.minQuantity) return
    if (tp.validFrom && new Date(tp.validFrom) > now) return
    if (tp.validTo && new Date(tp.validTo) < now) return
    // Only include if contact has the matching tag, or if no contact selected (show all)
    if (contactId && tp.tag && !contactTags.includes(tp.tag)) return
    options.push({ key: `tag-${i}`, name: tp.name || `Tag price: ${tp.tag}`, price: tp.price, type: 'tag' })
  })

  // 4. Price tiers — filtered slots only (same semantics as resolvePrice); filterless
  //    slots are storage-only display columns and are never offered.
  const priceTiers = (product as any).priceTiers || []
  priceTiers.forEach((tp: any, i: number) => {
    if (!tp.finalPrice) return
    const hasContactFilter = Array.isArray(tp.contactIds) && tp.contactIds.length > 0
    const hasTagFilter = Array.isArray(tp.tags) && tp.tags.length > 0
    const hasQtyFilter = tp.minQuantity != null
    const hasDateFilter = tp.validFrom != null || tp.validTo != null
    if (!hasContactFilter && !hasTagFilter && !hasQtyFilter && !hasDateFilter) return
    if (hasQtyFilter && qty < tp.minQuantity) return
    if (tp.validFrom && new Date(tp.validFrom) > now) return
    if (tp.validTo && new Date(tp.validTo) < now) return
    // With a contact, only tiers whose contact/tag filters match are offered; without
    // a contact all filtered tiers stay listed for manual selection.
    if (contactId) {
      if (hasContactFilter && !tp.contactIds.map(String).includes(String(contactId))) return
      if (hasTagFilter && !tp.tags.some((tag: string) => contactTags.includes(tag))) return
    }
    options.push({ key: `tier-${i}`, name: tp.name || `Price tier ${i + 1}`, price: tp.finalPrice, type: 'tier' })
  })

  // 5. Contact-specific custom prices
  const customPrices = (product as any).customPrices || []
  customPrices.forEach((cp: any, i: number) => {
    if (!cp.price) return
    if (cp.minQuantity && qty < cp.minQuantity) return
    if (cp.validFrom && new Date(cp.validFrom) > now) return
    if (cp.validTo && new Date(cp.validTo) < now) return
    if (contactId && cp.contactId && String(cp.contactId) !== contactId) return
    if (!contactId && cp.contactId) return
    options.push({ key: `contact-${i}`, name: cp.name || `Custom price ${i + 1}`, price: cp.price, type: 'contact' })
  })

  // Resolved key mirrors resolvePrice exactly (same chain, same filter semantics):
  // resolve, then pick the option corresponding to the winning step.
  let resolvedKey = ''
  const resolution = await resolvePrice(orgId, productId, contactId, quantity, r)
  const winner = resolution.steps[resolution.steps.length - 1]
  if (winner) {
    const match = options.find(o => o.type === (winner.type as any) && Math.abs(o.price - winner.price) < 1e-9)
      || options.find(o => Math.abs(o.price - resolution.finalPrice) < 1e-9)
    resolvedKey = match?.key ?? ''
  }

  return { options, resolvedKey }
}
