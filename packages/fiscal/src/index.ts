export type {
  IFiscalPrinter,
  FiscalDeviceStatus,
  FiscalReceiptResult,
  FiscalStornoResult,
  ZReportResult,
  FiscalConnectionConfig,
  VatGroup,
  FiscalPaymentType,
  FiscalPaymentName,
  StornoReason,
  FiscalExchangeOptions,
} from './types.js'

export { toFiscalPaymentType, toVatGroup, paymentCode, FiscalUnsupportedError, FiscalPaymentMethodError } from './types.js'
export { DatecsFiscalPrinter, buildFrame, parseResponse, CMD } from './datecs.js'
export { TremolFiscalPrinter, buildTremolFrame, parseTremolResponse, TREMOL_CMD } from './tremol.js'
export {
  EltradeFiscalPrinter, EltradeError, ELTRADE_CMD, ELTRADE_PAYMENT_SLOTS, decodeEltradeStatus,
  type EltradeStatus, type EltradeErrorKind,
} from './eltrade.js'
export {
  fiscalCapabilities, fiscalDriverFor, unsupportedReason, FISCAL_FEATURES, FEATURE_METHODS, CASH_ON_DELIVERY_NAME,
  type FiscalCapabilities, type FiscalFeature, type FiscalDriver, type FiscalMissing,
} from './capabilities.js'
export { fiscalFailure, FiscalNotConnectedError, type FiscalFailure, type FiscalFailureCode } from './errors.js'
export { buildIslFrame, parseIslStream, ISL } from './isl-frame.js'
export { IslTcpTransport } from './isl-tcp.js'
export { WebSocketFiscalPrinter, type SendCommandFn } from './ws-fiscal-printer.js'
export { WsTremolFiscalPrinter } from './ws-tremol-printer.js'
export { mapTaxRateToVatGroup, DEFAULT_VAT_GROUPS, type VatGroupConfig } from './vat-groups.js'

export {
  createPrinter,
  connectDevice,
  disconnectDevice,
  getPrinter,
  isDeviceConnected,
  getDeviceStatus,
  getActiveDeviceIds,
  disconnectAll,
  buildConnectionConfig,
  registerPrinter,
  unregisterPrinter,
} from './fiscal-device.service.js'

export { fiscalInFlight, fiscalOperation, tracked, whenFiscalIdle } from './in-flight.js'
