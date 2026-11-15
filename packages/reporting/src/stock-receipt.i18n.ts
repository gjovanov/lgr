/**
 * Strings for the printed „Складова разписка": the goods receipt a supplier bill booked, printed
 * from the bill (`pdf/stock-receipt.pdf.ts`).
 *
 * Same server-side constraint as `i18n.ts` — no Vue/i18n available, so the label set ships
 * inline. The Bulgarian wording is authoritative; the other three locales translate it.
 */

export type StockReceiptLocale = 'en' | 'bg' | 'de' | 'mk'

export interface StockReceiptI18n {
  title: string
  label: {
    number: string
    date: string
    warehouse: string
    /**
     * The bill the goods came with — OUR document („Входяща фактура № BILL-… от 31.10.2026"),
     * never the supplier's own invoice number.
     */
    bill: string
    /** Between the bill's number and its date. */
    of: string
    /** After the number of a bill not received yet: a draft's number, which receiving replaces. */
    draft: string
    /** In front of the name of the price the sheet shows („Цена: Цена на едро"). */
    price: string
    handedOverBy: string
    receivedBy: string
    signature: string
  }
  /**
   * The prices that are no slot of the catalogue: the selling price, as the screens name it, and the price a line was
   * booked at. A slot is named by its own label (`config/price-tiers#tierLabel`).
   */
  price: {
    selling: string
    booked: string
  }
  header: {
    lineNo: string
    name: string
    unit: string
    quantity: string
    unitPrice: string
    amount: string
  }
}

const bg: StockReceiptI18n = {
  title: 'СКЛАДОВА РАЗПИСКА',
  label: {
    number: 'Номер',
    date: 'Дата',
    warehouse: 'Склад',
    bill: 'Входяща фактура',
    of: 'от',
    draft: 'чернова',
    price: 'Цена',
    handedOverBy: 'Предал',
    receivedBy: 'Приел',
    signature: 'подпис',
  },
  price: { selling: 'Продажна цена', booked: 'Цена на заприходяване' },
  header: {
    lineNo: '№',
    name: 'Наименование',
    unit: 'Мярка',
    quantity: 'Количество',
    unitPrice: 'Цена',
    amount: 'Стойност',
  },
}

const en: StockReceiptI18n = {
  title: 'GOODS RECEIPT',
  label: {
    number: 'Number',
    date: 'Date',
    warehouse: 'Warehouse',
    bill: 'Purchase invoice',
    of: 'of',
    draft: 'draft',
    price: 'Price',
    handedOverBy: 'Handed over by',
    receivedBy: 'Received by',
    signature: 'signature',
  },
  price: { selling: 'Selling price', booked: 'Booked price' },
  header: {
    lineNo: 'No',
    name: 'Name',
    unit: 'Unit',
    quantity: 'Quantity',
    unitPrice: 'Price',
    amount: 'Amount',
  },
}

const de: StockReceiptI18n = {
  title: 'WARENEINGANGSSCHEIN',
  label: {
    number: 'Nummer',
    date: 'Datum',
    warehouse: 'Lager',
    bill: 'Eingangsrechnung',
    of: 'vom',
    draft: 'Entwurf',
    price: 'Preis',
    handedOverBy: 'Übergeben von',
    receivedBy: 'Empfangen von',
    signature: 'Unterschrift',
  },
  price: { selling: 'Verkaufspreis', booked: 'Gebuchter Preis' },
  header: {
    lineNo: 'Nr',
    name: 'Bezeichnung',
    unit: 'Einheit',
    quantity: 'Menge',
    unitPrice: 'Preis',
    amount: 'Betrag',
  },
}

const mk: StockReceiptI18n = {
  title: 'ПРИЕМНИЦА',
  label: {
    number: 'Број',
    date: 'Датум',
    warehouse: 'Магацин',
    bill: 'Влезна фактура',
    of: 'од',
    draft: 'нацрт',
    price: 'Цена',
    handedOverBy: 'Предал',
    receivedBy: 'Примил',
    signature: 'потпис',
  },
  price: { selling: 'Продажна цена', booked: 'Цена при прием' },
  header: {
    lineNo: 'Бр',
    name: 'Назив',
    unit: 'Мерка',
    quantity: 'Количество',
    unitPrice: 'Цена',
    amount: 'Вредност',
  },
}

const TABLE: Record<StockReceiptLocale, StockReceiptI18n> = { en, bg, de, mk }

export function stockReceiptI18n(locale?: string): StockReceiptI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as StockReceiptLocale
  return TABLE[key] || en
}
