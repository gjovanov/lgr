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
import { cashSaleLineTotalsGrossLate } from './migrations/0011-cash-sale-line-totals-gross-late.js'
import { printerGateOff } from './migrations/0012-printer-gate-off.js'
import { accountingFilePermission } from './migrations/0013-accounting-file-permission.js'
import { sellerPermissionSets } from './migrations/0014-seller-permission-sets.js'
import { rolesFromSets } from './migrations/0015-roles-from-sets.js'
import { dropUnreadTextIndexes } from './migrations/0016-drop-unread-text-indexes.js'
import { rolesBeforeTheArchive } from './migrations/0016-roles-before-the-archive.js'
import { legacyAccessArchive } from './migrations/0017-legacy-access-archive.js'
import { productSearchField } from './migrations/0018-product-search-field.js'
import { dropUnusedIndexes } from './migrations/0019-drop-unused-indexes.js'
import { legacyAccessArchiveDrop } from './migrations/0020-legacy-access-archive-drop.js'
import { relayReceiptsKept60Days } from './migrations/0021-relay-receipts-kept-60-days.js'
import { dropUnusedIndexesFr305 } from './migrations/0022-drop-unused-indexes-fr30-5.js'
import { importedLineTotalsGross } from './migrations/0023-imported-line-totals-gross.js'
import { invoiceNumberParts } from './migrations/0024-invoice-number-parts.js'
import FINGERPRINTS from './fingerprints.json' with { type: 'json' }

/**
 * Every migration, in the order they run. Append only: a new migration goes at the end with the
 * next number, and a released one is never removed, reordered or edited (the runner refuses a
 * changed checksum). The list is explicit rather than discovered from the file system, so a
 * bundled build carries exactly these and nothing a stray file adds.
 *
 * ⚠ One exception, `0016-roles-before-the-archive`, sits before 0017. A master skips releases, and
 * the step it had to come before was already released: placed at the end it would run after 0020,
 * when what it reads is gone. The runner runs what `_migrations` lacks in this order, so a node that
 * ran 0017 already runs it after 0017, and an exception like it must then find nothing to do.
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
  cashSaleLineTotalsGrossLate,
  printerGateOff,
  accountingFilePermission,
  sellerPermissionSets,
  rolesFromSets,
  dropUnreadTextIndexes,
  rolesBeforeTheArchive,
  legacyAccessArchive,
  productSearchField,
  dropUnusedIndexes,
  legacyAccessArchiveDrop,
  relayReceiptsKept60Days,
  dropUnusedIndexesFr305,
  importedLineTotalsGross,
  invoiceNumberParts,
]

/**
 * #980: the CONTRACT steps, which remove what an earlier release reads, declares or writes. Named here
 * and not in their files, because a released file never changes.
 *
 * A master's update runs, in one start, every step the master skipped, and goes back to the version
 * before if the update fails its confirmation (FR-20.20). Expand-then-contract keeps that safe only
 * when the version gone back to is the release before, and a master skips releases: from 0.1.12, the
 * update to 0.1.13 removes the legacy access fields 0.1.12 reads (0017, 0020), and indexes it
 * declares, which it then builds again at its first start. So while an update is watched its contract
 * steps are HELD: the new code reads none of what they remove, and they run once the update is
 * confirmed (`runner.ts`, `start.ts`).
 *
 * ⚠ What belongs here: a step that drops a field, a collection or an index. Not a change of meaning
 * the new code needs at once (0023's line totals): held, the new code would misread the data for as
 * long as it is watched. What such a step did is applied again by the next update when the one that
 * applied it failed (`failedVersions`). Nothing that is not listed may depend on a step that is: the
 * runner goes on past a held one. `0016-roles-before-the-archive` reads what 0017 archives, and runs
 * before it, held or not.
 */
export const CONTRACT: ReadonlySet<string> = new Set([
  '0016-drop-unread-text-indexes',
  '0017-legacy-access-archive',
  '0019-drop-unused-indexes',
  '0020-legacy-access-archive-drop',
  '0022-drop-unused-indexes-fr30-5',
])

/** {@link RELEASED}, each carrying its file's fingerprint, which the runner checksums, and its {@link CONTRACT} mark. */
export const MIGRATIONS: Migration[] = RELEASED.map(m => ({
  ...m,
  fingerprint: (FINGERPRINTS as Record<string, string | undefined>)[m.id],
  ...(CONTRACT.has(m.id) ? { contract: true } : {}),
}))
