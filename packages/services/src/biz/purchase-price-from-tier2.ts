/**
 * The one-time correction of an org's purchase prices (owner, 2026-11-15): „Покупна цена" = „Цена 2" / 1.2.
 *
 * Until then every import wrote PlusMinus's „Доставна цена" as the product's `purchasePrice`. That figure is the
 * price with the trade discount (it stays in the slot of that name, drawn as „Цена с ТО"); PlusMinus keeps no buying
 * price, and „Цена 2" / 1.2 is the approximation the owner gave (`config/price-tiers#purchasePriceFromTier2`).
 *
 * What a run changes on a product, and nothing else:
 *   - `purchasePrice`;
 *   - the `percent` of the slots whose margin a purchase price moves (`marginsAfterPurchaseChange`), so that the
 *     margin shown is the one over the new purchase price. No `finalPrice`, no `manualOverride`, no `sellingPrice`.
 * Never the stock's `avgCost`, a level, a movement or a document.
 *
 * `scripts/set-purchase-price-from-tier2.ts` is the command line; `integration/purchase-price-from-tier2.flow.test.ts`
 * holds this to a real database.
 */
import { closeSync, createReadStream, fsyncSync, openSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PURCHASE_BASIS_TIER_NAME, marginsAfterPurchaseChange, purchasePriceFromTier2, tierFinalPrice } from 'config/price-tiers'
import { Product } from 'db/models'

export interface PurchasePriceRunOptions {
  /** Write. Without it the run only counts (a dry run). */
  execute?: boolean
  /** With `execute`: the NDJSON file the before-values go to, one line per changed product, on disk BEFORE its write. */
  backupPath?: string
  /** Products per read page and per `bulkWrite`. */
  batchSize?: number
  /** How many changed products to return as samples (by SKU, no names). */
  sampleSize?: number
  onProgress?: (seen: number, changed: number) => void
}

export interface PurchasePriceSample {
  sku: string
  tier2: number
  from: number
  to: number
  margins: number
}

export interface PurchasePriceRunResult {
  products: number
  /** Products whose purchase price (or a margin) the rule changes: written with `execute`, counted without. */
  changed: number
  /** Of `changed`: the purchase price was right and only a margin was stale. */
  marginsOnly: number
  alreadyRight: number
  /** No „Цена 2", or a zero one: left untouched. */
  noTier2: number
  /** Of `changed`: deactivated products. They are corrected too, because they can be reactivated. */
  inactiveChanged: number
  written: number
  samples: PurchasePriceSample[]
}

/** One line of the backup file: what a product held before the run, and what the run wrote. */
export interface PurchasePriceBackupLine {
  _id: string
  sku: string
  purchasePrice: { from: number | null; to: number }
  /** By slot index: the margins the run changed. */
  percents: { index: number; name: string; from: number | null; to: number }[]
}

const idAfter = (last: unknown) => (last ? { _id: { $gt: last } } : {})

/**
 * Walk the org's products and set each purchase price to its „Цена 2" / 1.2.
 *
 * Idempotent: a product that already holds the figure (and true margins) is counted `alreadyRight` and not written,
 * so a second run writes nothing. One org per run, and every write names it.
 */
