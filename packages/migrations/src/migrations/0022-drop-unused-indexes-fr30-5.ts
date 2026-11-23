import type { Migration, MigrationContext } from '../types.js'

/**
 * FR-30.5 (#868): the indexes production does not use are dropped.
 *
 * Read on 2026-11-23 on production's primary with `scripts/index-usage.ts` (counters and sizes only). Most counters ran
 * from 2026-10-31T21:50Z, the member's start: 23 days, the 31 October month-end just outside them. 80 indexes had no
 * use and were not unique (about 32 MB). Each is either dropped here, with why nothing needs it, or kept in `KEPT`,
 * with why it stays. The schemas lose the dropped declarations in the same pull request, or the next start builds them
 * back. `0019-drop-unused-indexes` was released as the empty scaffold and is never edited, so the list is here.
 *
 * Drops by name and skips a collection or an index that is not there: a master never had some of these, and a second
 * run finds nothing. Idempotent. Collection-wide, like any index: `orgFilter` does not apply.
 *
 * Rollback: the previous release declares the indexes again, and its first start builds them back. Nothing is lost.
 */
export const UNUSED_INDEXES: Record<string, string[]> = {
  // The chart's tree is built in memory from the whole chart; nothing filters by the parent.
  accounts: ['orgId_1_parentId_1'],
  // The audit page has no operator filter (`queryAuditLogs`); the SUPTO export filters documents by operator, not this.
  auditlogs: ['orgId_1_operatorCode_1_timestamp_-1'],
  // `userId_1_type_1` has the same prefix.
  codes: ['userId_1'],
  // Read only inside the search's `$or`, whose other branches (phone, aliases, representative) no index serves, so the
  // planner reads the org instead. Exact lookups go through `orgId_1_email_1`, `orgId_1_taxId_1`, `orgId_1_vatNumber_1`.
  contacts: ['emailLower_1', 'taxIdLower_1', 'lastNameLower_1', 'vatNumberLower_1', 'firstNameLower_1'],
  // LIFO's read (the four fields equal, `receivedAt` descending) is the FIFO index read backwards.
  costlayers: ['orgId_1_productId_1_warehouseId_1_isExhausted_1_receivedAt_-1'],
  // No list of a desktop's codes: one is read by its id or its hash.
  desktopenrollmentcodes: ['orgId_1_createdAt_-1'],
  // The catalogue is read whole by the scripts and upserted by `din` (unique).
  din_catalog: ['baseNumber_1', 'categoryIndex_1'],
  // Every read names the org: `orgId_1_docDate_1_docType_1` serves them.
  docfiles: ['docDate_1'],
  // Nothing filters or sorts by the manager.
  employees: ['orgId_1_managerId_1'],
  // `GET /file`'s module filter has no caller.
  files: ['orgId_1_module_1'],
  // No filter by category; the register's sort ends in `_id`, which this index cannot give.
  fixedassets: ['orgId_1_category_1'],
  invoices: [
    // No lookup by УНП. The till journal's search is a case-insensitive pattern in an `$or` with `reference`, which no
    // index serves.
    'orgId_1_register.unp_1',
    // Its one read (a customer order's documents) is an `$or` with `lines.orderRef.internalOrderId`, which has no
    // index, so the planner cannot use this one.
    'orgId_1_internalOrderId_1',
  ],
  // The journals list filters by its search only.
  journals: ['orgId_1_type_1'],
  // A run is found by its id or its `periodCode`; the grid's period column sorts by `period`.
  payrollruns: ['orgId_1_period.from_-1'],
  // Frozen since FR-21: only migrations and the restore read it, by the org.
  postransactions: ['orgId_1_sessionId_1', 'orgId_1_type_1_createdAt_-1', 'orgId_1_unpNumber_1'],
  // Not under the org. The one exact read (`quick-product`) names the org, whose few categories `orgId_1` finds, and the
  // list's search `$or` has the unindexed description beside it.
  productcategories: ['nameLower_1'],
  products: [
    // No query by a slot's tags: a price is resolved on the article read by its id.
    'orgId_1_priceTiers.tags_1',
    // A search reads `searchLower` (FR-30.11); the five-field fallback's `$or` has the unindexed description beside it.
    'categoryLower_1',
  ],
  // The list filters by its search only; the path walk reads a parent by its id.
  stocklocations: ['orgId_1_barcode_1', 'orgId_1_parentId_1'],
  // The VAT flow reads by `kind` and `periodCode` (`tax_return_period_unique`); the list sorts by `createdAt`.
  taxreturns: ['orgId_1_type_1_period.from_-1'],
  // The list filters by its search only, and no payroll step reads a timesheet.
  timesheets: ['orgId_1_employeeId_1_date_-1'],
  // A handful per org, read through the org; no page sends a tag filter.
  warehouses: ['nameLower_1', 'codeLower_1', 'orgId_1_tags_1'],
}

