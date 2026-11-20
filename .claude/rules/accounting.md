---
paths:
  - "packages/accounting-api/**"
  - "packages/accounting-ui/**"
  - "packages/payroll-api/**"
  - "packages/payroll-ui/**"
  - "packages/services/src/biz/payroll/**"
  - "packages/services/src/biz/personal-data/**"
  - "packages/services/src/biz/vat-files/**"
  - "packages/services/src/biz/accounting-books/**"
  - "packages/services/src/biz/postings/**"
  - "packages/services/src/biz/*journal*"
  - "packages/services/src/biz/accounting*"
  - "packages/config/src/cp1251*"
  - "scripts/*payroll*"
  - "scripts/*vat*"
  - "scripts/*books*"
  - "scripts/*product-groups*"
---

# Rules and traps: Accounting, payroll and sealed personal data

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/accounting.md`](../../docs/history/accounting.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## Personal data is sealed (FR-25 §3.12)

- ⚠ **Nothing decrypts by itself.** A repository returns ciphertext. A value comes out through
  `forOrg(orgId).open(model, docId, path, sealed)` in server code, or `POST …/employee/:id/reveal` for a
  person, which needs `payroll.personal` and writes its audit row before answering.

- ⚠ **A value opens only on the document and field it was sealed for.** That is what stops someone with
  database write access copying their own sealed IBAN onto a colleague's row. It also means a remapped
  restore must re-seal: a new sealed model joins `SEALED_PATHS` in `personal-data/restore.ts`.

- ⚠ **Routes send `employeeView`, an allow-list.** A new `Employee` field stays out of every response until
  someone adds it. Forms keep sealed values apart from their own state, which `usePendingChanges` writes to
  browser storage (`useEmployeePersonal`).

- A missing or wrong key is `PersonalDataLockedError`, a 503 named `personal_data_locked`: never a blank,
  and never a value stored in clear. Everything else keeps working.

## Bulgarian payroll (FR-25 P1, P2)

`settings.payroll.engine: 'bg'` turns it on. Unset, a run behaves as it always did. All of it is in
`services/biz/payroll/bg/`, and every file there except the `.service` ones and the sealing helpers is
import-pure.

- ⚠ **One calculation.** `engine.ts#calculatePerson` is what `/calculate`, and the proof, call. Anything it
  does not implement is `UnsupportedPayrollCaseError`, a 422: a type other than `01` is never calculated as
  `01` (D11).

- ⚠ **Whole cents, half up, on the magnitude** (`money.ts`). Never `Math.round(x * 100) / 100`: on doubles it
  rounds some .xx5 values down, and the filed files go to the cent. Each share is rounded once, per
  person, on the percentage the form carries (ДОО as one percentage, not its three funds).

- ⚠ **A parameter is looked up by date, never by year**: 2026 alone has two periods, split at 08-01.
  `parameters.data.ts` is the law as data, and a row in `PayrollParameter` wins over it. A month with no
  calendar row is refused, rather than using last year's.

- ⚠ **The class supplement is an input** (`classSupplement` in `earnings`), like any amount that is not
  derived. РКС № 17/2026 struck parts of КТ чл. 355 and what applies after it needs the accountant, so
  nothing calculates from `classPercent` or `experienceAtStart`, and стаж is never counted in hours.

- ⚠ **One person's month is one sealed JSON** in `PayrollRun.sealedItems`, bound to the run, the person and
  the contract (`runItemPath`), so swapping two people's lines does not open. It holds no id: a restore
  rewrites ids and must not have to look inside. Totals stay in clear, as `ЗАП` carries them anyway.
  `items` stays empty on such a run.

- **Import** (§5.1): `scripts/import-payroll.ts` opens the sealed files in memory and posts to
  `POST payroll/import/{employees,contracts,months}`, which need `payroll.import` and `payroll.personal`.
  `dryRun` is the default of the routes too. A month is replaced whole, and answers in counts. A line is a
  person on a contract (§11): a row goes to the contract in force on its field 9, and two rows landing on
  one contract refuse the month. ⚠ What an import prints, logs or audits is counts and month names, never a
  person.

- ⚠ The CP1251 codec is `config/cp1251` (`fiscal/cp1251` re-exports it): `services` cannot import `fiscal`,
  which depends on it.

## VAT files (2026-11-03, FR-25 R2)

LGR holds the filed Bulgarian VAT registers as data, and regenerates the NRA's files from them byte for byte: `DEKLAR`, `PRODAGBI`, `POKUPKI`, `VIES`. **LGR never files**: it produces the files, a person files them, and it records who, when and the acknowledgement (FR-25 D7). Plan and record: `docs/fr/FR-25-books-payroll-and-bg-filings.md` §7.1, §7.2, §9.

- ⚠ **Integer cents, keyed by official code** (`02-10`, `01-20`). `codec.ts` refuses what does not fit its width or Windows-1251, and never truncates. A `VatFileError` names the field and the record, never the value: these messages reach terminals and transcripts.

