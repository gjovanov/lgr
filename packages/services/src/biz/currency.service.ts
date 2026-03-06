import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'

export async function getExchangeRate(
  orgId: string,
  fromCurrency: string,
  toCurrency: string,
  date?: Date,
  repos?: RepositoryRegistry,
): Promise<number> {
  if (fromCurrency === toCurrency) return 1
  const r = repos ?? getRepos()

  const targetDate = date || new Date()

  // Try org-specific rate first (most recent before target date)
  const orgRates = await r.exchangeRates.findMany(
    { orgId, fromCurrency, toCurrency, date: { $lte: targetDate } } as any,
    { date: -1 },
  )
  if (orgRates.length > 0) return orgRates[0].rate

  // Fall back to system-wide rate (orgId null — use findMany with filter)
  const systemRates = await r.exchangeRates.findMany(
    { orgId: null, fromCurrency, toCurrency, date: { $lte: targetDate } } as any,
    { date: -1 },
  )
  if (systemRates.length > 0) return systemRates[0].rate

  // Try inverse (org or system)
  const inverseOrgRates = await r.exchangeRates.findMany(
    { orgId, fromCurrency: toCurrency, toCurrency: fromCurrency, date: { $lte: targetDate } } as any,
    { date: -1 },
  )
  if (inverseOrgRates.length > 0) return 1 / inverseOrgRates[0].rate

  const inverseSystemRates = await r.exchangeRates.findMany(
    { orgId: null, fromCurrency: toCurrency, toCurrency: fromCurrency, date: { $lte: targetDate } } as any,
    { date: -1 },
  )
  if (inverseSystemRates.length > 0) return 1 / inverseSystemRates[0].rate

  throw new Error(`Exchange rate not found: ${fromCurrency} → ${toCurrency}`)
}

export function convertAmount(amount: number, exchangeRate: number): number {
  return Math.round(amount * exchangeRate * 100) / 100
}
