/**
 * The number a keyed document holds between its insert and its real number. Never a valid prefix,
 * so it cannot collide with an allocated number; unique per key, so it cannot collide with another
 * pending document. A keyed `POST /invoices` uses the same placeholder.
 *
 * ⚠ It exists because a CS number is a legal sequence. Allocated before the insert, every losing
 * duplicate of a racing retry would burn one and leave a gap. Only the request whose insert wins
 * draws a number.
 *
 * Import-pure: the replication's apply reads it too.
 */
export const PENDING_NUMBER = '~pending:'
export const isPendingNumber = (n: unknown) => String(n ?? '').startsWith(PENDING_NUMBER)
