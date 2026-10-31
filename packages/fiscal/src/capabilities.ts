/**
 * What each fiscal driver can do, known before a device is connected: the device page asks, and
 * disables what a device cannot do with the reason, instead of offering a button that answers
 * "not supported" (an Eltrade's "Read from Device" did exactly that).
 *
 * A device is served by ONE driver, chosen by its manufacturer and by who opens its port: the
 * server (`createPrinter`, TCP) or a bridge (`createBridgePrinter`: a browser tab or an LGR
 * Desktop). `fiscalDriverFor` makes the choice those two factories make, and
 * `tests/src/unit/fiscal-capabilities.test.ts` holds this table to the driver classes: a feature is
 * on exactly when the class has the methods behind it, and the factories build the class named here.
 *
 * Why a feature is off matters to whoever reads the page:
 *  - `protocol`  the device's own protocol has no such command — it will never work (an Eltrade
 *                cannot report its operators, print an operator report or its electronic journal);
 *  - `driver`    the protocol has it, LGR's driver does not implement it yet;
 *  - `no_driver` LGR cannot open this device this way at all.
 *
 * Import-pure: no driver is imported here, so nothing touches a port or the logger.
 */

export const FISCAL_FEATURES = [
  'zReport',
  'xReport',
  'operatorReport',
  'fmReportByDate',
  'fmReportByNumber',
  'electronicJournal',
  'readOperator',
  'programOperator',
  'textReceipt',
  'paymentNames',
  'cashOnDelivery',
] as const
export type FiscalFeature = typeof FISCAL_FEATURES[number]

/**
 * The driver methods each feature needs. `cashOnDelivery` is a payment slot, not a method: a driver
 * without one refuses the payment (`paymentCode`), which the capability test checks by sending it.
 */
export const FEATURE_METHODS: Record<Exclude<FiscalFeature, 'cashOnDelivery'>, readonly string[]> = {
  zReport: ['printDailyZReport'],
  xReport: ['printDailyXReport'],
  operatorReport: ['printOperatorReport'],
  fmReportByDate: ['printFiscalMemoryReportByDate'],
  fmReportByNumber: ['printFiscalMemoryReportByNumber'],
  electronicJournal: ['printEJReport'],
  readOperator: ['readOperator'],
  programOperator: ['programOperator'],
  textReceipt: ['openNonFiscalReceipt', 'printNonFiscalText', 'closeNonFiscalReceipt'],
  paymentNames: ['readPaymentNames', 'programPaymentName'],
}

/**
 * The drivers, by what instantiates them: `eltrade` = `EltradeFiscalPrinter` (server TCP and
 * bridges alike); `datecs` = `DatecsFiscalPrinter` (server, also for Daisy and — so far — Tremol);
 * `datecs-bridge` = `WebSocketFiscalPrinter`; `tremol-bridge` = `WsTremolFiscalPrinter`.
 * `TremolFiscalPrinter` (tremol.ts) is not here: nothing instantiates it.
 */
export type FiscalDriver = 'eltrade' | 'datecs' | 'datecs-bridge' | 'tremol-bridge'
export type FiscalMissing = 'protocol' | 'driver' | 'no_driver'

export interface FiscalCapabilities {
  /** The driver that serves the device, or null when LGR cannot open it this way. */
  driver: FiscalDriver | null
  features: Record<FiscalFeature, boolean>
  /** Why each feature that is off is off. */
  missing: Partial<Record<FiscalFeature, FiscalMissing>>
  /** Operators are numbered 1..maxOperators; 0 when they cannot be programmed. */
  maxOperators: number
  /** The payment slot cash on delivery prints in, and the name the device page gives it. */
  cashOnDeliverySlot?: { code: string; name: string }
}

/** What the reserve slot is named, so a COD receipt says what it was. Printed — always Bulgarian. */
export const CASH_ON_DELIVERY_NAME = 'НАЛОЖЕН ПЛАТЕЖ'

function driverCapabilities(
  on: readonly FiscalFeature[],
  notInProtocol: readonly FiscalFeature[],
  extra: Pick<FiscalCapabilities, 'maxOperators' | 'cashOnDeliverySlot'>,
): Omit<FiscalCapabilities, 'driver'> {
  const features = {} as Record<FiscalFeature, boolean>
  const missing: Partial<Record<FiscalFeature, FiscalMissing>> = {}
  for (const f of FISCAL_FEATURES) {
    features[f] = on.includes(f)
    if (!features[f]) missing[f] = notInProtocol.includes(f) ? 'protocol' : 'driver'
  }
  return { features, missing, ...extra }
}