/** Unused on production on 2026-11-23, and kept: the reason beside each. */
export const KEPT: Record<string, string> = {
  // TTL: the expiry deletes, which `$indexStats` does not count.
  'auth_tokens.expiresAt_1': 'TTL',
  'codes.validTo_1': 'TTL',
  'desktopassertions.expiresAt_1': 'TTL',
  'desktopenrollmentcodes.expiresAt_1': 'TTL',
  'idp_codes.expiresAt_1': 'TTL',
  'login_throttles.updatedAt_1': 'TTL',
  'node_assertions.expiresAt_1': 'TTL',
  'node_enrollment_codes.expiresAt_1': 'TTL',
  'node_presence.heartbeatAt_1': 'TTL',
  'node_traffic.lastAt_1': 'TTL (and its counter began 2026-11-20)',
  'oauthhandoffs.expiresAt_1': 'TTL',
  'oauthpendingregistrations.expiresAt_1': 'TTL',
  'onprem_credentials.removedAt_1': 'TTL',
  'relay_jobs.createdAt_1': 'TTL',
  'relay_receipts.at_1': 'TTL (and its counter began 2026-11-20)',

  // Counted for less than 7 days: built or rebuilt after 2026-11-16.
  'internalorders.orgId_1_draftNumber_1': 'counter since 2026-11-18: the top bar finds an order by its draft number (FR-31.22)',
  'invoices.orgId_1_draftNumber_1': 'counter since 2026-11-18: the top bar finds a document by its draft number (FR-31.22)',
  'invoices.orgId_1_direction_1_invoiceNumber_1': 'counter since 2026-11-17: the № column of Sales invoices and Bills (FR-30.2)',
  'orders.orgId_1_draftNumber_1': 'counter since 2026-11-18: the top bar finds an order by its draft number (FR-31.22)',
  'node_traffic.nodeId_1_day_1': "counter since 2026-11-20: a server's traffic per day",

  // Month-end and year-end work, none of which ran inside the window.
  'absenceentries.orgId_1_employeeId_1_from_1': "the payroll run reads a contract's absences in its month (`bg/run.service`)",
  'accounts.orgId_1_type_1': 'the profit and loss reads the revenue and expense accounts; the chart sorts by type',
  'archiveunits.orgId_1_createdAt_-1': "the year's archive list, newest first (`files-api` archive units)",
  'bankreconciliations.orgId_1_bankAccountId_1_statementDate_-1': "the month's bank reconciliation, per bank account",
  'journalentries.orgId_1_fiscalPeriodId_1': "the trial balance of a period or a year reads the periods' entries",
  'payslips.orgId_1_employeeId_1_period.from_-1': "the payroll run's year so far, per person",
  'products.orgId_1_categoryId_1': "the stock-levels report by product group, and a group's delete check (its articles)",

  // A query in the code reads it, on data global does not have yet, or on a master.
  'auditlogs.orgId_1_correlationId_1': "the audit page's related entries (`/audit-logs/correlation/:id`); nothing else serves them",
  'costlayers.orgId_1_productId_1_warehouseId_1_isExhausted_1_expiryDate_1': 'FEFO costing reads the layers by expiry',
  'desktopenrollmentkeys.orgId_1_createdAt_-1': "a desktop's pairing keys, newest first",
  'desktopenrollmentkeyuses.orgId_1_keyId_1_createdAt_-1': "a pairing key's uses, newest first",
  'emaillogs.outboxId_1': "a master's outbox marks its mail's log rows by outbox id",
  'employees.orgId_1_department_1': "the Employees list's Department sort",
  'employees.orgId_1_tags_1': "the Employees list's tag filter",
  'payrollruns.orgId_1_status_1': "the payroll runs list's Status sort",
  'identities.migration.runId_1': 'the rollback of an identity migration run',
  'internalorders.orgId_1_requestedDeliveryDate_1': "the Customer orders list's delivery date sort",
  'invoices.orgId_1_tags_1': "the documents lists' tag filter",
  'invoices.orgId_1_importedFrom.exportId_1': "a fenced import's documents, which its undo reads (FR-20.84)",
  'mirror_blobs.orgId_1_state_1': "the bytes a mirrored org's files hold (replication)",
  'org_moves.from_1_state_1': "a server's moves back to lgrai.app (`movesForNode`)",
  'org_moves.to_1_state_1': "a server's moves to it (`movesForNode`)",
  'outbox.state_1_nextAt_1': "a master's outbox finds its next due mail",
  'productsuppliers.orgId_1_supplierId_1': "the Products list's filter by supplier (FR-28)",
  'relay_jobs.nodeId_1_op_1_createdAt_1': "the documents relay's cap per server",
  'relay_receipts.nodeId_1_at_1': "the mail relay's hourly and daily caps per server",
  'repl_journal.coll_1_docId_1': "a master's capture finds a deleted document's journal row",
}

/** Each listed index that is on this database, as `<collection>.<name>`. */
async function present(db: MigrationContext['db']): Promise<string[]> {
  const out: string[] = []
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
  for (const [collection, names] of Object.entries(UNUSED_INDEXES)) {
    if (!collections.has(collection)) continue
    const have = new Set((await db.collection(collection).indexes()).map((i: { name?: string }) => i.name))
    for (const name of names) if (have.has(name)) out.push(`${collection}.${name}`)
  }
  return out
}

export const dropUnusedIndexesFr305: Migration = {
  id: '0022-drop-unused-indexes-fr30-5',
  description: 'Drop the indexes production did not use in 23 days, keeping TTL, month-end and master ones (FR-30.5)',
  async up({ db, log }) {
    for (const key of await present(db)) {
      const dot = key.indexOf('.')
      const collection = key.slice(0, dot)
      const name = key.slice(dot + 1)
      await db.collection(collection).dropIndex(name)
      log(`${collection}: the unused index ${name} dropped`)
    }
  },
  async preview({ db }) {
    return (await present(db)).map(key => `would drop ${key}`)
  },
}
