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
export { DatecsFiscalPrinter } from './datecs.js'
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
} from './fiscal-device.service.js'
