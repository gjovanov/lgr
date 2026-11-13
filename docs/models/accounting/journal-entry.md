# JournalEntry

## Entity Interface

```typescript
export interface IJournalEntryLine {
  accountId: Types.ObjectId
  description?: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
  baseDebit: number
  baseCredit: number
  contactId?: Types.ObjectId
  projectId?: Types.ObjectId
  costCenterId?: string
  tags?: string[]
  opNo?: number
  side?: string         // 'debit' | 'credit'
  analyticId?: Types.ObjectId
  quantity?: number
  unit?: string
  settles?: { docType: string; docNumber: string }[]
  branchOrgId?: Types.ObjectId
  fx?: { currency: string; rate?: number; amount?: number }
  journalCode?: string
  taxCode?: string
}

export interface IJournalEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  entryNumber: string
  date: Date
  fiscalPeriodId: Types.ObjectId
  description: string
  reference?: string
  type: string          // 'standard' | 'adjusting' | 'closing' | 'reversing' | 'opening'
  status: string        // 'draft' | 'posted' | 'voided'
  lines: IJournalEntryLine[]
  totalDebit: number
  totalCredit: number
  attachments: Types.ObjectId[]
  sourceModule?: string
  sourceId?: Types.ObjectId
  createdBy: Types.ObjectId
  postedBy?: Types.ObjectId
  postedAt?: Date
  ledger?: string       // 'books' | 'shadow'. Unset is books, and no statement reads shadow
  docType?: string
  docNumber?: string
  docDate?: Date
  vatKind?: string
  docTotal?: number
  docVat?: number
  docCurrency?: string
  partnerAnalyticId?: Types.ObjectId
  branchOrgId?: Types.ObjectId
  sourceOrgId?: Types.ObjectId
  // FR-25a: the rest of the accountant's document header
  paymentCode?: string        // '1' cash, '2' bank (registry.ts#PAYMENT_CODES)
  paidAmount?: number
  paidCash?: number
  taxEventDate?: Date
  vatRate?: number
  vatRule?: string
  vatExemptionReason?: string
  registerDocType?: string    // the NRA register's document type, as booked
  protocolType?: string
  reasonRef?: string
  customsRef?: string
  bankOperation?: string
  reportingMonth?: string     // YYYYMM, as booked
  links?: { docType: string; docNumber: string; date?: Date; amount?: number; amountFx?: number }[]
  docOptions?: Record<string, string>
  source?: { createdBy?: string; createdAt?: Date; modifiedBy?: string; modifiedAt?: Date; version?: string }
  importBatchId?: Types.ObjectId
  importKey?: string
  importHash?: string
  createdAt: Date
  updatedAt: Date
}
```

The fields after `postedAt`, and on a line those after `tags`, are FR-25 §3.4's: an imported company's books. One operation is two lines with one `opNo`, and a correction is a negative amount on its `side`.

### The document header (FR-25a)

What the accountant's journal record says of a document beyond its type, number, total and comment. Each is set only when
the file states it, none has a default, and an entry from before (or from a client that sends none) has none of them. The
books import writes them (`import.service.ts#headerFieldsOf`); no other route does yet. What each one means was read off the
accountant's whole journal, not guessed: [FR-25a §1–2](../../fr/FR-25a-books-schema-reconciliation.md).

