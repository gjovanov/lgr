import type { Migration } from './types.js'
import { baseline } from './migrations/0000-baseline.js'
import { unpPerDevice } from './migrations/0001-unp-per-device.js'
import { fileSha256 } from './migrations/0002-file-sha256.js'

/**
 * Every migration, in the order they run. Append only: a new migration goes at the end with the
 * next number, and a released one is never removed, reordered or edited (the runner refuses a
 * changed checksum). The list is explicit rather than discovered from the file system, so a
 * bundled build carries exactly these and nothing a stray file adds.
 */
export const MIGRATIONS: Migration[] = [
  baseline,
  unpPerDevice,
  fileSha256,
]
