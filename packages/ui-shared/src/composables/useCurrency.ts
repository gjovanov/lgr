import { formatMoney } from '../format/format'

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', MKD: 'ден',
  BGN: 'лв', RSD: 'дин', JPY: '¥', CNY: '¥', AUD: 'A$',
  CAD: 'C$', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł',
  CZK: 'Kč', HUF: 'Ft', HRK: 'kn', BAM: 'KM',
}

/**
 * An amount of money, through the one formatter (FR-31.13, `ui-shared/format#formatMoney`): the same on every screen.
 *
 * `lang` is a language (`bg`) or a formatting locale's language part; nothing means the app's language. The many call
 * sites that pass one keep working, and none names a formatting locale any more.
 */
export function formatCurrency(amount: number, currency = 'EUR', lang?: string, maxDecimals = 2): string {
  return formatMoney(amount, currency, { lang, decimals: maxDecimals })
}

export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || currency
}

export function useCurrency() {
  function parseCurrency(value: string): number {
    const cleaned = value.replace(/[^0-9.,\-]/g, '').replace(',', '.')
    return parseFloat(cleaned) || 0
  }

  return { formatCurrency, parseCurrency, getCurrencySymbol }
}