| Field | Type | Description |
|-------|------|-------------|
| paymentCode | string | `ПЛАЩАНЕ`, as booked: `1` paid in cash on the document itself, `2` paid by bank. Bank and VAT documents have none |
| paidAmount | number | `ПЛАТЕНО`: what the document has been paid by so far, in cash on itself or by the bank documents linked to it |
| paidCash | number | The cash part of `paidAmount` |
| taxEventDate | Date | A VAT protocol's tax-event date |
| vatRate | number | The document's VAT rate, in percent |
| vatRule | string | The VAT treatment in words (`vatKind` is its code) |
| vatExemptionReason | string | `ОНС`: the legal ground an invoice without VAT prints |
| registerDocType | string | `ВИДДОК`, as booked: `1` invoice, `2` debit notice, `3` credit notice, `07` customs, `09` protocol, `81` till report. `Invoice.vatDocTypeCode` and `VatRegisterEntry.docTypeCode` hold the same code with two digits |
| protocolType | string | `p117`, `pLN` |
| reasonRef | string | `ОСНИЗВ`: what a credit or debit notice corrects |
| customsRef | string | `НОММД`: the customs declaration's reference |
| bankOperation | string | A bank document's operation, by the program's name for it |
| reportingMonth | string | `МЕСЕЦ`, `YYYYMM` as booked: a later VAT return a purchase document is declared in (`VatRegisterEntry.period`), a payroll posting's month |
| links | array | The documents this one is tied to: type, number, date, and what the link settles (`amount`, and `amountFx` in the document's currency). A linked document is found by type, number and this entry's partner |
| docOptions | object | The document's switches as the file sets them: only those set, and not to `false`, under keys that are identifiers |
| source | object | Who keyed it in the accountant's program and when (its local clock, read as the instant it was), and the program's version stamp |

`partnerAnalyticId` prefers the header's partner (`ПАРТНЬОР`) where the operations name none or several, when it is a
customer, a supplier or a partner; where they name exactly one, that one stays (it is also part of `importKey`).

⚠ The content hash (`importHash`) covers the header, appended only when a document has one: a client from before FR-25a
sends none, and its documents hash exactly as before.

## Field Reference

### JournalEntry fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| entryNumber | string | Yes | Auto-generated | Unique entry number (format: `JE-YYYY-NNNNN`). Auto-generated if not provided on create. |
| date | Date | Yes | - | Transaction date |
| fiscalPeriodId | ObjectId | Yes | Auto-resolved | Fiscal period. Auto-resolved from `date` if not provided (creates FY + periods as needed). |
| description | string | Yes | - | Entry description/memo |
| reference | string | No | - | External reference number |
| type | string | Yes | `standard` | Entry type: `standard`, `adjusting`, `closing`, `reversing`, `opening` |
| status | string | Yes | `draft` | Lifecycle: `draft` (editable), `posted` (finalized, updates balances), `voided` (reversed) |
| lines | IJournalEntryLine[] | Yes | - | Debit/credit line items (see below) |
| totalDebit | number | Yes | `0` | Sum of all line debits. Auto-computed from lines if not provided. |
| totalCredit | number | Yes | `0` | Sum of all line credits. Must equal totalDebit (tolerance: 0.01). |
| attachments | ObjectId[] | No | `[]` | References to File documents |
| sourceModule | string | No | - | Originating module (e.g., `invoicing`) for cross-module entries |
| sourceId | ObjectId | No | - | ID of the originating document |
| createdBy | ObjectId | Yes | - | User who created the entry (auto-set from JWT) |
| postedBy | ObjectId | No | - | User who posted the entry |
| postedAt | Date | No | - | Timestamp when the entry was posted |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

### JournalEntryLine fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| accountId | ObjectId | Yes | - | Target account for this line |
| description | string | No | - | Line-level description |
| debit | number | No | `0` | Debit amount in transaction currency |
| credit | number | No | `0` | Credit amount in transaction currency |
| currency | string | No | `EUR` | Transaction currency code |
| exchangeRate | number | Yes | `1` | Exchange rate to base currency |
| baseDebit | number | Yes | `0` | Debit amount in base currency |
| baseCredit | number | Yes | `0` | Credit amount in base currency |
| contactId | ObjectId | No | - | Associated contact (customer/vendor) |
| projectId | ObjectId | No | - | Associated construction project |
| costCenterId | string | No | - | Cost center identifier |
| tags | string[] | No | `[]` | Line-level tags |

## Relationships

- **Belongs to**: `fiscalPeriodId` -> `FiscalPeriod`
- **References**: `createdBy` -> `User`, `postedBy` -> `User`, `attachments[]` -> `File`
- **Line references**: `accountId` -> `Account`, `contactId` -> `Contact`, `projectId` -> `ConstructionProject`
- **Referenced by**: `FiscalYear.closingEntryId`, `FixedAssetDepreciation.journalEntryId`, `BankReconciliationItem.journalEntryId`

## Indexes

- `(orgId, entryNumber)` -- unique
- `(orgId, date)` -- descending
- `(orgId, status)`
- `(orgId, lines.accountId, date)` -- descending (MongoDB embedded)
- `(orgId, fiscalPeriodId)`

## API Endpoints (prefix: `/api/org/:orgId/accounting/journal`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List journal entries (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`, `fiscalPeriodId`, `startDate`, `endDate`. |
| POST | `/` | Yes | Create journal entry. Auto-generates `entryNumber` and resolves `fiscalPeriodId` from date if not provided. Validates debit = credit. Always created as `draft`. |
| GET | `/:id` | Yes | Get single entry with enriched line data (account code + name per line). |
| PUT | `/:id` | Yes | Update entry. Only draft entries can be edited. |
| DELETE | `/:id` | Yes | Delete entry. Only draft entries can be deleted. |
| POST | `/:id/post` | Yes | Post a draft entry. Sets status to `posted`, records `postedBy`/`postedAt`, and updates account balances. |
| POST | `/:id/void` | Yes | Void a posted entry. Reverses account balance changes and sets status to `voided`. |
