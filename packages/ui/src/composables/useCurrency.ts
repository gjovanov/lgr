const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', MKD: 'ден',
  BGN: 'лв', RSD: 'дин', JPY: '¥', CNY: '¥', AUD: 'A$',
  CAD: 'C$', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł',
  CZK: 'Kč', HUF: 'Ft', HRK: 'kn', BAM: 'KM',
}

export function useCurrency() {
  function formatCurrency(amount: number, currency = 'EUR', locale = 'en'): string {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount)
    } catch {
      const symbol = CURRENCY_SYMBOLS[currency] || currency
      return `${symbol} ${amount.toFixed(2)}`
    }
  }

  function parseCurrency(value: string): number {
    const cleaned = value.replace(/[^0-9.,\-]/g, '').replace(',', '.')
    return parseFloat(cleaned) || 0
  }

  function getCurrencySymbol(currency: string): string {
    return CURRENCY_SYMBOLS[currency] || currency
  }

  return { formatCurrency, parseCurrency, getCurrencySymbol }
}

// Direct named exports for convenience
export function formatCurrency(amount: number, currency = 'EUR', locale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    const symbol = CURRENCY_SYMBOLS[currency] || currency
    return `${symbol} ${amount.toFixed(2)}`
  }
}

export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || currency
}
