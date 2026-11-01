import type { Migration } from './types.js'
import { baseline } from './migrations/0000-baseline.js'
import { unpPerDevice } from './migrations/0001-unp-per-device.js'
import { fileSha256 } from './migrations/0002-file-sha256.js'
import { relativeFilePaths } from './migrations/0003-relative-file-paths.js'
import { fileRowsFollowTheirBytes } from './migrations/0004-file-rows-follow-their-bytes.js'
import { granularPermissions } from './migrations/0005-granular-permissions.js'
import { posOutRecordOnly } from './migrations/0006-pos-out-record-only.js'
import { cashSaleLineTotalsGross } from './migrations/0007-cash-sale-line-totals-gross.js'
import { cashRegisterCopy } from './migrations/0008-cash-register-copy.js'
import { cashRegisterFreeze } from './migrations/0009-cash-register-freeze.js'
import { invoiceNumberClash } from './migrations/0010-invoice-number-clash.js'
import { printerGateOff } from './migrations/0011-printer-gate-off.js'
import FINGERPRINTS from './fingerprints.json' with { type: 'json' }

/**
 * Every migration, in the order they run. Append only: a new migration goes at the end with the
 * next number, and a released one is never removed, reordered or edited (the runner refuses a
 * changed checksum). The list is explicit rather than discovered from the file system, so a
 * bundled build carries exactly these and nothing a stray file adds.
 *
 * A new migration also gets its line in `fingerprints.json`:
 * `bun run packages/migrations/src/fingerprint.ts --write`.
 */
export const RELEASED: Migration[] = [
  baseline,
  unpPerDevice,
  fileSha256,
  relativeFilePaths,
  fileRowsFollowTheirBytes,
  granularPermissions,
  posOutRecordOnly,
  cashSaleLineTotalsGross,
  cashRegisterCopy,
  cashRegisterFreeze,
  invoiceNumberClash,
  printerGateOff,
]

/** {@link RELEASED}, each carrying its file's fingerprint, which the runner checksums. */
export const MIGRATIONS: Migration[] = RELEASED.map(m => ({
  ...m,
  fingerprint: (FINGERPRINTS as Record<string, string | undefined>)[m.id],
}))
