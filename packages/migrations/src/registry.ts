import type { Migration } from './types.js'
import { baseline } from './migrations/0000-baseline.js'

/**
 * Every migration, in the order they run. Append only: a new migration goes at the end with the
 * next number, and a released one is never removed, reordered or edited (the runner refuses a
 * changed checksum). The list is explicit rather than discovered from the file system, so a
 * bundled build carries exactly these and nothing a stray file adds.
 */
export const MIGRATIONS: Migration[] = [
  baseline,
]
