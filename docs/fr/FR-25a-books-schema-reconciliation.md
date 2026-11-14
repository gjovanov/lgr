# FR-25a — The books' schema against the accountant's database: the register, and the CRUD plan

Status: schema and import shipped (this PR); UI planned here, not built. Parent: [FR-25](FR-25-books-payroll-and-bg-filings.md) (§3.4, §5).

## 0. What this is

FR-25 imports a legal entity's books from the accountant's PlusMinus database exactly as booked. The import took what the
journal export prints: date, type, number, accounts, analytics, amounts, quantities, currency, comment. The database holds
more, on every document and on many analytics, and our collections had no place for it.

The request was: where the accountant's data carries a property our collections lack, and it is relevant, add it to the
collection schema, and plan the forms, controls and grids that create, read, update and delete it.

This document is the record of that comparison:

- §1 how each property's meaning was established, not guessed;
- §2 the register: every property of the source against ours, with the decision and why it matters;
- §3 the UI CRUD plan, entity by entity (planned only);
- §4 what is deferred, with a design sketch for the large items;
- §5 operations: what a deploy changes, and the one backfill.

Everything here is additive: each new field is optional, has no default, and no existing document needs a write.

## 1. How it was checked

A read-only audit of the newest nightly archive (FR-25 §4), opened in memory on the PC that holds it. It printed names,
counts, value **shapes** (digits, letters and punctuation masked) and the raw values of small code sets only; no name,
number or amount left that PC. The meaning of each field was then settled by **cross-tabulation** against what the
document's own operations do, rather than by its name:

| Question | How it was answered | Result |
|---|---|---|
| What are the payment codes `1` and `2`? | Per document: the code against whether its operations touch the cash accounts (`50x` cash) or the bank accounts, against `paidCash`, and against the sum of what the bank documents linked to it pay | `1` = paid in cash on the document itself (all but a handful touch the cash account, and on a sale `paidCash` is what was paid); `2` = paid by bank (none touches cash or bank itself, and all but a few have a paid amount equal to what their bank links pay). Proven |
| What do `links` hold? | Key names of the JSON; each link resolved against the archive's own documents; its value against the linked document's total | `{ doc, docNumber, date?, partner, type, param, value }`; every link resolves; `param` is `paid` (or `paid|paidCurrency`) and `value` is what the payment settles; `partner` is the linking document's own partner. Proven |
| Which `options` switches are ever set? | Per key: present, set, and not `false` | About 35 per kind of document, about a hundred names across kinds, about thirty ever set: some on every document (the default accounts, the payment type, in the sales or purchase journal), some on a few (export invoice, mixed deal, self-invoicing, compensation, advances). Read |
| What is `ДАТА1` ("never later than the record date")? | Where it differs from the record date: by document type, by register code, against the date inside `ОСНИЗВ` and against the date of the linked document | It differs only on credit and debit notices, and there it is the date of the invoice the notice corrects (equal to the date in `ОСНИЗВ` every time, and to the corrected document's own date wherever a link says which). On an invoice it is the invoice's own date. Proven; not stored (see §2) |
| Is `taxEventDate` another date than the document's? | Parsed as `DD.MM.YYYY` and compared with the record date | Only on VAT protocols, and equal to the record date on every one. An earlier reading said "always different": it compared `DD.MM.YYYY` with `YYYYMMDD` text. Proven |
| What are `createdOn` / `modifiedOn`? | The digits after the colon tested as a time of day and as an epoch | `YYYYMMDD:HHMMSS`, newer records with nine more digits of the second: the accountant's wall clock, not an epoch. Proven |
| `МЕСЕЦ`? | Against the record month, by document type | On purchase invoices declared in a later VAT return (up to a year later, never earlier), and on payroll postings. Proven |
| The header's partner (`ПАРТНЬОР`)? | Against the one partner the operations name, by root | The same as the operations' in almost every document; it adds a partner where the operations name none (VAT protocols); a bank document's header names the customer or supplier, or the bank account itself, which is no partner. Proven |
| `bankAccount` on a bank document? | Against the analytic of the document's bank-account operation | The same in all but a handful. Proven: not stored |
| `ДДС` (document VAT)? | Against the VAT the operations carry (output VAT credited, input VAT debited) | Equal on all but one document: `docVat` already holds it. Proven |
| `placeOfIssue`? | Distinct values, by number series | One value across every document of every store: the company's, not a document's. Proven |
| `ВИДДОК`? | Against the document type | `1` invoice, `2` debit notice, `3` credit notice, `07` customs declaration, `09`/`9` protocol, `81` the till's report row. It is the only thing that tells a credit notice from an invoice of the same type. Proven |
| The fixed-asset (`ДА`) parameters? | Codes printed; value shapes; the account codes looked up in the chart; rate × term | `МЕТОД` is one value (linear); `КАТ` is the tax category `1`–`7`; `ДАННОРМА` × `ДАНСРОК` ≈ 100 on every asset, so the tax term is in **years** (often fractional, 100 / rate), and likewise the book rate × term; `СМЕТКА`, `ДЕБИТ`, `КРЕДИТ` are all accounts of the chart; dates are `DD.MM.YYYY`. Proven |
| An account's `НАСТРОЙКИ` (a few accounts)? | Child names and code values | Analytics, currency and quantity all off (our defaults); a kind code `1`/`2`. Read |

## 2. The discrepancy register

Decision: **added** (a new field), **mapped** (an existing field already holds it), **params** (kept as the analytic's own
properties, below), **deferred** (§4), **not stored** (redundant, or no known meaning).

### 2.1 The journal's document header → `JournalEntry`

| The accountant's journal record field | Our property | Decision | Why it is relevant |
|---|---|---|---|
| `ПЛАЩАНЕ` (and its twin `ВИДПЛА`) | `paymentCode`; `registry.ts#PAYMENT_CODES` = `{ 1: cash, 2: bank }` | added | Which documents were cash sales: the cash book, the till reconciliation, the Н-18 cash rules |
| `ПЛАТЕНО` | `paidAmount` | added | What is still owed per document: receivables, aging, dunning |
| `paidCash` | `paidCash` | added | The cash part of a split payment |
| `ПЛАТЕНОВ` | — | deferred | The paid amount in the document's currency; rare, and the operations carry their own currency amounts |
| `taxEventDate` | `taxEventDate` | added | The legal tax-event date of a VAT protocol |
| `ДАТА1` | — | not stored | The date of the invoice a notice corrects: `reasonRef` and `links` carry it; on an invoice it is its own date |
| `docDate` | `docDate` | mapped | Equal to the record date |
| `ДДС` | `docVat` | mapped | Equal to the VAT of the operations |
| `vatRate` / `VATPER` | `vatRate` | added | The document's VAT rate (20, 9, 0) |
| `vatRules` | `vatRule` | added | The VAT treatment in words (intra-community acquisition, reverse charge); `vatKind` is its code |
| `ОНС` | `vatExemptionReason` | added | The legal ground an invoice without VAT must print |
| `ВИДДОК` | `registerDocType` (as booked) | added | The NRA register's document type; the only way to tell a credit notice from an invoice. `Invoice.vatDocTypeCode` and `VatRegisterEntry.docTypeCode` hold the same code with two digits |
| `protocolType` | `protocolType` | added | Which VAT protocol (`p117`, `pLN`) |
| `ОСНИЗВ` | `reasonRef` | added | What a credit or debit notice corrects, which the notice must state |
| `НОММД` | `customsRef` | added | The customs declaration's reference |
| `operation` (bank documents) | `bankOperation` | added | The bank operation's kind: filters and reconciliation |
| `bankAccount` | — | mapped | The analytic of the document's bank-account line |
| `ПАРТНЬОР` | `partnerAnalyticId`, preferred where the operations name none or several | mapped | The counterparty of a VAT protocol, and of a document whose lines name several |
| `МЕСЕЦ` | `reportingMonth` (`YYYYMM` as booked) | added | The VAT return a late purchase invoice is declared in (`Invoice.vatPeriod`, `VatRegisterEntry.period`), a payroll posting's month |
| `links` | `links: { docType, docNumber, date?, amount?, amountFx? }[]` | added | Which bank document paid which invoice and how much of it; which invoice a notice corrects. The link's partner is the document's own, so it is not kept: a linked document is found by type, number and this entry's partner (a number is unique only per partner, FR-25 §11) |
| `options` | `docOptions` (set switches only, keys that are identifiers) | added | Export invoice, mixed deal, self-invoicing, uncollectible receivable, compensation, in the sales or purchase journal… |
| `createdOn`, `createdBy`, `modifiedOn`, `modifiedBy`, `version` | `source: { createdBy, createdAt, modifiedBy, modifiedAt, version }` | added | Who keyed the document in the accountant's program and when: audit, and "what changed since" |
| `АВТОР` | — | not stored | Always equal to `createdBy` |
| `updatedOn` | — | deferred | Its meaning beside `modifiedOn` is not known |
| `placeOfIssue` | `Org.placeOfIssue` | added on Org | One value for every document: the company's |
| `ТО`, `discountType`, `discountSum` | `docOptions.discount` (the percent) | params / deferred | A trade discount; the percent is the `discount` switch, the amount is deferred |
| `compensationSum` | — | deferred | A compensation's amount; the `compensation` switch is kept |
| `АВАНСД`, `АВАНСК`, `НП` | — | deferred | Advance deductions, on few documents |
| `documentList` | — | deferred | A VAT protocol's base documents, as text; their structured form belongs in `links` |
| `ДДСДК`, `СУМАДК`, `СУМАБДК`, `vat20`, `vat9`, `ДАНОСН`, `ДАНОСН9`, … | — | deferred | Per-rate bases of notices and protocols: the VAT register (`VatRegisterEntry.cells`) carries them from the filed VAT files |
| `ПОКУП`, `ПРОД` | — | deferred | Journal-inclusion flags of protocols; the `includedInThe…Journal` switches are kept |
| `docData` | — | deferred | A customs declaration's details (duties, excise, statistical value) |
| `ДП` | — | not stored | A tab-separated list of names whose purpose is not known |
| header `ВАЛУТА`, `КУРС`, `СУМАВАЛ`, `ДАНЪК`, `НОМЕР` | — | mapped | The operations carry them (`ImportOperation.cur/rate/fx/tax/journal`) |
| operation `ТИП` (`АМ`) | — | deferred | Marks depreciation operations: with the fixed-asset import (§4.2) |
| `СКЛОПЕР` | — | deferred | The document's goods lines, millions of records (§4.1) |

### 2.2 Analytics → `AccountingAnalytic.params`, `Contact`, `FixedAsset`

`AccountingAnalytic.params?: { key, value }[]` keeps every property the file lists for an analytic, in the file's order and
spelling, empty values included: a list of pairs, not a map, because some names carry dots. Never for the employees' root,
whose file is refused before anything reads it. What LGR also maps to its own fields:

| Source | Our property | Decision | Why |
|---|---|---|---|
| Customers / suppliers: `БУЛСТАТ`, `ИНДДС`, `АДРЕС`, `ГРАД`, `ТЕЛЕФОН` | `Contact.taxId/taxNumber`, `vatNumber`, `addresses[0]`, `phone` | mapped (as before) + params | |
| `МОЛ` | `Contact.representative` (was a notes line `МОЛ: <name>`) | added | The person legally responsible, printed on a Bulgarian invoice |
| Goods / materials / production: `МЯРКА`, `ЦЕНА`, `СР.ЦЕНА`, `КОЛИЧЕСТВО`, `ТАРКОД` | `unit` (as before) + params | params | The accountant's prices and quantities; the stores' own product prices stay LGR's |
| Bank accounts: `БАНКА` | `BankAccount.bankName` (as before) + params | params | |
| Fixed assets (about 35 parameters) | `FixedAsset.taxCategory`, `inServiceDate`, `taxDepreciationRate`, `taxValue`, `taxUsefulLifeMonths`, `params` | added (schema); the import is deferred (§4.2) | The tax depreciation schedule (ЗКПО) runs beside the book one |
| An account's `НАСТРОЙКИ` | — | not stored | All off but a kind code; `balanceSide` stays derived from the code |
| An account's `ВАЛУТИ` | — | deferred | Per-currency balances of foreign-currency accounts |

### 2.3 The company → `Org`

| Source (company parameters) | Our property | Decision | Why |
|---|---|---|---|
| `МОЛ`, `Управител` | `Org.representative` | added | Printed on every document the company issues |
| `Място на сделката` | `Org.placeOfIssue` | added | The place of issue every document prints (`Invoice.placeOfTransaction` per document) |
| `NKIDTZPB` | `Org.activityCode` | added | The economic activity code: statistics and the annual filings |
| `Булстат`, `ИНДДС`, `EMail`, `Телефон`, `Адрес`, `Град`, `ПощКод`, `Б.код`, `Б.сметка` | `taxNumber`, `vatNumber`, `email`, `phone`, `addresses[]`, `bankDetails[]` | mapped | |
| `Рег.ДДС`, `ПНОИД`, `Клон` | — | deferred | VAT registration data, the NRA office, the branch code |

### 2.4 The stores' documents (from the store program's API)

The store importers (`doc-import/map-plusminus-*.ts`) are not changed here. What their documents carry and our models do not:

| Store document field | Our model | Proposal |
|---|---|---|
| invoice `paid`, `paidCash`, `paidCard` | `Invoice.amountPaid`, `payments[]` | Map to `payments[]` by method when the importer next changes |
| invoice `options{…}` | — | The same `docOptions` rule as the journal, on `Invoice` |
| invoice `unp` | `Invoice` has none; the till's `unp` is on the cash sale | An optional `Invoice.unp` for an invoice issued from a till sale |
| invoice `bank`, `bic`, `iban` | `Org.bankDetails` | Already the issuer's: nothing per document |
| invoice `placeOfIssue` | `Invoice.placeOfTransaction` | Mapped (through the printed text) |
| invoice `cashOperations` | — | The cash settlement rows: a cash order (`CashOrder`) per row, deferred |
| line `debit`, `credit` (account codes), `averagePrice`, `apType`, `taxCode`, `fromDocument`, `unitPriceWithVat` | `IInvoiceLine` has `accountId`, `analyticId`; no cost at sale | `costAtSale` on a line and the accounts by code: with the posting worker (FR-25 R3–R6) |
| receipt `price1`…`price8`, `retailPrice`, `wholesalePrice` | `Product.priceTiers[]` | Mapped by the receipt importer |

## 3. The UI CRUD plan (planned, not built)

Shared rules for every entity below:

- **Imported is books-as-booked.** An entry, analytic or account the books import wrote (`sourceModule: 'plusminus'`,
  `ledger: 'books'`, or a books org's chart) is read-only for everyone: its fields render disabled with a lock and the
  hint "as booked in the accountant's program". The next import would overwrite an edit, and a book the accountant filed
  must not differ from ours. LGR-native records stay editable as today.
- **Permissions**: reading needs `accounting.read` (contacts: `invoicing.read`); creating and editing `accounting.write`
  (contacts: `invoicing.write`); posting `accounting.post`; the company identity `org-settings.edit`. Nothing here adds a
  permission.
- **Audit**: every save goes through the existing controllers, which write `AuditLog` with `diffChanges`; no new audit path.
- **Grids** use `ListScaffold` (per-user columns, `useGridColumns`), server-side paging and sorting, and the existing
  export (Excel / PDF through the list export).
- **i18n**: every new label in en, bg, de and mk; the blocks are named below, all under the existing `accounting.*`,
  `invoicing.*` and `settings.*` trees. A missing key renders literally, so the four files ship together.

### 3.1 Chart of accounts — `Account`

Built: the form's read-only Books section and, in a books org, the whole form read-only; the grid's two columns on
the cog and, in a books org only (they mean nothing elsewhere), the two filters (`hasAnalytics`, `quantitative` on
`GET accounting/account`). The server says the same as the form: a books org's account is refused create, change
and delete with 422 `books_as_booked`.

- Route / view: `/accounting/accounts` (`AccountsView.vue`, exists), `/accounts/:id/edit` (`AccountFormView.vue`, exists).
- Form: add a read-only "Books" section: `balanceSide` (chip: debit / credit / both), `analyticRoots` (chips), `quantitative`
  (switch, disabled). In a books org the whole form is read-only.
- Grid: add columns `balanceSide`, `quantitative` (hidden by default); filter "has analytics", "quantitative".
- i18n: `accounting.accountBooks.*`.
- e2e later: a books org's account opens read-only; an LGR-native account saves.

### 3.2 Analytics — `AccountingAnalytic` (new views)

Built, as below. The API is `accounting/analytics` (`analytic.controller.ts`, `accounting-books/analytics.service.ts`):
the list (the tree's order: a node right before what is under it, whatever its siblings are called), `/roots` with
counts, `/:id` with the properties and the ancestors, `PUT /:id` (links, properties, `isActive`) and `DELETE /:id`
(deactivate) for an analytic of LGR's own, 422 `books_as_booked` for a books org's, `/export` (Excel). Reading needs
the chart's capability (`accounts.view`/`lookup`), a change `accounts.edit`. Nothing creates an analytic: the
import does.

- Route / views: `/accounting/analytics` (`AnalyticsView.vue`, new: a tree grid by root), `/accounting/analytics/:id`
  (`AnalyticFormView.vue`, new).
- Grid: columns `path` (indented by depth), `kind`, `unit`, linked contact / bank account / fixed asset (links that open
  them), `isActive`; default sort `root`, then `path`; filters: root (the registry's roots, `reports.accountingBooks.roots.*`
  labels), kind, "has a contact", search on `nameLower`. Export: Excel.
- Form: header (path, root, kind, read-only); links (contact autocomplete, bank account, fixed asset); **Properties**: a
  two-column table of `params` (`key`, `value`) in file order, read-only for an imported analytic; a free-text row editor
  for an LGR-native one (key required, unique within the analytic).
- Actions: deactivate (soft, `isActive: false`) for an LGR-native analytic only; no delete of an analytic a line points at.
- i18n: `accounting.analytics.*` (title, columns, kinds, properties).
- e2e later: the tree opens a root and lists its items; an imported analytic's properties are shown read-only; linking a
  contact to an LGR-native analytic saves.

### 3.3 Bank accounts — `BankAccount`

Built: the form's read-only analytic link and the grid's column on the cog
(`GET accounting/analytics/bank-operations?month=YYYY-MM`, read only while the column is shown). The form's fields
stay editable in a books org too: the import only makes a bank account, never rewrites one, and the store orgs'
payment orders use them. ⚠ The key is `accounting.bankAccountBooks.*`: `accounting.bankAccount` is a string.

- Route / views: `/accounting/bank-accounts` and `/bank-accounts/:id/edit` (exist).
- Form: unchanged fields; add a read-only "Analytic" link (the `БАНКОВИ СМЕТКИ:<iban>` analytic that points here).
- Grid: add "bank operations this month" (count of entries with `bankOperation`) as an optional column.
- i18n: `accounting.bankAccount.analytic`.
- e2e later: the analytic link opens the analytic.

### 3.4 Fixed assets — `FixedAsset` and its schedule

- Route / views: `/accounting/fixed-assets` (`FixedAssetsView.vue`), `/fixed-assets/:id/edit` (`FixedAssetFormView.vue`);
  both exist.
- Form sections:
  - **Book** (exists): code, name, category, accounts, purchase date and price, useful life, method, status.
  - **Tax (ЗКПО)** (new): `taxCategory` (select I–VII, stored `1`–`7`), `taxDepreciationRate` (number, %, 0–100, defaulted
    from the category's statutory rate but editable), `taxUsefulLifeMonths` (number, months; shown also in years),
    `taxValue` (money ≥ 0, default the purchase price), `inServiceDate` (date, not before the purchase date).
  - **Properties** (new, read-only): the imported asset's `params` table.
  - **Schedule** (exists as data): a grid of `depreciationSchedule` (date, amount, accumulated, book value, the posted
    entry as a link), with a second, tax schedule computed client-side from the tax fields (not stored until §4.2).
- Grid: add `taxCategory`, `taxDepreciationRate`, `inServiceDate` (hidden by default); filter by tax category.
- Validation: rate × years ≈ 100 hint when they disagree (the source always agrees).
- i18n: `accounting.fixedAsset.tax.*`, `accounting.fixedAsset.properties`, `accounting.fixedAsset.schedule.*`.
- e2e later: an asset saves its tax side; the tax schedule shows a row per year.

### 3.5 Contacts — `Contact.representative`

Built: the form's field, beside the tax and VAT numbers, trimmed on save (`contact-payload.ts`), and the grid's optional
column, hidden by default. Still planned: the invoice print, "move to the field", the search, the 200 bound.

- Route / view: `/invoicing/contacts/:id/edit` (`ContactFormView.vue`, exists); list `ContactsView.vue` (exists).
- Form: a `representative` text field ("МОЛ / Representative") beside the company name, max 200, trimmed; shown on the
  invoice print where Bulgarian invoices print the recipient's МОЛ. Until the backfill (§5) runs, a contact may still keep
  it as a notes line `МОЛ: <name>`: the form offers "move to the field" on such a contact.
- Grid: an optional `representative` column, hidden by default; included in search.
- i18n: `invoicing.representative` (built), `invoicing.moveRepresentative`. Not under `invoicing.contact.*`: that key is
  a string ("Contact"), and a key cannot be a string and a block at once.
- e2e later: typing a representative saves and reprints on the invoice; the move action empties the notes line.

### 3.6 Journal entries — the document header

- Route / views: `/accounting/journal-entries` (`JournalEntriesView.vue`), `/journal-entries/:id/edit`
  (`JournalEntryFormView.vue`); both exist.
- Form: a **Document** card above the lines, read-only for an imported entry (always, see the shared rules), editable on a
  draft LGR-native one:
  - type and number, document date, `registerDocType` (select: invoice, debit notice, credit notice, customs, protocol,
    till report), `reasonRef` (text, required when the type is a notice);
  - **Payment**: `paymentCode` (select: cash / bank, from `PAYMENT_CODES`), `paidAmount`, `paidCash` (money,
    `paidCash ≤ paidAmount`);
  - **VAT**: `vatKind`, `vatRate` (select 20 / 9 / 0), `vatRule`, `vatExemptionReason` (required when the rate is 0 on a
    sales invoice), `taxEventDate`, `reportingMonth` (month picker, stored `YYYYMM`), `protocolType`, `customsRef`;
  - **Links**: a small grid (type, number, date, amount) whose rows open the linked entry (found by type, number and this
    entry's partner);
  - **Switches**: `docOptions` as chips (read-only);
  - **Source**: "keyed by … on …, changed by … on …" from `source` (read-only, imported only).
- Grid: optional columns `paymentCode`, `paidAmount`, open amount (`docTotal − paidAmount`), `registerDocType`,
  `reportingMonth`; filters: payment (cash / bank), unpaid (`paidAmount < docTotal`), notices only (`registerDocType` 2/3),
  declared in another month (`reportingMonth` set).
- Server: the journal routes (`journal.controller.ts`) name none of the FR-25 header fields today, so nothing a client
  sends is dropped; this step adds the header to their body schemas, refused (422) on an imported entry.
- i18n: `accounting.journalEntry.document.*`, `accounting.journalEntry.payment.*`, `accounting.journalEntry.vat.*`,
  `accounting.journalEntry.links.*`, `accounting.paymentCodes.*`.
- e2e later: an imported entry shows its header and refuses edits; the unpaid filter lists a part-paid invoice; a link
  opens its document.

### 3.7 The company — `Org`

- Route / view: Settings → Organization (`portal-ui/src/views/settings/OrganizationView.vue`, exists), "Company Identity" card.
- Form: add `representative` (text), `placeOfIssue` (text, a town), `activityCode` (text, digits and dots) next to the tax
  and VAT numbers. The API already takes them (`PUT /org/:orgId`) and `/auth/me` returns them.
- Print: invoice and companion forms print `placeOfIssue` where they print the place of transaction, and the issuer's
  `representative` under its name.
- i18n: `settings.representative`, `settings.placeOfIssue`, `settings.activityCode`.
- e2e later: the three save and survive a reload; a new invoice prints them.

### 3.8 The VAT register — `VatRegisterEntry`

- Route / views: `/accounting/tax-returns/:period` (`VatReturnView.vue`, exists: the register rows of a period).
- Grid: add a "journal entry" link per row, found by `docTypeCode` (two digits) = `registerDocType` (padded) and number;
  a filter "declared in another month" from the entry's `reportingMonth`.
- No edits: filed rows are frozen (`frozen`).
- i18n: `accounting.vatRegister.entry`, `accounting.vatRegister.otherMonth`.
- e2e later: a row opens its journal entry.

## 4. Deferred

### 4.1 A document's goods lines (`СКЛОПЕР`)

Every document carries its goods lines below the header, millions of records over the archive's years. They are the
stores' documents seen by the accountant: the stores' own documents in LGR already hold the lines. A sketch for when a
comparison needs them: a collection `BooksDocumentLine { orgId, entryId, lineNo, analyticId, quantity, unit, price,
amount, vatRate }`, written by the books import beside each entry it writes (the same `importKey`), indexed on
`{orgId, entryId}` and `{orgId, analyticId, date}`, never embedded in the entry (an entry stays small), and read only by
aggregations. Its first use would be the per-article reconciliation of a store's sales with the books.

### 4.2 The fixed assets from the books

The schema is in place (§2.2); the import is not. When it is built, each `ДА:<name>` analytic becomes (or links to) a
`FixedAsset`, by this mapping, which the audit verified:

| Parameter | Field | How |
|---|---|---|
| `СМЕТКА` | `accountId` | The account of that code (every value is in the chart) |
| `ДЕБИТ` | `depreciationAccountId` | The account of that code |
| `КРЕДИТ` | `accumulatedDepAccountId` | The account of that code |
| `МЕТОД` | `depreciationMethod` | The one value seen, linear → `straight_line` |
| `ДАТА` | `purchaseDate` | `DD.MM.YYYY` |
| `СТОЙНОСТ` / `ОБЩАСТОЙНОСТ` | `purchasePrice` | The value, and the value with later additions |
| `ПРОЦЕНТ`, `СРОК` | `usefulLifeMonths` | `СРОК` is in years: `round(СРОК × 12)`; rate × term ≈ 100 |
| `НАЧ.АМ.` | the schedule's opening | Book depreciation accumulated before the books start |
| `КАТ` | `taxCategory` | `1`–`7` |
| `ДАТАЕКСП` | `inServiceDate` | `DD.MM.YYYY` |
| `ДАННОРМА` | `taxDepreciationRate` | Percent |
| `ДАНСРОК` | `taxUsefulLifeMonths` | Years: `round(ДАНСРОК × 12)` |
| `ДАНСТОЙН` | `taxValue` | |
| `ОБЩДАНАМ`, `НАЧДАНАМ`, `ПЕРДАНАМ` | the tax schedule | Accumulated tax depreciation, its opening, the year it ran to |
| `ОТПДАТА`, `ОТПДАП` | `disposalDate` | Book and tax write-off dates |
| `НАЧИСЛ` | `status` | `НЕ`: not depreciated |
| everything | `params` | As the file lists them |

The operations marked `АМ` (the monthly depreciation) then link each schedule row to its posted entry.

### 4.3 The rest

`ПЛАТЕНОВ`, `updatedOn`, `discountSum`, `compensationSum`, the advance fields, `documentList`, the per-rate bases, `ПОКУП` /
`ПРОД`, `docData`, the accounts' currency balances, and the company's VAT registration data: each is listed in §2 with what
holds it today. None is needed by a report or a form yet.

## 5. Operations

- **The importer, old and new.** A client from before this sends no header (`props`) and no analytic `params`: the server
  answers it exactly as before, and its documents hash exactly as before (`journal-plan.ts#contentOf` appends the header only
  when there is one; a unit test holds the old hashes). The first run of a client that sends them reports most documents
  `changed` once, which is the header landing; its dry rerun is unchanged. From then on an invoice paid later shows as
  `changed` in its header alone, and the nightly mail says so (`header (paid, links, …)`). Two clients of different ages must
  not import into the same org: each would rewrite what the other wrote.
- **Contacts' МОЛ.** The importers write `representative`. `scripts/backfill-contact-representative.ts` moves the notes lines
  that are exactly `МОЛ: <name>` into it, dry run first (counts only), `--execute --expect <n>`, a private manifest, `--undo`.
  The contact form shows the field (§3.5), so a moved МОЛ leaves the notes and stays in sight.
- **Test copies.** `org-clone` copies the three new company fields with the rest of the company's identity.
