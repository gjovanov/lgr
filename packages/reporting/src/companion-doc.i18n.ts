/**
 * Strings for the two companion documents printed alongside an outgoing sales document:
 *
 *   - `certificate`  → ДЕКЛАРАЦИЯ ЗА СЪОТВЕТСТВИЕ (declaration of conformity)
 *   - `ppprotocol`   → ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ (acceptance & handover protocol)
 *
 * Same rationale as `i18n.ts`: reporting runs server-side with no Vue/i18n available, so the
 * small string set ships inline. The Bulgarian wording is authoritative — the other three
 * locales are translations of it, never the other way round, and it must not be reworded
 * without the customer's written say-so.
 *
 * The certificate paragraph was rewritten on 2026-09-03 at the customer's request. It used to
 * cite НАРЕДБА № 2/2008 + РЕГЛАМЕНТ 1935/2004 (plastics in contact with food) — inherited from
 * the legacy PlusMinus form and simply the wrong body of law for a fastener trader. It now
 * cites the product standard (DIN / ISO / other applicable) instead.
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
    /**
     * Heading of the source-document reference block. Per kind: the protocol is "issued
     * against" its documents, while the declaration simply "refers to" them — the old shared
     * string called the declaration a protocol on its own face.
     */
    docList: Record<CompanionDocKind, string>
    additionalInfo: string
    preparedBy: string
    receivedBy: string
    signature: string
  }
  header: {
    lineNo: string
    name: string
    /**
     * Unit and quantity headers, spelled out ("Мярка" / "Количество") on BOTH companion kinds.
     * The declaration used to print the abbreviated "Мяр." / "Кол" the legacy PlusMinus form
     * carried; it now reads like the protocol and the invoice (gjovanov/lgr#127).
     */
    unit: string
    quantity: string
    certificate: string
    remark: string
  }
  /**
   * Label of the boxed total quantity under the line table (both companion kinds). Plain
   * "Общо" rather than "Общо количество" — the box sits under the quantity column, and these
   * documents carry no amounts for it to be confused with.
   */
  total: string
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
    docList: {
      certificate: 'Отнася се за документ:',
      ppprotocol: 'Списък с документи, по които е издаден протоколът:',
    },
    additionalInfo: 'Допълнителна информация:',
    preparedBy: 'Съставил',
    receivedBy: 'Приел',
    signature: 'Подпис',
  },
  header: {
    lineNo: 'No',
    name: 'Име',
    unit: 'Мярка',
    quantity: 'Количество',
    certificate: 'Сертификат',
    remark: 'Забележка',
  },
  total: 'Общо',
  body: {
    certificate:
      'Настоящият документ удостоверява, че всички разпоредби по отношение на сертификация на дадените продукти '
      + '(DIN, ISO, или друг приложим стандарт) са приложени и изпълнени. Продуктите са произведени в условия на '
      + 'въведената от производителя система за производствен контрол и отговарят на всички изисквания на съответния '
      + 'стандарт.',
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
    docList: {
      certificate: 'Refers to document:',
      ppprotocol: 'Documents this protocol was issued against:',
    },
    additionalInfo: 'Additional information:',
    preparedBy: 'Prepared by',
    receivedBy: 'Received by',
    signature: 'Signature',
  },
  header: {
    lineNo: 'No',
    name: 'Name',
    unit: 'Unit',
    quantity: 'Quantity',
    certificate: 'Certificate',
    remark: 'Remark',
  },
  total: 'Total',
  body: {
    certificate:
      'This document certifies that all provisions regarding the certification of the given products (DIN, ISO or '
      + 'another applicable standard) have been applied and fulfilled. The products are manufactured under a '
      + 'production control system implemented by the manufacturer and meet all requirements of the corresponding '
      + 'standard.',
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
    docList: {
      certificate: 'Betrifft Dokument:',
      ppprotocol: 'Dokumente, zu denen dieses Protokoll ausgestellt wurde:',
    },
    additionalInfo: 'Zusätzliche Informationen:',
    preparedBy: 'Erstellt von',
    receivedBy: 'Empfangen von',
    signature: 'Unterschrift',
  },
  header: {
    lineNo: 'Nr',
    name: 'Bezeichnung',
    unit: 'Einheit',
    quantity: 'Menge',
    certificate: 'Zertifikat',
    remark: 'Bemerkung',
  },
  total: 'Gesamt',
  body: {
    certificate:
      'Dieses Dokument bescheinigt, dass alle Bestimmungen hinsichtlich der Zertifizierung der gelieferten Produkte '
      + '(DIN, ISO oder eine andere anwendbare Norm) angewendet und erfüllt wurden. Die Produkte werden unter einem '
      + 'vom Hersteller eingeführten Produktionskontrollsystem hergestellt und erfüllen alle Anforderungen der '
      + 'entsprechenden Norm.',
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
    docList: {
      certificate: 'Се однесува на документ:',
      ppprotocol: 'Список на документи по кои е издаден протоколот:',
    },
    additionalInfo: 'Дополнителни информации:',
    preparedBy: 'Составил',
    receivedBy: 'Примил',
    signature: 'Потпис',
  },
  header: {
    lineNo: 'Бр',
    name: 'Име',
    unit: 'Мерка',
    quantity: 'Количество',
    certificate: 'Сертификат',
    remark: 'Забелешка',
  },
  total: 'Вкупно',
  body: {
    certificate:
      'Овој документ потврдува дека сите одредби во однос на сертификацијата на дадените производи (DIN, ISO или '
      + 'друг применлив стандард) се применети и исполнети. Производите се произведени во услови на воведен од '
      + 'производителот систем за производствена контрола и одговараат на сите барања на соодветниот стандард.',
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
