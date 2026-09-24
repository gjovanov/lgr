export type {
  IFiscalPrinter,
  FiscalDeviceStatus,
  FiscalReceiptResult,
  FiscalStornoResult,
  ZReportResult,
  FiscalConnectionConfig,
  VatGroup,
  FiscalPaymentType,
  StornoReason,
  FiscalExchangeOptions,
} from './types.js'

export { toFiscalPaymentType, toVatGroup } from './types.js'
export { DatecsFiscalPrinter, buildFrame, parseResponse, CMD } from './datecs.js'
export { TremolFiscalPrinter, buildTremolFrame, parseTremolResponse, TREMOL_CMD } from './tremol.js'
export { EltradeFiscalPrinter, EltradeError, ELTRADE_CMD, decodeEltradeStatus, type EltradeStatus } from './eltrade.js'
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