const DRIVERS: Record<FiscalDriver, Omit<FiscalCapabilities, 'driver'>> = {
  // Protocol v1.1.7: no command reads an operator (66h only sets one), none prints an operator
  // report or the КЛЕН. 66h takes operators 1–16; the reserve payment slot 'R' carries COD.
  eltrade: driverCapabilities(
    ['zReport', 'xReport', 'fmReportByDate', 'fmReportByNumber', 'programOperator', 'textReceipt', 'paymentNames', 'cashOnDelivery'],
    ['operatorReport', 'electronicJournal', 'readOperator'],
    { maxOperators: 16, cashOnDeliverySlot: { code: 'R', name: CASH_ON_DELIVERY_NAME } },
  ),
  // The Datecs drivers implement a sale, a storno, the Z-report and the clock — nothing else yet.
  datecs: driverCapabilities(['zReport'], [], { maxOperators: 0 }),
  'datecs-bridge': driverCapabilities(['zReport'], [], { maxOperators: 0 }),
  // 8 operators: what the device page has always offered a Tremol (its own limit is unverified).
  'tremol-bridge': driverCapabilities(
    ['zReport', 'xReport', 'operatorReport', 'fmReportByDate', 'fmReportByNumber', 'electronicJournal', 'readOperator', 'programOperator', 'textReceipt'],
    [],
    { maxOperators: 8 },
  ),
}

/** A bridge holds the port at the far end of a socket; the driver still runs on the server. */
const BRIDGED = new Set(['browser', 'desktop'])

/**
 * The driver `createPrinter` (server) or `createBridgePrinter` (bridge) builds for this device;
 * null where the server would refuse to open it.
 */
export function fiscalDriverFor(manufacturer: string, connectionType: string): FiscalDriver | null {
  const bridged = BRIDGED.has(connectionType)
  switch (manufacturer) {
    case 'eltrade':
      return bridged || connectionType === 'tcp' ? 'eltrade' : null
    case 'tremol':
      return bridged ? 'tremol-bridge' : 'datecs'
    case 'datecs':
    case 'daisy':
      return bridged ? 'datecs-bridge' : 'datecs'
    case 'incotex':
      return bridged ? 'datecs-bridge' : null
    default:
      return null
  }
}

/** What a device of `manufacturer` connected over `connectionType` can do. */
export function fiscalCapabilities(manufacturer: string, connectionType: string): FiscalCapabilities {
  const driver = fiscalDriverFor(manufacturer, connectionType)
  if (!driver) {
    const features = Object.fromEntries(FISCAL_FEATURES.map(f => [f, false])) as Record<FiscalFeature, boolean>
    const missing = Object.fromEntries(FISCAL_FEATURES.map(f => [f, 'no_driver' as const]))
    return { driver: null, features, missing, maxOperators: 0 }
  }
  const caps = DRIVERS[driver]
  return {
    driver,
    features: { ...caps.features },
    missing: { ...caps.missing },
    maxOperators: caps.maxOperators,
    ...(caps.cashOnDeliverySlot ? { cashOnDeliverySlot: { ...caps.cashOnDeliverySlot } } : {}),
  }
}

const FEATURE_LABEL: Record<FiscalFeature, string> = {
  zReport: 'the Z-report',
  xReport: 'the X-report',
  operatorReport: 'an operator report',
  fmReportByDate: 'a fiscal-memory report by date',
  fmReportByNumber: 'a fiscal-memory report by number',
  electronicJournal: 'an electronic-journal (КЛЕН) print',
  readOperator: 'reading operators back',
  programOperator: 'programming operators',
  textReceipt: 'non-fiscal (text) receipts',
  paymentNames: 'naming payment types',
  cashOnDelivery: 'a cash-on-delivery payment',
}

const brand = (manufacturer: string) => manufacturer ? manufacturer[0].toUpperCase() + manufacturer.slice(1) : 'This'

/**
 * Why `feature` is off, as the API says it; null when it is on. The device page shows the same
 * reasons from its own message catalogue (`pos.device.why.*`).
 */
export function unsupportedReason(manufacturer: string, connectionType: string, feature: FiscalFeature): string | null {
  const caps = fiscalCapabilities(manufacturer, connectionType)
  if (caps.features[feature]) return null
  const name = brand(manufacturer)
  switch (caps.missing[feature]) {
    case 'protocol':
      return feature === 'readOperator'
        ? `${name} devices cannot report their operators — program them from the device page.`
        : `The ${name} protocol has no ${FEATURE_LABEL[feature].replace(/^(the|an?) /, '')}.`
    case 'no_driver':
      return `LGR cannot open ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} device over "${connectionType}".`
    default:
      return `LGR's driver for this ${name} device does not support ${FEATURE_LABEL[feature]} yet.`
  }
}
