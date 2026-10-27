/**
 * The fiscal device as a witness to the legal series (FR-20.51, AC 49, plan step P3-7): what each
 * active device of the org says its last document is, beside the last fiscal receipt this database
 * recorded on it. Shown to the person who records the last numbers issued at the site, and kept in
 * the audit with their reading.
 *
 * ⚠ **Evidence, never a lock or a floor by itself.**
 * - The device's counter is not an LGR series. An Eltrade's last document number (71h) counts every
 *   document it printed: fiscal receipts, stornos, non-fiscal receipts, X and Z reports, and those a
 *   cashier printed from its keyboard. No LGR counter steps with it. The УНП's seven digits are
 *   LGR's, and no driver reads them back.
 * - So a device ahead of the last receipt this database recorded is the normal state after any
 *   day's Z-report. Locking on it would stop a shop's numbering every evening. What those documents
 *   were is read off the device's paper or its journal, by a person, and this tells them how many.
 * - A device that cannot say (Tremol: no `getLastReceiptNumber`) is `unsupported`. One bridged to
 *   another process (another pod, a till elsewhere) is `not_connected` here.
 *
 * `services` never imports `fiscal` (it depends on us), so the API hands the reader in.
 */
import { FiscalDevice, Invoice } from 'db/models'

export type DeviceReading =
  | { state: 'read'; lastDocument: number; readAt: Date }
  | { state: 'not_connected' }
  | { state: 'unsupported' }
  | { state: 'error'; error: string }

/** Asks one device for its last document number. */
export type DeviceReader = (deviceId: string) => Promise<DeviceReading>

export interface DeviceEvidence {
  id: string
  name: string
  deviceNumber: string
  reading: DeviceReading
  /** The last fiscal receipt this database recorded on the device, or null. */
  recorded: { receiptNo: string; unp: string | null; number: string; printedAt: Date | null } | null
  /** Documents the device printed after that receipt, when both are numbers: what a person accounts for. */
  since: number | null
}

/** A receipt number as the device printed it: digits, possibly zero-padded. */
function asCount(v: unknown): number | null {
  const s = String(v ?? '').trim()
  if (!/^\d{1,12}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

/** The last fiscal receipt this database recorded on a device: a text receipt carries no number. */
async function lastRecorded(orgId: string, deviceNumber: string): Promise<DeviceEvidence['recorded']> {
  const doc: any = await Invoice.findOne(
    {
      orgId,
      type: { $in: ['cash_sale', 'cash_storno'] },
      'register.fiscalDeviceNumber': deviceNumber,
      'register.fiscalReceiptNumber': { $type: 'string', $ne: '' },
    },
    { invoiceNumber: 1, 'register.fiscalReceiptNumber': 1, 'register.unp': 1, 'register.printedAt': 1 },
  ).sort({ 'register.printedAt': -1, _id: -1 }).lean()
  if (!doc) return null
  return {
    receiptNo: String(doc.register.fiscalReceiptNumber),
    unp: doc.register.unp ?? null,
    number: String(doc.invoiceNumber ?? ''),
    printedAt: doc.register.printedAt ?? null,
  }
}

/** Each active fiscal device of the org: what it says, and what this database last recorded on it. */
export async function deviceEvidence(orgId: string, read: DeviceReader): Promise<DeviceEvidence[]> {
  const devices: any[] = await FiscalDevice.find({ orgId, isActive: true }, { name: 1, deviceNumber: 1 }).sort({ deviceNumber: 1 }).lean()
  return Promise.all(devices.map(async d => {
    const [reading, recorded] = await Promise.all([
      read(String(d._id)).catch((e: any): DeviceReading => ({ state: 'error', error: String(e?.message ?? e).slice(0, 200) })),
      lastRecorded(orgId, d.deviceNumber),
    ])
    const was = recorded ? asCount(recorded.receiptNo) : null
    return {
      id: String(d._id),
      name: d.name ?? '',
      deviceNumber: d.deviceNumber,
      reading,
      recorded,
      since: reading.state === 'read' && was !== null ? reading.lastDocument - was : null,
    }
  }))
}

/** The evidence as the audit keeps it: one line per device, what this database had and what the device said. */
export function evidenceChanges(evidence: DeviceEvidence[]): Array<{ field: string; oldValue: unknown; newValue: unknown }> {
  return evidence.map(e => ({
    field: `fiscal device ${e.deviceNumber}: last document`,
    oldValue: e.recorded?.receiptNo ?? null,
    newValue: e.reading.state === 'read' ? e.reading.lastDocument : e.reading.state,
  }))
}
