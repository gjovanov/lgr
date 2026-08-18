/**
 * Software credit printed in the page foot of every generated PDF — the LGR counterpart of
 * the line the legacy Bulgarian forms carry naming the program that issued the document.
 *
 * Kept standalone (not in `i18n.ts`) because the document forms and the list exports use
 * different i18n modules, and every one of them needs this same line.
 */

export const PRODUCT_NAME = 'LGR'
export const PRODUCT_URL = 'https://lgrai.app'

const LABEL: Record<string, string> = {
  en: 'Software product',
  bg: 'Програмен продукт',
  de: 'Softwareprodukt',
  mk: 'Програмски продукт',
}

/** e.g. "Програмен продукт LGR https://lgrai.app" */
export function productCredit(locale?: string): string {
  const key = (locale || 'en').toLowerCase().split('-')[0]
  return `${LABEL[key] || LABEL.en} ${PRODUCT_NAME} ${PRODUCT_URL}`
}
