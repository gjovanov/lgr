/**
 * Strings for the customer order's printed sheet (`pdf/customer-order.pdf.ts`): what a client is
 * handed or sent for an `InternalOrder` (ORDI-). Local to reporting, like the supplier order
 * sheet's (`order-sheet.i18n.ts`).
 *
 * The words are the supplier's to its client: German says „Auftrag" where the supplier order's
 * sheet, written by a buyer, says „Bestellung". The two company numbers carry the labels the
 * invoice form prints (`invoice-doc.i18n.ts`), since the same client reads both documents.
 *
 * ⚠ No label here names a price, an amount or a total, and none is to be added: the sheet prints
 * none (see the builder).
 */

export type CustomerOrderLocale = 'en' | 'bg' | 'de' | 'mk'

export interface CustomerOrderI18n {
  /** A confirmed order, and every status after it. */
  titleConfirmation: string
  titleDraft: string
  titleCancelled: string
  orderNo: string
  date: string
  requestedDate: string
  supplier: string
  customer: string
  taxId: string
  vatId: string
  email: string
  phone: string
  product: string
  sku: string
  qty: string
  unit: string
  notes: string
  terms: string
  generated: string
}

const en: CustomerOrderI18n = {
  titleConfirmation: 'ORDER CONFIRMATION',
  titleDraft: 'ORDER (DRAFT)',
  titleCancelled: 'ORDER (CANCELLED)',
  orderNo: 'Order №',
  date: 'Date',
  requestedDate: 'Requested delivery date',
  supplier: 'Supplier',
  customer: 'Customer',
  taxId: 'Reg. No',
  vatId: 'VAT No',
  email: 'Email',
  phone: 'Phone',
  product: 'Article',
  sku: 'SKU',
  qty: 'Quantity',
  unit: 'Unit',
  notes: 'Notes',
  terms: 'Terms',
  generated: 'Generated on',
}

const bg: CustomerOrderI18n = {
  titleConfirmation: 'ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА',
  titleDraft: 'ПОРЪЧКА (ЧЕРНОВА)',
  titleCancelled: 'ПОРЪЧКА (ОТКАЗАНА)',
  orderNo: 'Поръчка №',
  date: 'Дата',
  requestedDate: 'Желана дата на доставка',
  supplier: 'Доставчик',
  customer: 'Клиент',
  taxId: 'ЕИК',
  vatId: 'ИН по ДДС',
  email: 'Имейл',
  phone: 'Телефон',
  product: 'Артикул',
  sku: 'Код',
  qty: 'Количество',
  unit: 'Мярка',
  notes: 'Бележки',
  terms: 'Условия',
  generated: 'Изготвено на',
}

const de: CustomerOrderI18n = {
  titleConfirmation: 'AUFTRAGSBESTÄTIGUNG',
  titleDraft: 'AUFTRAG (ENTWURF)',
  titleCancelled: 'AUFTRAG (STORNIERT)',
  orderNo: 'Auftrag Nr.',
  date: 'Datum',
  requestedDate: 'Gewünschter Liefertermin',
  supplier: 'Lieferant',
  customer: 'Kunde',
  taxId: 'Reg.-Nr.',
  vatId: 'USt-IdNr.',
  email: 'E-Mail',
  phone: 'Telefon',
  product: 'Artikel',
  sku: 'Art.-Nr.',
  qty: 'Menge',
  unit: 'Einheit',
  notes: 'Bemerkungen',
  terms: 'Bedingungen',
  generated: 'Erstellt am',
}

const mk: CustomerOrderI18n = {
  titleConfirmation: 'ПОТВРДА НА НАРАЧКА',
  titleDraft: 'НАРАЧКА (НАЦРТ)',
  titleCancelled: 'НАРАЧКА (ОТКАЖАНА)',
  orderNo: 'Нарачка бр.',
  date: 'Датум',
  requestedDate: 'Посакуван датум на испорака',
  supplier: 'Добавувач',
  customer: 'Купувач',
  taxId: 'ЕМБС',
  vatId: 'ЕДБ',
  email: 'Е-пошта',
  phone: 'Телефон',
  product: 'Артикл',
  sku: 'Шифра',
  qty: 'Количина',
  unit: 'Мерка',
  notes: 'Белешки',
  terms: 'Услови',
  generated: 'Изготвено на',
}

const TABLE: Record<CustomerOrderLocale, CustomerOrderI18n> = { en, bg, de, mk }

export function customerOrderI18n(locale?: string): CustomerOrderI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as CustomerOrderLocale
  return TABLE[key] || en
}

/** One side of the sheet's two-party block. A field it does not have is not printed. */
export interface CustomerOrderParty {
  name: string
  taxId?: string
  vatId?: string
  email?: string
  phone?: string
}

/**
 * What the sheet is built from.
 *
 * `order` is the stored document, and may carry everything it holds: the builder reads the number,
 * the status, the two dates, `notes`, `terms` and, of each line, the article, the SKU, the
 * quantity and the unit. Nothing else of it reaches the page.
 */
export interface CustomerOrderCtx {
  order: any
  /** The supplier: the organization the order was placed with. */
  org: CustomerOrderParty
  /** The client who placed it. */
  customer: CustomerOrderParty
  /** By product id: the name, SKU and unit a line falls back to when it carries none of its own. */
  productInfo: Record<string, { name?: string; sku?: string; unit?: string }>
  locale?: string
  /** The day the foot names. Unset: today (UTC), as on the supplier order's sheet. */
  generatedAt?: Date
}
