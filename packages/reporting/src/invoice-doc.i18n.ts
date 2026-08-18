/**
 * Strings for the printed invoicing document (ФАКТУРА and its siblings).
 *
 * Same server-side constraint as `i18n.ts` — no Vue/i18n available, so the label set ships
 * inline. The Bulgarian wording reproduces the legacy PlusMinus invoice form, including the
 * two statutory notices at the foot; those cite ЗДДС/ДОПК/ЗСч and must not be reworded.
 */

export type InvoiceDocLocale = 'en' | 'bg' | 'de' | 'mk'

export interface InvoiceDocI18n {
  /** Document titles keyed by `type` (+ `bill` for an incoming invoice). */
  title: {
    invoice: string
    bill: string
    proforma: string
    credit_note: string
    debit_note: string
    cash_sale: string
  }
  /** Печатен маркер under the title. */
  copyMark: { original: string; copy: string }
  label: {
    number: string
    date: string
    unp: string
    recipient: string
    supplier: string
    city: string
    address: string
    taxId: string
    vatId: string
    taxBase: string
    vat: string
    amountDue: string
    taxEventDate: string
    placeOfTransaction: string
    payment: string
    bank: string
    bic: string
    iban: string
    receivedBy: string
    preparedBy: string
    signature: string
  }
  header: {
    lineNo: string
    description: string
    unit: string
    quantity: string
    unitPrice: string
    discount: string
    taxRate: string
    lineTotal: string
  }
  paymentMethod: {
    cash: string
    bank_transfer: string
    card: string
    check: string
    other: string
  }
  /** Statutory notices printed above and below the signature block. */
  notice: { gdpr: string; stamp: string }
}

const bg: InvoiceDocI18n = {
  title: {
    invoice: 'ФАКТУРА',
    bill: 'ФАКТУРА',
    proforma: 'ПРОФОРМА ФАКТУРА',
    credit_note: 'КРЕДИТНО ИЗВЕСТИЕ',
    debit_note: 'ДЕБИТНО ИЗВЕСТИЕ',
    cash_sale: 'КАСОВА ПРОДАЖБА',
  },
  copyMark: { original: 'ОРИГИНАЛ', copy: 'КОПИЕ' },
  label: {
    number: 'Номер',
    date: 'Дата',
    unp: 'УНП',
    recipient: 'ПОЛУЧАТЕЛ',
    supplier: 'ДОСТАВЧИК',
    city: 'Град',
    address: 'Адрес',
    taxId: 'ЕИК',
    vatId: 'ИН по ДДС',
    taxBase: 'Данъчна основа',
    vat: 'ДДС',
    amountDue: 'Сума за плащане',
    taxEventDate: 'Дата на данъчното събитие',
    placeOfTransaction: 'Място на сделката',
    payment: 'Плащане',
    bank: 'Банка',
    bic: 'BIC',
    iban: 'IBAN',
    receivedBy: 'Получател',
    preparedBy: 'Съставил',
    signature: 'подпис',
  },
  header: {
    lineNo: 'No',
    description: 'Име',
    unit: 'Мяр',
    quantity: 'Кол',
    unitPrice: 'Цена',
    discount: 'ТО',
    taxRate: 'ДДС %',
    lineTotal: 'Стойност',
  },
  paymentMethod: {
    cash: 'В брой',
    bank_transfer: 'По сметка',
    card: 'С карта',
    check: 'С чек',
    other: 'Друго',
  },
  notice: {
    gdpr:
      'Получателят е дал съгласие горепосочените лични данни да бъдат използвани от администратора на лични данни '
      + 'във връзка с изпълнението на чл. 114, ал. 1, т. 7 и т. 8 от ЗДДС и чл. 84, ал. 2 от ДОПК',
    stamp: 'Съгласно чл.6, ал.1 от ЗСч., ЗДДС и ППЗДДС печат и подпис не са задължителни реквизити на фактурата.',
  },
}

const en: InvoiceDocI18n = {
  title: {
    invoice: 'INVOICE',
    bill: 'PURCHASE INVOICE',
    proforma: 'PROFORMA INVOICE',
    credit_note: 'CREDIT NOTE',
    debit_note: 'DEBIT NOTE',
    cash_sale: 'CASH SALE',
  },
  copyMark: { original: 'ORIGINAL', copy: 'COPY' },
  label: {
    number: 'Number',
    date: 'Date',
    unp: 'USN',
    recipient: 'RECIPIENT',
    supplier: 'SUPPLIER',
    city: 'City',
    address: 'Address',
    taxId: 'Reg. No',
    vatId: 'VAT No',
    taxBase: 'Taxable amount',
    vat: 'VAT',
    amountDue: 'Amount due',
    taxEventDate: 'Tax event date',
    placeOfTransaction: 'Place of transaction',
    payment: 'Payment',
    bank: 'Bank',
    bic: 'BIC',
    iban: 'IBAN',
    receivedBy: 'Received by',
    preparedBy: 'Prepared by',
    signature: 'signature',
  },
  header: {
    lineNo: 'No',
    description: 'Description',
    unit: 'Unit',
    quantity: 'Qty',
    unitPrice: 'Price',
    discount: 'Disc.',
    taxRate: 'VAT %',
    lineTotal: 'Amount',
  },
  paymentMethod: {
    cash: 'Cash',
    bank_transfer: 'Bank transfer',
    card: 'Card',
    check: 'Cheque',
    other: 'Other',
  },
  notice: {
    gdpr:
      'The recipient has consented to the above personal data being processed by the data controller in connection '
      + 'with Art. 114(1)(7) and (8) of the VAT Act and Art. 84(2) of the Tax and Social Insurance Procedure Code.',
    stamp: 'Under Art. 6(1) of the Accountancy Act, the VAT Act and its regulations, a stamp and signature are not mandatory invoice requisites.',
  },
}

