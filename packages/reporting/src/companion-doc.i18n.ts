/**
 * Strings for the two companion documents printed alongside an outgoing sales document:
 *
 *   - `certificate`  → ДЕКЛАРАЦИЯ ЗА СЪОТВЕТСТВИЕ (declaration of conformity)
 *   - `ppprotocol`   → ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ (acceptance & handover protocol)
 *
 * Same rationale as `i18n.ts`: reporting runs server-side with no Vue/i18n available, so the
 * small string set ships inline. The Bulgarian wording is authoritative — it reproduces the
 * legal text of the legacy PlusMinus forms these documents replace, and must not be reworded
 * without checking the Naredba references it cites.
 */

export type CompanionDocKind = 'certificate' | 'ppprotocol'
export type CompanionLocale = 'en' | 'bg' | 'de' | 'mk'

export interface CompanionDocI18n {
  title: Record<CompanionDocKind, string>
  /** Singular source-document labels for the "issued against" reference line. */
  sourceDoc: {
    invoice: string
    proforma: string
    credit_note: string
    debit_note: string
    cash_sale: string
  }
  label: {
    number: string
    date: string
    recipient: string
    supplier: string
    city: string
    address: string
    taxId: string
    docList: string
    additionalInfo: string
    preparedBy: string
    receivedBy: string
    signature: string
  }
  header: {
    lineNo: string
    name: string
    /** Abbreviated unit header used by the certificate ("Мяр."). */
    unitShort: string
    /** Full unit header used by the protocol ("Мярка"). */
    unit: string
    /** Abbreviated quantity header used by the certificate ("Кол"). */
    quantityShort: string
    /** Full quantity header used by the protocol ("Количество"). */
    quantity: string
    certificate: string
    remark: string
  }
  totalQuantity: string
  /** The legal paragraph printed under the line table, per document kind. */
  body: Record<CompanionDocKind, string>
}

const bg: CompanionDocI18n = {
  title: {
    certificate: 'ДЕКЛАРАЦИЯ ЗА СЪОТВЕТСТВИЕ',
    ppprotocol: 'ПРИЕМО - ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
  },
  sourceDoc: {
    invoice: 'Фактура',
    proforma: 'Проформа',
    credit_note: 'Кредитно известие',
    debit_note: 'Дебитно известие',
    cash_sale: 'Касова продажба',
  },
  label: {
    number: 'Номер',
    date: 'Дата',
    recipient: 'Получател',
    supplier: 'Доставчик',
    city: 'Град',
    address: 'Адрес',
    taxId: 'ЕИК',
    docList: 'Списък с документи, по които е издаден протоколът:',
    additionalInfo: 'Допълнителна информация:',
    preparedBy: 'Съставил',
    receivedBy: 'Приел',
    signature: 'Подпис',
  },
  header: {
    lineNo: 'No',
    name: 'Име',
    unitShort: 'Мяр.',
    unit: 'Мярка',
    quantityShort: 'Кол',
    quantity: 'Количество',
    certificate: 'Сертификат',
    remark: 'Забележка',
  },
  totalQuantity: 'Общо количество',
  body: {
    certificate:
      'Този документ удостоверява, че всички разпоредби по отношение на сертификацията на доставените продукти, '
      + 'както и на НАРЕДБА № 2 ОТ 23 ЯНУАРИ 2008 Г. ЗА МАТЕРИАЛИТЕ И ПРЕДМЕТИТЕ ОТ ПЛАСТМАСИ, ПРЕДНАЗНАЧЕНИ ЗА '
      + 'КОНТАКТ С ХРАНИ и РЕГЛАМЕНТ № 1935/2004 относно материалите и предметите, предназначени за контакт с храни, '
      + 'са приложени и изпълнени. Продуктите са произведени в условията на въведена от производителя система за '
      + 'производствен контрол и отговарят на всички изисквания, предписани със съответния сертификат за съответствие.',
    ppprotocol:
      'С подписването на настоящия протокол, страните удостоверяват, че предадените стоки и/ или извършени услуги '
      + 'отговарят по вид, количество и качество на договореностите между тях.',
  },
}

const en: CompanionDocI18n = {
  title: {
    certificate: 'DECLARATION OF CONFORMITY',
    ppprotocol: 'ACCEPTANCE AND HANDOVER PROTOCOL',
  },
  sourceDoc: {
    invoice: 'Invoice',
    proforma: 'Proforma',
    credit_note: 'Credit Note',
    debit_note: 'Debit Note',
    cash_sale: 'Cash Sale',
  },
  label: {
    number: 'Number',
    date: 'Date',
    recipient: 'Recipient',
    supplier: 'Supplier',
    city: 'City',
    address: 'Address',
    taxId: 'Reg. No',
    docList: 'Documents this protocol was issued against:',
    additionalInfo: 'Additional information:',
    preparedBy: 'Prepared by',
    receivedBy: 'Received by',
    signature: 'Signature',
  },
  header: {
    lineNo: 'No',
    name: 'Name',
    unitShort: 'Unit',
    unit: 'Unit',
    quantityShort: 'Qty',
    quantity: 'Quantity',
    certificate: 'Certificate',
    remark: 'Remark',
  },
  totalQuantity: 'Total quantity',
  body: {
    certificate:
      'This document certifies that all provisions regarding the certification of the delivered products, as well as '
      + 'ORDINANCE No 2 OF 23 JANUARY 2008 ON PLASTIC MATERIALS AND ARTICLES INTENDED TO COME INTO CONTACT WITH FOOD '
      + 'and REGULATION No 1935/2004 on materials and articles intended to come into contact with food, have been '
      + 'applied and fulfilled. The products are manufactured under a production control system implemented by the '
      + 'manufacturer and meet all requirements prescribed by the corresponding certificate of conformity.',
    ppprotocol:
      'By signing this protocol, the parties certify that the goods handed over and/or services performed correspond '
      + 'in type, quantity and quality to the agreements between them.',
  },
}

