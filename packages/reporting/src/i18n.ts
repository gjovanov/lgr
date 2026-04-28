/**
 * Tiny locale lookup for export generators (Excel + PDF).
 *
 * Reporting runs server-side and has no Vue/i18n dependency, so we ship
 * the small set of strings we need (column headers, document titles,
 * status names, payment method labels, footer labels) inline.
 *
 * Keys mirror `packages/ui-shared/src/locales/*.json` where possible, but
 * are flattened into a single map per locale for fast lookup.
 *
 * When adding a new export column, add the header to all four locales here
 * AND to the UI catalog at `packages/ui-shared/src/composables/useExportColumns.ts`.
 */

export type ExportLocale = 'en' | 'bg' | 'de' | 'mk'

export interface ExportI18n {
  // Document-list titles
  docTitle: {
    invoice: string
    proforma: string
    credit_note: string
    debit_note: string
    cash_sale: string
    bill: string
    documents: string
  }
  // Column headers (subset of useExportColumns.ts catalog)
  header: {
    number: string
    issueDate: string
    dueDate: string
    contactName: string
    contactTaxId: string
    status: string
    currency: string
    subtotal: string
    taxTotal: string
    total: string
    amountPaid: string
    amountDue: string
    reference: string
    lineNo: string
    description: string
    quantity: string
    unit: string
    unitPrice: string
    discount: string
    taxRate: string
    lineTotal: string
  }
  status: {
    draft: string
    sent: string
    received: string
    partially_paid: string
    paid: string
    overdue: string
    voided: string
    cancelled: string
    completed: string
    converted: string
    issued: string
    applied: string
    approved: string
    executed: string
    accepted: string
    expired: string
  }
  paymentMethod: {
    cash: string
    bank_transfer: string
    card: string
    check: string
    other: string
  }
  footer: {
    totalLabel: string
    totalsLabel: string
    totalByMethod: (m: string) => string
    mixedCurrency: string
    noLines: string
  }
}

const en: ExportI18n = {
  docTitle: {
    invoice: 'Invoices',
    proforma: 'Proforma Invoices',
    credit_note: 'Credit Notes',
    debit_note: 'Debit Notes',
    cash_sale: 'Cash Sales',
    bill: 'Supplier Bills',
    documents: 'Documents',
  },
  header: {
    number: 'Number',
    issueDate: 'Issue Date',
    dueDate: 'Due Date',
    contactName: 'Contact',
    contactTaxId: 'Tax ID',
    status: 'Status',
    currency: 'Currency',
    subtotal: 'Subtotal',
    taxTotal: 'Tax',
    total: 'Total',
    amountPaid: 'Paid',
    amountDue: 'Due',
    reference: 'Reference',
    lineNo: 'Line #',
    description: 'Description',
    quantity: 'Qty',
    unit: 'Unit',
    unitPrice: 'Unit Price',
    discount: 'Discount %',
    taxRate: 'Tax %',
    lineTotal: 'Line Total',
  },
  status: {
    draft: 'Draft',
    sent: 'Sent',
    received: 'Received',
    partially_paid: 'Partially Paid',
    paid: 'Paid',
    overdue: 'Overdue',
    voided: 'Voided',
    cancelled: 'Cancelled',
    completed: 'Completed',
    converted: 'Converted',
    issued: 'Issued',
    applied: 'Applied',
    approved: 'Approved',
    executed: 'Executed',
    accepted: 'Accepted',
    expired: 'Expired',
  },
  paymentMethod: {
    cash: 'Cash',
    bank_transfer: 'Bank',
    card: 'Card',
    check: 'Check',
    other: 'Other',
  },
  footer: {
    totalLabel: 'Total:',
    totalsLabel: 'Totals:',
    totalByMethod: (m: string) => `Total ${m}:`,
    mixedCurrency: 'mixed currencies — no aggregate',
    noLines: '(no lines)',
  },
}

const bg: ExportI18n = {
  docTitle: {
    invoice: 'Фактури',
    proforma: 'Проформи',
    credit_note: 'Кредитни известия',
    debit_note: 'Дебитни известия',
    cash_sale: 'Касови продажби',
    bill: 'Покупни фактури',
    documents: 'Документи',
  },
  header: {
    number: 'Номер',
    issueDate: 'Дата на издаване',
    dueDate: 'Падеж',
    contactName: 'Контрагент',
    contactTaxId: 'ЕИК / БУЛСТАТ',
    status: 'Статус',
    currency: 'Валута',
    subtotal: 'Междинна сума',
    taxTotal: 'ДДС',
    total: 'Общо',
    amountPaid: 'Платено',
    amountDue: 'Дължимо',
    reference: 'Референция',
    lineNo: 'Ред #',
    description: 'Описание',
    quantity: 'Кол.',
    unit: 'Мерна ед.',
    unitPrice: 'Ед. цена',
    discount: 'Отстъпка %',
    taxRate: 'ДДС %',
    lineTotal: 'Сума на ред',
  },
  status: {
    draft: 'Чернова',
    sent: 'Изпратена',
    received: 'Получена',
    partially_paid: 'Частично платена',
    paid: 'Платена',
    overdue: 'Просрочена',
    voided: 'Анулирана',
    cancelled: 'Отказана',
    completed: 'Завършена',
    converted: 'Конвертирана',
    issued: 'Издадена',
    applied: 'Приложена',
    approved: 'Одобрена',
    executed: 'Изпълнена',
    accepted: 'Приета',
    expired: 'Изтекла',
  },
  paymentMethod: {
    cash: 'В брой',
    bank_transfer: 'Банка',
    card: 'Карта',
    check: 'Чек',
    other: 'Друго',
  },
  footer: {
    totalLabel: 'Общо:',
    totalsLabel: 'Общи стойности:',
    totalByMethod: (m: string) => `Общо ${m}:`,
    mixedCurrency: 'смесени валути — без обща сума',
    noLines: '(няма редове)',
  },
}

