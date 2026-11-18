/**
 * FR-32.22 (#797): a purchase bill's product update — what its lines stage on their products, seeded from each
 * product, and the purchase price that cascades to the tiers. The switch and the columns are `state.ts`'s.
 */
import { watch } from 'vue'
import { getProduct, listProducts, type Product } from '../../../api/products'
import { listProductCategories } from '../../../api/product-categories'
import { cascadePurchasePrice, needsSeed, productsForSeed, seedFromProduct, setProductField, setTierPrice } from 'ui-shared/composables/gr-product-update'
import type { FormState, Line } from './state'

export function useFormProductUpdate(s: FormState) {
  const { form, grColumnsVisible, grCategories } = s

  // ── GR product-update helpers (purchase bills only) ──
  // What a line stages, its base and what reaches the product: `ui-shared/composables/gr-product-update.ts`.
  function setGRField(line: Line, field: string, value: any) {
    setProductField(line, field, value)
  }

  /** A price typed into a tier's column: the tier of that NAME on the line's product. */
  function setGRTierPrice(line: Line, tierName: string, val: any) {
    setTierPrice(line, tierName, val)
  }

  async function fetchProductForSeed(id: string): Promise<Product | null> {
    try {
      return (await getProduct(id)).product
    } catch {
      return null
    }
  }

  /** Load the line's product and stage its current fields and tiers on the line, with their base. */
  async function seedLineProductUpdate(idx: number, priceAtPick?: number) {
    const line = form.lines[idx]
    if (!line?.productId) return
    const productId = String(line.productId)
    const priceBefore = priceAtPick ?? line.unitPrice
    const product = await fetchProductForSeed(productId)
    // The line may have been given another product while this one loaded.
    if (!product || String(line.productId) !== productId) return
    Object.assign(line, seedFromProduct(product, productId))
    // A price typed while the product loaded is its new purchase price, as if typed after.
    if (line.unitPrice !== priceBefore) cascadePurchasePrice(line, line.unitPrice)
  }

  /**
   * Seed every line that names a product and stages nothing yet: a loaded bill, an import, lines
   * from the ledger or a copy, the switch turned on. All of a bill's articles are read at once.
   */
  async function seedUnseededLines() {
    if (!grColumnsVisible.value) return
    const pending = form.lines.filter(needsSeed)
    if (!pending.length) return
    const products = await productsForSeed(
      async (ids) => (await listProducts({ ids: ids.join(','), size: ids.length })).products,
      [...new Set(pending.map((l) => String(l.productId)))],
    )
    for (const line of pending) {
      const p = products.get(String(line.productId))
      // Staged meanwhile (a product picked again while these loaded): that line keeps its own.
      if (p && needsSeed(line)) Object.assign(line, seedFromProduct(p, String(line.productId)))
    }
  }

  async function fetchGRCategories() {
    try {
      grCategories.value = (await listProductCategories({ size: 0 })).productCategories
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
  }

  /**
   * The bill's unit price is the article's new purchase price: staged on the line's product, with
   * the tiers that follow the purchase price moved along (`cascadePurchasePrice` says which do).
   */
  function applyGRPriceCascade(idx: number) {
    const line = form.lines[idx]
    if (!line || !grColumnsVisible.value) return
    cascadePurchasePrice(line, line.unitPrice)
  }

  // The columns appearing (the switch turned on, the bill back in the org's currency) seed the
  // lines that name a product and stage nothing yet, and load the category options.
  watch(grColumnsVisible, async (on) => {
    if (!on) return
    if (!grCategories.value.length) void fetchGRCategories() // reference data, never rejects
    await seedUnseededLines()
  })

  return { setGRField, setGRTierPrice, seedLineProductUpdate, seedUnseededLines, fetchGRCategories, applyGRPriceCascade }
}

export type FormProductUpdate = ReturnType<typeof useFormProductUpdate>
