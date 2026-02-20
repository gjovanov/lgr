const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '\u20AC', USD: '$', GBP: '\u00A3', CHF: 'CHF', MKD: '\u0434\u0435\u043D',
  BGN: '\u043B\u0432', RSD: '\u0434\u0438\u043D', JPY: '\u00A5', CNY: '\u00A5', AUD: 'A$',
  CAD: 'C$', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'z\u0142',
  CZK: 'K\u010D', HUF: 'Ft', HRK: 'kn', BAM: 'KM',
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
