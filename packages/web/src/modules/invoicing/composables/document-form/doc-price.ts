/**
 * "One price for the whole document" — the pure part (no Vue, no I/O), unit-tested in
 * `packages/tests/src/unit/doc-price.test.ts`.
 *
 * Each line's price list is the one its per-line picker shows (`GET /pricing/options?all=true`):
 * the base selling price plus the product's named prices — the tier slots „Цена 1"…„Цена 10",
 * „Цена на едро", tag and contact prices. A document-wide choice is one of those NAMES, applied
 * to each line's own product: „Цена 3" is a different amount on every product, which is the
 * point of choosing it once for the whole document.
 */

export interface PriceOptionLike {
  key: string
  name: string
  price: number
  type: string
}

/** The base option is matched by its type: its server-side name is fixed English text. */
export const BASE_CHOICE = '__base__'

export function choiceKeyOf(opt: Pick<PriceOptionLike, 'name' | 'type'>): string {
  return opt.type === 'base' ? BASE_CHOICE : String(opt.name ?? '').trim()
}

export interface DocPriceChoice {
  key: string
  /** The name as the products carry it (the base choice is labelled by the caller). */
  name: string
  type: string
  /** How many of the priced lines offer this price. */
  lines: number
}

/**
 * The choices to offer, given each priced line's options (one array per line). The base price
 * comes first, the rest in the order they first appear — a product lists its tiers in slot
 * order, so „Цена 1" precedes „Цена 2". A name repeated within one product counts once.
 */
export function collectDocPriceChoices(optionsPerLine: PriceOptionLike[][]): DocPriceChoice[] {
  const byKey = new Map<string, DocPriceChoice>()
  for (const options of optionsPerLine) {
    const seen = new Set<string>()
    for (const opt of options || []) {
      const key = choiceKeyOf(opt)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const known = byKey.get(key)
      if (known) known.lines++
      else byKey.set(key, { key, name: opt.name, type: opt.type, lines: 1 })
    }
  }
  const all = [...byKey.values()]
  return [...all.filter((c) => c.key === BASE_CHOICE), ...all.filter((c) => c.key !== BASE_CHOICE)]
}

/**
 * The option a line takes for a document-wide choice, or undefined when its product has no
 * price by that name — that line then keeps the price it has. A tier wins when a product offers
 * the same name twice (a tier and a legacy tag price).
 */
export function optionForChoice<T extends PriceOptionLike>(options: T[], key: string): T | undefined {
  const matches = (options || []).filter((o) => choiceKeyOf(o) === key)
  return matches.find((o) => o.type === 'tier') ?? matches[0]
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
