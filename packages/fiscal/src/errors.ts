/**
 * A failed fiscal command, as the API answers it.
 *
 * Every device endpoint used to answer 500 whatever went wrong, so the device page could not tell
 * "correct what you typed" from "the device said no" from "nothing is plugged in". The driver
 * knows which it is (`EltradeError.kind`); this maps it:
 *
 *   400 bad_input        the request's data — refused before anything was sent
 *   400 unsupported      the driver or the device cannot do it at all (`FiscalUnsupportedError`)
 *   409 receipt_open     a receipt is open, and the command will not touch it
 *   409 device_busy      another document held the device for as long as this one could wait
 *   409 device_refused   the device answered and did not execute it (out of paper, not allowed now…)
 *   502 device_protocol  the device answered something that cannot be read
 *   503 not_connected    nothing holds the device: no bridge, the socket is gone
 *   504 device_timeout   no answer in time
 *   500 device_error     anything else. The older drivers throw plain errors, read by their message.
 *
 * Errors are recognised by `name`, not `instanceof`, so this module loads no driver.
 */
import type { EltradeErrorKind } from './eltrade.js'

/** `getPrinter` for a device nothing holds. */
export class FiscalNotConnectedError extends Error {
  constructor(deviceId: string) {
    super(`Fiscal device ${deviceId} is not connected`)
    this.name = 'FiscalNotConnectedError'
  }
}

export type FiscalFailureCode =
  | 'bad_input'
  | 'unsupported'
  | 'receipt_open'
  | 'device_busy'
  | 'device_refused'
  | 'device_protocol'
  | 'not_connected'
  | 'device_timeout'
  | 'device_error'

export interface FiscalFailure {
  status: 400 | 409 | 500 | 502 | 503 | 504
  code: FiscalFailureCode
  message: string
}

const BY_KIND: Record<EltradeErrorKind, Pick<FiscalFailure, 'status' | 'code'>> = {
  input: { status: 400, code: 'bad_input' },
  busy: { status: 409, code: 'receipt_open' },
  rejected: { status: 409, code: 'device_refused' },
  protocol: { status: 502, code: 'device_protocol' },
  unreachable: { status: 503, code: 'not_connected' },
  timeout: { status: 504, code: 'device_timeout' },
}

export function fiscalFailure(e: unknown): FiscalFailure {
  const err = e as { name?: string; kind?: string; message?: string } | null | undefined
  const message = String(err?.message || e || 'Fiscal device error')
  if (err?.name === 'EltradeError' && err.kind && err.kind in BY_KIND) {
    return { ...BY_KIND[err.kind as EltradeErrorKind], message }
  }
  if (err?.name === 'DeviceBusyError') return { status: 409, code: 'device_busy', message }
  if (err?.name === 'FiscalUnsupportedError') return { status: 400, code: 'unsupported', message }
  if (err?.name === 'FiscalNotConnectedError') return { status: 503, code: 'not_connected', message }
  if (/not connected|disconnected|failed to send/i.test(message)) return { status: 503, code: 'not_connected', message }
  if (/timeout|timed out/i.test(message)) return { status: 504, code: 'device_timeout', message }
  return { status: 500, code: 'device_error', message }
}