export async function setPurchasePricesFromTier2(orgId: string, opts: PurchasePriceRunOptions = {}): Promise<PurchasePriceRunResult> {
  const execute = opts.execute === true
  if (execute && !opts.backupPath) throw new Error('a run that writes needs a backup file (backupPath)')
  const batchSize = opts.batchSize ?? 1000
  const sampleSize = opts.sampleSize ?? 5
  const res: PurchasePriceRunResult = { products: 0, changed: 0, marginsOnly: 0, alreadyRight: 0, noTier2: 0, inactiveChanged: 0, written: 0, samples: [] }
  // 'wx': a backup is never written over an earlier one. Each batch's lines are on disk before its write goes out.
  const backup = execute ? openSync(opts.backupPath!, 'wx') : null

  try {
    let last: unknown = null
    for (;;) {
      const page: any[] = await Product.find({ orgId, ...idAfter(last) } as any, { sku: 1, purchasePrice: 1, priceTiers: 1, isActive: 1 })
        .sort({ _id: 1 }).limit(batchSize).lean().exec()
      if (!page.length) break
      last = page[page.length - 1]._id

      const ops: any[] = []
      const lines: string[] = []
      for (const p of page) {
        res.products++
        const tier2 = tierFinalPrice(p.priceTiers, PURCHASE_BASIS_TIER_NAME)
        const target = purchasePriceFromTier2(tier2)
        if (target === null) { res.noTier2++; continue }
        const held = typeof p.purchasePrice === 'number' ? p.purchasePrice : null
        // The margins are over the purchase price the product ends up with, whether or not this run moves it.
        const margins = marginsAfterPurchaseChange(p.priceTiers, held ?? 0, target)
        if (held === target && !margins.size) { res.alreadyRight++; continue }

        res.changed++
        if (held === target) res.marginsOnly++
        if (p.isActive === false) res.inactiveChanged++
        if (res.samples.length < sampleSize) res.samples.push({ sku: String(p.sku ?? ''), tier2, from: held ?? 0, to: target, margins: margins.size })
        if (!execute) continue

        const set: Record<string, number> = { purchasePrice: target }
        const percents: PurchasePriceBackupLine['percents'] = []
        for (const [index, percent] of margins) {
          const tier = p.priceTiers[index]
          set[`priceTiers.${index}.percent`] = percent
          percents.push({ index, name: String(tier?.name ?? ''), from: typeof tier?.percent === 'number' ? tier.percent : null, to: percent })
        }
        const line: PurchasePriceBackupLine = { _id: String(p._id), sku: String(p.sku ?? ''), purchasePrice: { from: held, to: target }, percents }
        lines.push(JSON.stringify(line))
        // The filter holds the product to what was read: a price somebody saved meanwhile is theirs, and is not overwritten.
        ops.push({ updateOne: { filter: { _id: p._id, orgId, purchasePrice: held }, update: { $set: set } } })
      }
      if (ops.length) {
        writeSync(backup!, `${lines.join('\n')}\n`)
        fsyncSync(backup!)
        const r = await Product.bulkWrite(ops, { ordered: false })
        res.written += r.modifiedCount ?? 0
      }
      opts.onProgress?.(res.products, res.changed)
    }
  } finally {
    if (backup !== null) closeSync(backup)
  }
  return res
}

export interface PurchasePriceRestoreResult {
  lines: number
  /** Products put back (with `execute`), or that would be (without). */
  restored: number
  /** The product no longer holds what the run wrote (edited since, or gone): left as it is. */
  skipped: number
}

/**
 * Put back what a backup file recorded. A product is restored only while it still holds the purchase price the run
 * wrote: one that was edited since keeps the edit. Margins go back by slot index, and only where the slot still
 * carries the name it had.
 */
export async function restorePurchasePrices(orgId: string, backupPath: string, opts: { execute?: boolean; batchSize?: number } = {}): Promise<PurchasePriceRestoreResult> {
  const res: PurchasePriceRestoreResult = { lines: 0, restored: 0, skipped: 0 }
  const batchSize = opts.batchSize ?? 1000
  let batch: PurchasePriceBackupLine[] = []

  const flush = async () => {
    if (!batch.length) return
    const held: any[] = await Product.find({ orgId, _id: { $in: batch.map((l) => l._id) } } as any, { purchasePrice: 1, priceTiers: 1 }).lean().exec()
    const byId = new Map(held.map((p) => [String(p._id), p]))
    const ops: any[] = []
    for (const line of batch) {
      const p = byId.get(line._id)
      if (!p || p.purchasePrice !== line.purchasePrice.to) { res.skipped++; continue }
      const set: Record<string, number> = { purchasePrice: line.purchasePrice.from ?? 0 }
      for (const m of line.percents) {
        if (String(p.priceTiers?.[m.index]?.name ?? '') === m.name) set[`priceTiers.${m.index}.percent`] = m.from ?? 0
      }
      ops.push({ updateOne: { filter: { _id: p._id, orgId, purchasePrice: line.purchasePrice.to }, update: { $set: set } } })
    }
    if (ops.length && opts.execute) {
      const r = await Product.bulkWrite(ops, { ordered: false })
      res.restored += r.modifiedCount ?? 0
    } else {
      res.restored += ops.length
    }
    batch = []
  }

  const rl = createInterface({ input: createReadStream(backupPath, 'utf8'), crlfDelay: Infinity })
  for await (const text of rl) {
    if (!text.trim()) continue
    res.lines++
    batch.push(JSON.parse(text) as PurchasePriceBackupLine)
    if (batch.length >= batchSize) await flush()
  }
  await flush()
  return res
}
