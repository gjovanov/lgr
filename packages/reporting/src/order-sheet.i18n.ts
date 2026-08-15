/**
 * Strings for the Order (ORD-) per-supplier-group sheets.
 * Two variants share these: the supplier-facing offer sheet and the internal
 * allocation/reservation sheet. Local to reporting (not part of the shared
 * export-column catalog in ./i18n.ts).
 */

export type OrderSheetLocale = 'en' | 'bg' | 'de' | 'mk'

export interface OrderSheetI18n {
  titleSupplier: string
  titleInternal: string
  buyer: string
  supplier: string
  orderNo: string
  date: string
  expectedDate: string
  taxId: string
  vatId: string
  email: string
  phone: string
  product: string
  sku: string
  qty: string
  unit: string
  offerPrice: string
  offerTotal: string
  deliveryTime: string
  expectedPrice: string
  warehouse: string
  allocated: string
  received: string
  reservedFor: string
  reservedQty: string
  free: string
  unallocated: string
  notes: string
  terms: string
  generated: string
  fillInHint: string
}

const en: OrderSheetI18n = {
  titleSupplier: 'Purchase Order',
  titleInternal: 'Order — Internal Sheet',
  buyer: 'Buyer',
  supplier: 'Supplier',
  orderNo: 'Order №',
  date: 'Date',
  expectedDate: 'Expected delivery',
  taxId: 'Company ID',
  vatId: 'VAT №',
  email: 'Email',
  phone: 'Phone',
  product: 'Product',
  sku: 'SKU',
  qty: 'Qty',
  unit: 'Unit',
  offerPrice: 'Unit price (offer)',
  offerTotal: 'Total (offer)',
  deliveryTime: 'Delivery time',
  expectedPrice: 'Expected price',
  warehouse: 'Warehouse',
  allocated: 'Allocated',
  received: 'Received',
  reservedFor: 'Reserved for',
  reservedQty: 'Reserved qty',
  free: 'Free',
  unallocated: 'Unallocated',
  notes: 'Notes',
  terms: 'Terms',
  generated: 'Generated',
  fillInHint: 'Please fill in the price, total and delivery time columns and return the offer.',
}

const bg: OrderSheetI18n = {
  titleSupplier: 'Поръчка за доставка',
  titleInternal: 'Поръчка — вътрешен лист',
  buyer: 'Възложител',
  supplier: 'Доставчик',
  orderNo: 'Поръчка №',
  date: 'Дата',
  expectedDate: 'Очаквана доставка',
  taxId: 'ЕИК',
  vatId: 'ДДС №',
  email: 'Имейл',
  phone: 'Телефон',
  product: 'Продукт',
  sku: 'Код',
  qty: 'Кол.',
  unit: 'Мярка',
  offerPrice: 'Ед. цена (оферта)',
  offerTotal: 'Сума (оферта)',
  deliveryTime: 'Срок на доставка',
  expectedPrice: 'Очаквана цена',
  warehouse: 'Склад',
  allocated: 'Разпределено',
  received: 'Получено',
  reservedFor: 'Резервирано за',
  reservedQty: 'Рез. кол.',
  free: 'Свободно',
  unallocated: 'Неразпределено',
  notes: 'Бележки',
  terms: 'Условия',
  generated: 'Генерирано',
  fillInHint: 'Моля, попълнете колоните за цена, сума и срок на доставка и върнете офертата.',
}

const de: OrderSheetI18n = {
  titleSupplier: 'Bestellung',
  titleInternal: 'Bestellung — internes Blatt',
  buyer: 'Käufer',
  supplier: 'Lieferant',
  orderNo: 'Bestellung Nr.',
  date: 'Datum',
  expectedDate: 'Erwartete Lieferung',
  taxId: 'Firmen-ID',
  vatId: 'USt-IdNr.',
  email: 'E-Mail',
  phone: 'Telefon',
  product: 'Produkt',
  sku: 'Art.-Nr.',
  qty: 'Menge',
  unit: 'Einheit',
  offerPrice: 'Einzelpreis (Angebot)',
  offerTotal: 'Summe (Angebot)',
  deliveryTime: 'Lieferzeit',
  expectedPrice: 'Erwarteter Preis',
  warehouse: 'Lager',
  allocated: 'Zugeteilt',
  received: 'Empfangen',
  reservedFor: 'Reserviert für',
  reservedQty: 'Res. Menge',
  free: 'Frei',
  unallocated: 'Nicht zugeteilt',
  notes: 'Notizen',
  terms: 'Bedingungen',
  generated: 'Erstellt',
  fillInHint: 'Bitte füllen Sie die Spalten Preis, Summe und Lieferzeit aus und senden Sie das Angebot zurück.',
}

const mk: OrderSheetI18n = {
  titleSupplier: 'Нарачка',
  titleInternal: 'Нарачка — внатрешен лист',
  buyer: 'Купувач',
  supplier: 'Добавувач',
  orderNo: 'Нарачка бр.',
  date: 'Датум',
  expectedDate: 'Очекувана испорака',
  taxId: 'ЕДБ',
  vatId: 'ДДВ бр.',
  email: 'Е-пошта',
  phone: 'Телефон',
  product: 'Производ',
  sku: 'Шифра',
  qty: 'Кол.',
  unit: 'Мерка',
  offerPrice: 'Ед. цена (понуда)',
  offerTotal: 'Сума (понуда)',
  deliveryTime: 'Рок на испорака',
  expectedPrice: 'Очекувана цена',
  warehouse: 'Магацин',
  allocated: 'Распределено',
  received: 'Примено',
  reservedFor: 'Резервирано за',
  reservedQty: 'Рез. кол.',
  free: 'Слободно',
  unallocated: 'Нераспределено',
  notes: 'Белешки',
  terms: 'Услови',
  generated: 'Генерирано',
  fillInHint: 'Пополнете ги колоните за цена, сума и рок на испорака и вратете ја понудата.',
}

const TABLE: Record<OrderSheetLocale, OrderSheetI18n> = { en, bg, de, mk }

export function orderSheetI18n(locale?: string): OrderSheetI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as OrderSheetLocale
  return TABLE[key] || en
}

/** Shared render context for both variants and both formats. */
export interface OrderSheetCtx {
  order: any
  group: any
  org: { name: string; taxNumber?: string; vatNumber?: string; email?: string; phone?: string }
  supplierName: string
  supplierTaxId?: string
  productInfo: Record<string, { name?: string; sku?: string; unit?: string }>
  warehouseNames: Record<string, string>
  contactNames: Record<string, string>
  /** Reservation (RES-) docs grouped by allocationId — feeds the internal variant's
   * per-client breakdown (reservations are first-class docs, not order subdocuments). */
  reservations?: Record<string, Array<{ contactId: any; quantity: number }>>
  locale?: string
}