const de: ExportI18n = {
  docTitle: {
    invoice: 'Rechnungen',
    proforma: 'Proformarechnungen',
    credit_note: 'Gutschriften',
    debit_note: 'Lastschriften',
    cash_sale: 'Barverkäufe',
    bill: 'Eingangsrechnungen',
    documents: 'Dokumente',
  },
  header: {
    number: 'Nummer',
    issueDate: 'Ausstellungsdatum',
    dueDate: 'Fälligkeit',
    contactName: 'Kontakt',
    contactTaxId: 'USt-IdNr.',
    status: 'Status',
    currency: 'Währung',
    subtotal: 'Zwischensumme',
    taxTotal: 'MwSt',
    total: 'Gesamt',
    amountPaid: 'Bezahlt',
    amountDue: 'Fällig',
    reference: 'Referenz',
    lineNo: 'Zeile #',
    description: 'Beschreibung',
    quantity: 'Menge',
    unit: 'Einheit',
    unitPrice: 'Einzelpreis',
    discount: 'Rabatt %',
    taxRate: 'MwSt %',
    lineTotal: 'Zeilensumme',
  },
  status: {
    draft: 'Entwurf',
    sent: 'Versendet',
    received: 'Empfangen',
    partially_paid: 'Teilweise bezahlt',
    paid: 'Bezahlt',
    overdue: 'Überfällig',
    voided: 'Storniert',
    cancelled: 'Abgebrochen',
    completed: 'Abgeschlossen',
    converted: 'Umgewandelt',
    issued: 'Ausgestellt',
    applied: 'Angewendet',
    approved: 'Genehmigt',
    executed: 'Ausgeführt',
    accepted: 'Akzeptiert',
    expired: 'Abgelaufen',
  },
  paymentMethod: {
    cash: 'Bar',
    bank_transfer: 'Bank',
    card: 'Karte',
    check: 'Scheck',
    other: 'Sonstige',
  },
  footer: {
    totalLabel: 'Gesamt:',
    totalsLabel: 'Summen:',
    totalByMethod: (m: string) => `Gesamt ${m}:`,
    mixedCurrency: 'gemischte Währungen — kein Gesamtbetrag',
    noLines: '(keine Zeilen)',
  },
}

const mk: ExportI18n = {
  docTitle: {
    invoice: 'Фактури',
    proforma: 'Проформи',
    credit_note: 'Кредитни белешки',
    debit_note: 'Дебитни белешки',
    cash_sale: 'Касови продажби',
    bill: 'Влезни сметки',
    documents: 'Документи',
  },
  header: {
    number: 'Број',
    issueDate: 'Датум на издавање',
    dueDate: 'Рок',
    contactName: 'Контакт',
    contactTaxId: 'ЕДБ',
    status: 'Статус',
    currency: 'Валута',
    subtotal: 'Меѓузбир',
    taxTotal: 'ДДВ',
    total: 'Вкупно',
    amountPaid: 'Платено',
    amountDue: 'Должи',
    reference: 'Референца',
    lineNo: 'Ред #',
    description: 'Опис',
    quantity: 'Кол.',
    unit: 'Мерка',
    unitPrice: 'Ед. цена',
    discount: 'Попуст %',
    taxRate: 'ДДВ %',
    lineTotal: 'Сума',
  },
  status: {
    draft: 'Нацрт',
    sent: 'Испратена',
    received: 'Примена',
    partially_paid: 'Делумно платена',
    paid: 'Платена',
    overdue: 'Задоцнета',
    voided: 'Поништена',
    cancelled: 'Откажана',
    completed: 'Завршена',
    converted: 'Конвертирана',
    issued: 'Издадена',
    applied: 'Применета',
    approved: 'Одобрена',
    executed: 'Извршена',
    accepted: 'Прифатена',
    expired: 'Истечена',
  },
  paymentMethod: {
    cash: 'Готово',
    bank_transfer: 'Банка',
    card: 'Картичка',
    check: 'Чек',
    other: 'Друго',
  },
  footer: {
    totalLabel: 'Вкупно:',
    totalsLabel: 'Вкупни суми:',
    totalByMethod: (m: string) => `Вкупно ${m}:`,
    mixedCurrency: 'мешани валути — нема збир',
    noLines: '(нема ставки)',
  },
}

const TABLE: Record<ExportLocale, ExportI18n> = { en, bg, de, mk }

export function exportI18n(locale?: string): ExportI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as ExportLocale
  return TABLE[key] || en
}

export function statusLabel(status: string | undefined, locale?: string): string {
  if (!status) return ''
  const t = exportI18n(locale).status as Record<string, string>
  return t[status] ?? status
}

export function docTitleFor(docType: string, direction: string | undefined, locale?: string): string {
  const t = exportI18n(locale).docTitle
  if (docType === 'invoice' && direction === 'incoming') return t.bill
  return (t as Record<string, string>)[docType] || t.documents
}
