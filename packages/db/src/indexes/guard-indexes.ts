/**
 * FR-29.25: the GUARD indexes: unique indexes that code relies on to refuse a second write. Each says what it guards.
 *
 * A unique index that cannot build over rows that already clash is simply absent, and the code that waits for its
 * duplicate-key error never gets one: two documents under one number, a digest sent twice. `verifyIndexes`
 * (`./verify.ts`) reports such a one apart from the others, at error level, in the sys-admin health and a master's
 * status (D-7: the server still starts).
 *
 * Import-pure: names and key specs only. A new guard joins this list; `integration/index-verification.flow` holds the
 * list to the models' declared indexes, so a guard that is no longer declared fails it.
 */
export interface GuardIndex {
  model: string
  key: Record<string, 1 | -1>
  guards: string
}

export const GUARD_INDEXES: readonly GuardIndex[] = [
  { model: 'Invoice', key: { orgId: 1, invoiceNumber: 1, 'numberClash.withId': 1 }, guards: 'one document per number' },
  { model: 'Invoice', key: { orgId: 1, clientKey: 1 }, guards: 'one document per Idempotency-Key (a sale, a create)' },
  { model: 'StockMovement', key: { orgId: 1, movementNumber: 1 }, guards: 'one movement per number (`withMovementNumber` retries on it)' },
  { model: 'StockMovement', key: { orgId: 1, requestId: 1 }, guards: 'one movement per form request (FR-29.13)' },
  { model: 'Order', key: { orgId: 1, orderNumber: 1 }, guards: 'one supplier order per number' },
  { model: 'Order', key: { orgId: 1, 'createdFrom.requestId': 1 }, guards: 'one supplier order per request (FR-28.17, FR-29.13)' },
  { model: 'InternalOrder', key: { orgId: 1, orderNumber: 1 }, guards: 'one customer order per number' },
  { model: 'InternalOrder', key: { orgId: 1, 'createdFrom.requestId': 1 }, guards: 'one customer order per request (FR-28.18, FR-29.13)' },
  { model: 'Reservation', key: { orgId: 1, reservationNumber: 1 }, guards: 'one reservation per number' },
  { model: 'Reservation', key: { orgId: 1, repeatOf: 1 }, guards: 'one repeat of a reservation' },
  { model: 'JournalEntry', key: { orgId: 1, entryNumber: 1 }, guards: 'one journal entry per number' },
  { model: 'JournalEntry', key: { orgId: 1, importKey: 1 }, guards: 'one imported entry per key (FR-25 §5.5)' },
  { model: 'JournalEntry', key: { orgId: 1, postingKey: 1 }, guards: 'one entry per posting (FR-29.14)' },
  { model: 'PostingJob', key: { orgId: 1, postingKey: 1 }, guards: 'one owed posting per key (FR-29.15)' },
  { model: 'ProductGroupMap', key: { orgId: 1, productId: 1 }, guards: 'one accounting group per product (FR-25 §3.6)' },
  { model: 'PostingRule', key: { orgId: 1, code: 1 }, guards: 'one posting rule per code: two seed runs insert it once (FR-25 §3.7)' },
  {
    model: 'VatRegisterEntry',
    key: { orgId: 1, ledger: 1, 'source.orgId': 1, 'source.id': 1 },
    guards: 'one VAT row per posted document and ledger: two shadow runs at once write it once (FR-25 R3)',
  },
  { model: 'Sequence', key: { orgId: 1, prefix: 1, year: 1 }, guards: 'one counter per series and year' },
  { model: 'DigestRun', key: { orgId: 1, date: 1 }, guards: 'one digest per org and day, whichever pod sends it' },
  { model: 'BackupRun', key: { orgId: 1, kind: 1, date: 1, claimKey: 1 }, guards: 'one backup run per org, kind and day' },
  { model: 'FiscalPresence', key: { orgId: 1, deviceNumber: 1 }, guards: 'one holder per fiscal device (`bridge_in_use`)' },
  { model: 'POSSession', key: { orgId: 1, clientKey: 1 }, guards: 'one till session per Idempotency-Key' },
  { model: 'POSTransaction', key: { orgId: 1, clientKey: 1 }, guards: 'one till sale per Idempotency-Key' },
  { model: 'POSTransaction', key: { orgId: 1, transactionNumber: 1 }, guards: 'one till sale per number' },
]

/** The same key spec, field for field and in order. */
export function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.entries(a)
  const kb = Object.entries(b)
  return ka.length === kb.length && ka.every(([k, v], i) => kb[i]?.[0] === k && Number(kb[i]?.[1]) === Number(v))
}
