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
} from './types.js'

export { toFiscalPaymentType, toVatGroup } from './types.js'
export { DatecsFiscalPrinter, buildFrame, parseResponse, CMD } from './datecs.js'
export { WebSocketFiscalPrinter, type SendCommandFn } from './ws-fiscal-printer.js'
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
