import { ExchangeRate } from 'db/models'

export async function getExchangeRate(
  orgId: string,
  fromCurrency: string,
  toCurrency: string,
  date?: Date,
): Promise<number> {
  if (fromCurrency === toCurrency) return 1

  const targetDate = date || new Date()

  // Try org-specific rate first
  let rate = await ExchangeRate.findOne({
    orgId,
    fromCurrency,
    toCurrency,
    date: { $lte: targetDate },
  })
    .sort({ date: -1 })
    .exec()

  // Fall back to system-wide rate
  if (!rate) {
    rate = await ExchangeRate.findOne({
      orgId: null,
      fromCurrency,
      toCurrency,
      date: { $lte: targetDate },
    })
      .sort({ date: -1 })
      .exec()
  }

  // Try inverse
  if (!rate) {
    const inverse = await ExchangeRate.findOne({
      $or: [{ orgId }, { orgId: null }],
      fromCurrency: toCurrency,
      toCurrency: fromCurrency,
      date: { $lte: targetDate },
    })
      .sort({ date: -1 })
      .exec()

    if (inverse) return 1 / inverse.rate
  }

  if (!rate) throw new Error(`Exchange rate not found: ${fromCurrency} → ${toCurrency}`)
  return rate.rate
}

export function convertAmount(amount: number, exchangeRate: number): number {
  return Math.round(amount * exchangeRate * 100) / 100
}