const de: CompanionDocI18n = {
  title: {
    certificate: 'KONFORMITÄTSERKLÄRUNG',
    ppprotocol: 'ÜBERGABE- UND ABNAHMEPROTOKOLL',
  },
  sourceDoc: {
    invoice: 'Rechnung',
    proforma: 'Proformarechnung',
    credit_note: 'Gutschrift',
    debit_note: 'Lastschrift',
    cash_sale: 'Barverkauf',
  },
  label: {
    number: 'Nummer',
    date: 'Datum',
    recipient: 'Empfänger',
    supplier: 'Lieferant',
    city: 'Stadt',
    address: 'Adresse',
    taxId: 'Reg.-Nr.',
    docList: 'Dokumente, zu denen dieses Protokoll ausgestellt wurde:',
    additionalInfo: 'Zusätzliche Informationen:',
    preparedBy: 'Erstellt von',
    receivedBy: 'Empfangen von',
    signature: 'Unterschrift',
  },
  header: {
    lineNo: 'Nr',
    name: 'Bezeichnung',
    unitShort: 'Einh.',
    unit: 'Einheit',
    quantityShort: 'Menge',
    quantity: 'Menge',
    certificate: 'Zertifikat',
    remark: 'Bemerkung',
  },
  totalQuantity: 'Gesamtmenge',
  body: {
    certificate:
      'Dieses Dokument bescheinigt, dass alle Bestimmungen hinsichtlich der Zertifizierung der gelieferten Produkte '
      + 'sowie der VERORDNUNG Nr. 2 VOM 23. JANUAR 2008 ÜBER MATERIALIEN UND GEGENSTÄNDE AUS KUNSTSTOFF, DIE DAZU '
      + 'BESTIMMT SIND, MIT LEBENSMITTELN IN BERÜHRUNG ZU KOMMEN, und der VERORDNUNG Nr. 1935/2004 über Materialien '
      + 'und Gegenstände, die dazu bestimmt sind, mit Lebensmitteln in Berührung zu kommen, angewendet und erfüllt '
      + 'wurden. Die Produkte werden unter einem vom Hersteller eingeführten Produktionskontrollsystem hergestellt '
      + 'und erfüllen alle Anforderungen der entsprechenden Konformitätsbescheinigung.',
    ppprotocol:
      'Mit der Unterzeichnung dieses Protokolls bestätigen die Parteien, dass die übergebenen Waren und/oder '
      + 'erbrachten Leistungen in Art, Menge und Qualität den zwischen ihnen getroffenen Vereinbarungen entsprechen.',
  },
}

const mk: CompanionDocI18n = {
  title: {
    certificate: 'ДЕКЛАРАЦИЈА ЗА СООБРАЗНОСТ',
    ppprotocol: 'ПРИЕМО - ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
  },
  sourceDoc: {
    invoice: 'Фактура',
    proforma: 'Проформа',
    credit_note: 'Кредитна белешка',
    debit_note: 'Дебитна белешка',
    cash_sale: 'Касова продажба',
  },
  label: {
    number: 'Број',
    date: 'Датум',
    recipient: 'Примач',
    supplier: 'Доставувач',
    city: 'Град',
    address: 'Адреса',
    taxId: 'ЕДБ',
    docList: 'Список на документи по кои е издаден протоколот:',
    additionalInfo: 'Дополнителни информации:',
    preparedBy: 'Составил',
    receivedBy: 'Примил',
    signature: 'Потпис',
  },
  header: {
    lineNo: 'Бр',
    name: 'Име',
    unitShort: 'Мер.',
    unit: 'Мерка',
    quantityShort: 'Кол',
    quantity: 'Количество',
    certificate: 'Сертификат',
    remark: 'Забелешка',
  },
  totalQuantity: 'Вкупно количество',
  body: {
    certificate:
      'Овој документ потврдува дека сите одредби во однос на сертификацијата на испорачаните производи, како и на '
      + 'НАРЕДБА № 2 ОД 23 ЈАНУАРИ 2008 Г. ЗА МАТЕРИЈАЛИТЕ И ПРЕДМЕТИТЕ ОД ПЛАСТИКА НАМЕНЕТИ ЗА КОНТАКТ СО ХРАНА и '
      + 'РЕГУЛАТИВА № 1935/2004 за материјалите и предметите наменети за контакт со храна, се применети и исполнети. '
      + 'Производите се произведени во услови на воведен од производителот систем за производствена контрола и '
      + 'одговараат на сите барања пропишани со соодветниот сертификат за сообразност.',
    ppprotocol:
      'Со потпишувањето на овој протокол, страните потврдуваат дека предадените стоки и/или извршените услуги '
      + 'одговараат по вид, количество и квалитет на договореното меѓу нив.',
  },
}

const TABLE: Record<CompanionLocale, CompanionDocI18n> = { en, bg, de, mk }

export function companionDocI18n(locale?: string): CompanionDocI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as CompanionLocale
  return TABLE[key] || en
}

export function sourceDocLabel(docType: string | undefined, locale?: string): string {
  const t = companionDocI18n(locale).sourceDoc as Record<string, string>
  return t[docType || 'invoice'] || t.invoice
}
