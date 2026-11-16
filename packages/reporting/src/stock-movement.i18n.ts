/**
 * Strings for a printed stock movement (`pdf/stock-movement.pdf.ts`): the sheet that goes with the
 * goods, or to the people on the other side of a transfer.
 *
 * Same server-side constraint as `i18n.ts`: no Vue/i18n available, so the label set ships inline.
 * The Bulgarian wording is authoritative; the other three locales translate it. The names of the
 * movement types are the screens' own (`warehouse.movementTypes.*` in the web catalogue);
 * `unit/stock-movement-document.test.ts` holds the two together.
 */

export type StockMovementLocale = 'en' | 'bg' | 'de' | 'mk'

/** The movement types that have a title of their own. Every other type prints `title.other`. */
export type StockMovementTitleKind = 'receipt' | 'transfer' | 'other'

export interface StockMovementI18n {
  title: Record<StockMovementTitleKind, string>
  /** A movement type as the screens name it; a type not listed prints as it is stored. */
  type: Record<string, string>
  label: {
    number: string
    date: string
    /** In front of the type's name, on a sheet whose title does not say it. */
    type: string
    fromWarehouse: string
    toWarehouse: string
    /** After the name of a warehouse that is another site's: its stock is not kept here. */
    external: string
    partner: string
    reference: string
    note: string
    /** After the number of a movement that is not booked yet. */
    draft: string
    handedOverBy: string
    receivedBy: string
    signature: string
  }
  header: {
    lineNo: string
    name: string
    unit: string
    quantity: string
  }
}

const bg: StockMovementI18n = {
  title: {
    receipt: 'СТОКОВА РАЗПИСКА',
    transfer: 'СКЛАДОВА РАЗПИСКА',
    other: 'ДОКУМЕНТ ЗА ДВИЖЕНИЕ НА СТОКИ',
  },
  type: {
    receipt: 'Заприходяване',
    dispatch: 'Експедиция',
    transfer: 'Прехвърляне',
    adjustment: 'Корекция',
    return: 'Връщане',
    production_in: 'Производство вход',
    production_out: 'Производство изход',
  },
  label: {
    number: 'Номер',
    date: 'Дата',
    type: 'Вид',
    fromWarehouse: 'От склад',
    toWarehouse: 'Към склад',
    external: 'външен',
    partner: 'Контрагент',
    reference: 'Основание',
    note: 'Забележка',
    draft: 'чернова',
    handedOverBy: 'Предал',
    receivedBy: 'Приел',
    signature: 'подпис',
  },
  header: { lineNo: '№', name: 'Наименование', unit: 'Мярка', quantity: 'Количество' },
}

const en: StockMovementI18n = {
  title: {
    receipt: 'GOODS RECEIPT',
    transfer: 'STOCK TRANSFER NOTE',
    other: 'STOCK MOVEMENT',
  },
  type: {
    receipt: 'Receipt',
    dispatch: 'Dispatch',
    transfer: 'Transfer',
    adjustment: 'Adjustment',
    return: 'Return',
    production_in: 'Production in',
    production_out: 'Production out',
  },
  label: {
    number: 'Number',
    date: 'Date',
    type: 'Type',
    fromWarehouse: 'From warehouse',
    toWarehouse: 'To warehouse',
    external: 'external',
    partner: 'Partner',
    reference: 'Reference',
    note: 'Note',
    draft: 'draft',
    handedOverBy: 'Handed over by',
    receivedBy: 'Received by',
    signature: 'signature',
  },
  header: { lineNo: 'No', name: 'Name', unit: 'Unit', quantity: 'Quantity' },
}

const de: StockMovementI18n = {
  title: {
    receipt: 'WARENEINGANGSSCHEIN',
    transfer: 'UMLAGERUNGSSCHEIN',
    other: 'WARENBEWEGUNG',
  },
  type: {
    receipt: 'Zugang',
    dispatch: 'Abgang',
    transfer: 'Umlagerung',
    adjustment: 'Korrektur',
    return: 'Rückgabe',
    production_in: 'Produktionszugang',
    production_out: 'Produktionsabgang',
  },
  label: {
    number: 'Nummer',
    date: 'Datum',
    type: 'Art',
    fromWarehouse: 'Von Lager',
    toWarehouse: 'Zu Lager',
    external: 'extern',
    partner: 'Geschäftspartner',
    reference: 'Bezug',
    note: 'Bemerkung',
    draft: 'Entwurf',
    handedOverBy: 'Übergeben von',
    receivedBy: 'Empfangen von',
    signature: 'Unterschrift',
  },
  header: { lineNo: 'Nr', name: 'Bezeichnung', unit: 'Einheit', quantity: 'Menge' },
}

const mk: StockMovementI18n = {
  title: {
    receipt: 'ПРИЕМНИЦА',
    transfer: 'ПРЕНОСНИЦА',
    other: 'ДОКУМЕНТ ЗА ДВИЖЕЊЕ НА СТОКИ',
  },
  type: {
    receipt: 'Прием',
    dispatch: 'Испорака',
    transfer: 'Пренос',
    adjustment: 'Корекција',
    return: 'Враќање',
    production_in: 'Производство влез',
    production_out: 'Производство излез',
  },
  label: {
    number: 'Број',
    date: 'Датум',
    type: 'Вид',
    fromWarehouse: 'Од магацин',
    toWarehouse: 'До магацин',
    external: 'надворешен',
    partner: 'Партнер',
    reference: 'Основ',
    note: 'Забелешка',
    draft: 'нацрт',
    handedOverBy: 'Предал',
    receivedBy: 'Примил',
    signature: 'потпис',
  },
  header: { lineNo: 'Бр', name: 'Назив', unit: 'Мерка', quantity: 'Количество' },
}

const TABLE: Record<StockMovementLocale, StockMovementI18n> = { en, bg, de, mk }

export function stockMovementI18n(locale?: string): StockMovementI18n {
  const key = (locale || 'en').toLowerCase().split('-')[0] as StockMovementLocale
  return TABLE[key] || en
}

/** Which title a movement of this type prints under. */
export function stockMovementTitleKind(type: string | null | undefined): StockMovementTitleKind {
  return type === 'receipt' || type === 'transfer' ? type : 'other'
}