const de: InvoiceDocI18n = {
  title: {
    invoice: 'RECHNUNG',
    bill: 'EINGANGSRECHNUNG',
    proforma: 'PROFORMARECHNUNG',
    credit_note: 'GUTSCHRIFT',
    debit_note: 'LASTSCHRIFT',
    cash_sale: 'BARVERKAUF',
  },
  copyMark: { original: 'ORIGINAL', copy: 'KOPIE' },
  label: {
    number: 'Nummer',
    date: 'Datum',
    unp: 'USN',
    recipient: 'EMPFÄNGER',
    supplier: 'LIEFERANT',
    city: 'Stadt',
    address: 'Adresse',
    taxId: 'Reg.-Nr.',
    vatId: 'USt-IdNr.',
    taxBase: 'Nettobetrag',
    vat: 'MwSt',
    amountDue: 'Zahlbetrag',
    taxEventDate: 'Steuerdatum',
    placeOfTransaction: 'Ort der Leistung',
    payment: 'Zahlung',
    bank: 'Bank',
    bic: 'BIC',
    iban: 'IBAN',
    receivedBy: 'Empfänger',
    preparedBy: 'Erstellt von',
    signature: 'Unterschrift',
  },
  header: {
    lineNo: 'Nr',
    description: 'Bezeichnung',
    unit: 'Einh.',
    quantity: 'Menge',
    unitPrice: 'Preis',
    discount: 'Rabatt',
    taxRate: 'MwSt %',
    lineTotal: 'Betrag',
  },
  paymentMethod: {
    cash: 'Bar',
    bank_transfer: 'Überweisung',
    card: 'Karte',
    check: 'Scheck',
    other: 'Sonstige',
  },
  notice: {
    gdpr:
      'Der Empfänger hat der Verarbeitung der oben genannten personenbezogenen Daten durch den Verantwortlichen im '
      + 'Zusammenhang mit Art. 114 Abs. 1 Nr. 7 und 8 UStG (BG) und Art. 84 Abs. 2 DOPK zugestimmt.',
    stamp: 'Gemäß Art. 6 Abs. 1 des Rechnungslegungsgesetzes sind Stempel und Unterschrift keine Pflichtangaben der Rechnung.',
  },
}

const mk: InvoiceDocI18n = {
  title: {
    invoice: 'ФАКТУРА',
    bill: 'ВЛЕЗНА ФАКТУРА',
    proforma: 'ПРОФОРМА ФАКТУРА',
    credit_note: 'КРЕДИТНА БЕЛЕШКА',
    debit_note: 'ДЕБИТНА БЕЛЕШКА',
    cash_sale: 'КАСОВА ПРОДАЖБА',
  },
  copyMark: { original: 'ОРИГИНАЛ', copy: 'КОПИЈА' },
  label: {
    number: 'Број',
    date: 'Датум',
    unp: 'УНП',
    recipient: 'ПРИМАЧ',
    supplier: 'ДОСТАВУВАЧ',
    city: 'Град',
    address: 'Адреса',
    taxId: 'ЕМБС',
    vatId: 'ЕДБ',
    taxBase: 'Даночна основа',
    vat: 'ДДВ',
    amountDue: 'Износ за плаќање',
    taxEventDate: 'Датум на даночен настан',
    placeOfTransaction: 'Место на прометот',
    payment: 'Плаќање',
    bank: 'Банка',
    bic: 'BIC',
    iban: 'IBAN',
    receivedBy: 'Примач',
    preparedBy: 'Составил',
    signature: 'потпис',
  },
  header: {
    lineNo: 'Бр',
    description: 'Име',
    unit: 'Мер',
    quantity: 'Кол',
    unitPrice: 'Цена',
    discount: 'Попуст',
    taxRate: 'ДДВ %',
    lineTotal: 'Вредност',
  },
  paymentMethod: {
    cash: 'Во готово',
    bank_transfer: 'На сметка',
    card: 'Со картичка',
    check: 'Со чек',
    other: 'Друго',
  },
  notice: {
    gdpr:
      'Примачот е согласен горенаведените лични податоци да бидат користени од администраторот на лични податоци '
      + 'во врска со извршувањето на чл. 114, ст. 1, т. 7 и т. 8 од ЗДДВ и чл. 84, ст. 2 од ДОПК',
    stamp: 'Согласно чл.6, ст.1 од ЗСм., ЗДДВ и ПЗДДВ печат и потпис не се задолжителни реквизити на фактурата.',
  },
}

const TABLE: Record<InvoiceDocLocale, InvoiceDocI18n> = { en, bg, de, mk }

export function invoiceDocI18n(locale?: string): InvoiceDocI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as InvoiceDocLocale
  return TABLE[key] || en
}

/** Title for a document, resolving an incoming `invoice` to the purchase-invoice wording. */
export function invoiceDocTitle(type: string | undefined, direction: string | undefined, locale?: string): string {
  const t = invoiceDocI18n(locale).title
  if ((type || 'invoice') === 'invoice' && direction === 'incoming') return t.bill
  return (t as Record<string, string>)[type || 'invoice'] || t.invoice
}

/** Matches the "Словом :" prefix written into notes by `useAmountInWords`, in any locale. */
export const AMOUNT_IN_WORDS_RE = /^\s*(Словом|In words|In Worten|Со зборови)\s*:/i