- ⚠ **A VAT file is not stored.** The rows are the record; a download regenerates and must equal the recorded `sha256`, or it answers 409 `vat_return_stale`. A change to a layout must keep the filed months regenerating.

- ⚠ **A return with a `kind` belongs to its flow**: the generic `PUT`/`DELETE` on `tax-return` refuse it (409), or `accounting.write` could do what `accounting.file` guards.

- ⚠ **Never `select: false` on a field a filed month needs.** The backup bundle reads every model through Mongoose (`tenantCollections()` → `.find({ orgId })`), so it would lose the field, and the VIES declarant's ЕГН with it. It is an ordinary field, left out of JSON by `withoutPersonalId`.

- ⚠ **`config/cp1251` is the one codec.** `fiscal/cp1251` re-exports it: `fiscal` depends on `services`, so `services` cannot import `fiscal`.

- The gate: `bun run scripts/compare-vat-files.ts --dir <nap/vat dir>`. The import: `bun run scripts/import-vat-files.ts --org <slug> --dir <nap/vat dir> [--execute]`, dry run by default. Both print months and counts, never an amount, a partner or a document number.

## A company's books, imported as booked (2026-11-03, FR-25 R1)

- ⚠ **Import as booked.** A correction is a negative amount on the same side, an amount keeps every
  decimal the file has, and cost of sales stays a debit on 702. Only the base amount rounds.

- ⚠ **The exports refuse rather than guess.** A journal filtered to one account looks like a whole
  one, and a re-import replaces months: anything in the title block that is not known is a filter.
  The file's own counts and totals must hold, and its ЕИК must be the org's.

- ⚠ **A held day is sent around, never left out of its month** (2026-11-19). An archive record that
  cannot be read holds its whole day (`plusminus-archive.ts`, `hold`), and the import sends that month
  as a request per run of the days around it, each covering only its run (`journalRequests`). The month
  sent whole without that day, or a document dropped alone, deletes what LGR holds of it as `gone`. So
  the journal names its held days as a filter line too: an importer from before held days refuses it.

- ⚠ **Every reading of the books leaves out the shadow ledger.** `sumPostedLines` is the one for
  balances; anything else spreads `POSTED_BOOKS` from `db/models`. Unset `ledger` is books, so it is
  a `$ne`, never an equality.

- ⚠ **An imported opening restates the year before.** Adding lines across two imported years counts
  it twice, so a balance starts at the last one (`sumPostedLines`, `before`, `turnoverOnly`).

- ⚠ **`contactId` belongs on a line whose analytic has a Contact.** The balance sheet splits 411 and
  401 by it; without it a debtor and a customer who paid in advance are netted, and the sheet still
  balances. Only an account with `balanceSide: 'both'`, or none set, is split: cash paid to a supplier
  names the supplier on 501 too, and that is still cash.

- **The commands.** Sys-admin, on global: `scripts/link-books.ts --books <slug> --create "<name>"
  --branch <slug>:<CODE>:<series> [--execute]`. Then, with an admin of the books org,
  `scripts/import-accounting-books.ts` (dry run by default; a dry rerun with `unchanged` equal to
  `entries` is the proof of a re-import) and `scripts/compare-accounting-books.ts`, which prints
  "equal" or counts, never an amount, so its output can go in a public PR.

## A product's accounting group (2026-11-19, FR-25 R3)

- ⚠ **Never change or remove a `ProductGroupMap` row the accountant owns**: `source: 'accountant'`, or any
  row with a `reviewedAt`. Learning writes only `exact` and `learned` rows, and each write names the row as
  it was read, so a row the accountant takes in the meantime is skipped and counted, never overwritten.

- ⚠ **A conflict is never mapped.** A product whose documents name two groups gets no learned row, and
  loses the one it had: it is for the review queue, which reads conflicts from the same evidence.

- `rule` and `ai` rows are suggestions: coverage and posting go by `exact`, `learned` and `accountant`
  (`POSTABLE_SOURCES` in `product-groups.ts`).

- ⚠ **A document that fits only against an automatic anchor never teaches a new row.** It is counted as
  `anchor_contradicts` and goes to the conflict path: a learned product becomes a conflict and its row is taken away,
  an exact row keeps its group with the document in its `conflictCount`. A document that fits only without the
  accountant's rows teaches nothing, and the rows stay as they are (`accountant_contradicts`).

- ⚠ **Partition's anchors are the run's own**: the accountant's rows, the exact names and what this run learns. Never
  feed it the learned rows an earlier run stored: a run would depend on the one before it, and a second run would no
  longer plan nothing.

- ⚠ **Never leave a goods line out to make the sums meet.** A goods line the books carry as a service is exactly the
  line that must not be taught: when LGR's goods total is not the books', the document teaches nothing.
