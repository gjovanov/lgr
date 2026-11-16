/**
 * How many decimals an article's prices and margins keep, and the arithmetic between them.
 *
 * The rule itself lives in `config/price-precision` since 2026-11-15, so the server reads the same one (the purchase
 * price a new article takes from its „Цена 2", `config/price-tiers`). This file is how the screens have always named it.
 */
export * from 'config/price-precision'
