---
paths:
  - "packages/api/src/accounting/**"
  - "packages/web/src/modules/accounting/**"
  - "packages/api/src/payroll/**"
  - "packages/web/src/modules/payroll/**"
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
  - "scripts/*posting-rules*"
  - "scripts/*shadow*"
  - "scripts/*purchases*"
  - "scripts/*purchase-receipts*"
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

## A store's sales posted into the shadow ledger (2026-11-20, FR-25 R3, slice 3)

- ⚠ **A shadow posting carries its document's `sourceId`, `docType` and `docNumber`.** A lookup by any of
  them (an invoice's own entries, the entry a link or a register row names) leaves the shadow ledger out
  (`BOOKS_LEDGER`, `POSTED_BOOKS`, or `ledger !== 'shadow'` in a picker), or it finds two entries where it
  wants one. The journal list shows shadow only when asked (`ledger=shadow`).

- ⚠ **Shadow is written directly, as posted, and never through `postJournalEntry` or a path that moves
  `Account.balance`.** Nothing reads it but the comparison, so nothing may be built from it.

- ⚠ **A shadow posting is never written over.** It is idempotent on `postingKey`
  `shadow:invoice:<document>:<revision>` and its `postingHash`: a document that books otherwise reverses the
  live revision on its own day (the same lines, negative, on the same sides) and posts the next; a void reverses
  it on the void's business day.

- ⚠ **A credit notice and a reversal post negative amounts on the same sides** as the invoice, quantities too,
  as the books do. The sign is the document's, never a rule's.

- ⚠ **The shadow cost of sales is the group's moving average at the START of the sale's business day**
  (`costBasis: 'books'`), replayed from the company's 304 lines per group path, summed in Mongo across every org of
  the split, from the last imported opening. The sale's day never counts; no quantity on hand keeps the last average;
  a group the books never held is refused (`no_cost`), not guessed. Since 2026-11-24 the average is replayed from
  what came in, never from the books' own cost of a sale (below).

- ⚠ **The shadow register row goes in the HOME**, which holds the VAT files under R7, with `ledger: 'shadow'` and
  `source: { orgId, kind: 'invoice', id }` naming the store's document. One row per document and ledger
  (`vat_row_source_unique`); a frozen row is never touched.

- **The commands.** `scripts/seed-posting-rules.ts --org <slug> [--execute]` once per books org, then
  `scripts/post-shadow-sales.ts --org <slug> --from <day> --to <day> [--execute]`. Both are dry runs by default
  and print counts only; the dry run's self-check against the accountant's entries is what to read before any
  `--execute`.

## The review queue of a product's group (2026-11-20, FR-25 R3, slice 2)

- ⚠ **No write of the review queue reads its cache.** The evidence a pod keeps only lists; each write reads the row
  from the database and is conditioned on the row the page showed (`expected`, its `updatedAt` or null), so a stale
  listing is refused (409 `row_changed`), never written from.

- ⚠ **The queue's cache key is everything a learning run reads** (`readStamps`: the books' sales entries, the sales
  documents and the till's, the document files, the products, the goods groups, the accountant's rows, the books link,
  the day). A new input to `loadLearning` joins the stamps, or the queue shows a reading that no longer holds for up to
  30 minutes.

- ⚠ **An evidence document's `day` is its UTC midnight: `formatDate(day)`, with no `timeZone`.** The formatter reads a
  UTC midnight as that day wherever the browser is; a zone made it a moment, and east of UTC the page showed the day
  before. A decision's `reviewedAt` is the opposite, a moment: `formatDateTime`, never the date-only `day()`.

- ⚠ **A row posts only on a goods group still active** (`postsBy(after, activeGroups)`, `stateOf`). Slice 3 refuses
  a line whose group was switched off (`group_inactive`), the accountant's row too. So such a row is listed with the
  work (`unmapped`, or `conflict`), its group shown inactive, and coverage counts its sales as no group. A done state
  on a row that cannot post hid the product from the accountant while every document of it waited.

- ⚠ **The org a sign-in returns has no `settings`; `/auth/me` brings them.** Until then `isBooksOrg` is false, so the
  page waits for them (`settingsKnown`) before it says the org keeps no books or asks for the queue.

- Confirm only an `exact` or a `learned` row: slice 3 posts by `POSTABLE_SOURCES`, so a reviewed `rule` or `ai` row
  would be the accountant's and post nothing. The accountant sets those.

## Books against shadow, a month at a time (2026-11-20, FR-25 R3, slice 5)

- ⚠ **A document of a month is that month's entries under its number, each ledger's summed.** The books' invoice and
  its annulment are one document, and so are the shadow's posting, its reversal and its next revision; a void in a
  later month is that month's reversal, never a rewrite of the month of issue. A document whose entries of the month
  cancel out is not held in that month. Read across months, a void would count twice.

- ⚠ **The filed side of the register is the store's own rows only: a ten-digit number in its series, of a document
  type.** The home's register also holds the other store's rows, the tills' months and the protocols; read whole, they
  would all count as filed and not in the shadow.

- **The command.** `scripts/compare-books-shadow.ts --org <store slug> --from YYYYMM [--to YYYYMM]`: read-only, counts
  only. Before `post-shadow-sales.ts --execute` has written a month, every books document of it is the books' alone.

## Payroll into the split's home (2026-11-20, FR-25 P1)

- ⚠ **A books org's test copy leaves its payroll out, and only then may it hold a key.** Every model the payroll keeps
  is in `BOOKS_NEVER_CLONED` (people, contracts, absences, leave, runs, payslips, timesheets, elements), and
  `refusedSourceModels` stops refusing a books org that holds a `PersonalDataKey`. Any other org holding one is still
  refused, and so is a books org the day it stops keeping books. A new sealed model (`SEALED_PATHS`) joins that list,
  or `org-clone.flow.test.ts` fails.

- ⚠ **A store of a split never takes payroll:** the import answers 409 `payroll_in_home`, on top of
  `payroll_engine_not_set`. A store's share would declare part of the company.

- **Who reads it is roles:** in the home, every member whose role holds `payroll-people` does, an Administrator
  included. A person who should not gets a role without it.

## The payroll lists export, and a payslip prints (2026-11-23, #830)

- ⚠ **A payroll export prints no pay of a person and nothing sealed.** Its columns are a list of their own, narrower
  than the list's answer: no base salary, no masked ЕГН, no payslip amount (sealed or not), no run line; a run's totals
  stay. The screens show salary and a generic payslip's amounts to the same role, but a file of everyone's pay is the
  owner's decision, and then a column each.

- ⚠ **A sealed payslip's PDF is a reveal.** It needs `payroll-people.reveal` (the route rule asks only the list's
  `payroll-people.view`, for the generic run's payslip) and a reason, and writes the row `/reveal` writes
  (`action: 'reveal'`, field `sealed.pdf`, the reason, never the value) before the file leaves. No row, no file.

## The shadow's cost no longer takes the books' cost of a sale in (2026-11-24, FR-25 R3, slice 3)

- ⚠ **The books' cost of a sale is what the shadow is checked against, never what it is built from.** A reading of
  the books that feeds the shadow's cost takes what came in (the opening, purchases, discounts, returns to the supplier)
  at their value, and the quantities of what went out, never the value the books put on a sale.

- ⚠ **Within a day, goods in come before goods out.** A first cut took a day's sales out at the average the day
  starts with, the unit they post at. On a group bought to order, nearly all of a day's purchase leaves the same day:
  what was left then carried the difference between the purchase's price and the old average on a few units, and a
  later return to the supplier made that average run away. After a shortfall, what is left after a purchase costs what
  came in, and a group still short keeps its last average; goods sent back to the supplier go back at the average.

## A filed month of purchases against LGR's bills (2026-11-24, FR-25 R4, slice 1)

- ⚠ **The supplier's number on a bill is `reference`, never `invoiceNumber`.** The Files pipeline and the bill form
  keep the supplier's number there; `BILL-…` is LGR's own number, a counter unless the supplier's was all digits.

- ⚠ **A bill can be in any org of the split.** The books keep every purchase in the home, but each store enters the
  bills for what it receives. Reading only the home counts a store's bills as missing.

- ⚠ **`--details` prints real document numbers and VAT numbers.** Its output is for the person running it; only the
  counts go in a PR, an issue or the spec.

- **The command.** `scripts/pair-purchases.ts --org <slug> --period YYYYMM [--details]`: read-only, no `--execute`,
  counts only.

## The accountant's override of a group's average cost (2026-11-25, FR-25 R3)

- ⚠ **An override restates the average; it moves no value.** It is the accountant's statement of what a unit of the
  group costs from the start of its day: what is on hand is restated to it, what comes in after averages in with it,
  and the write-off or revaluation it stands for stays in the books. Nothing writes it into the books, and the books'
  cost of a sale still never feeds the average.

- ⚠ **Overrides are the HOME's, matched by path.** One company has one average a group: every org of a split reads
  the home's overrides by the group's path, as the replay reads the books (ids differ between orgs, R7). A store of a
  split answers 409 `not_books_home`, so the list cannot fork.

- ⚠ **An override changes nothing until a shadow run covers its day.** The posting hash carries the cost, so the next
  `post-shadow-sales.ts` over its day reverses and reposts what it changes, on their own days. A run over later days
  only never reaches the sales before them: after an override dated in the past, run the window from its day.

- **The commands.** Accounting → Group costs (or `/org/:orgId/accounting/group-costs`) in the home, then
  `scripts/post-shadow-sales.ts --org <slug> --from <the override's day> --to <day> [--execute]` for each org of the
  split; its "Cost basis" line counts the overrides applied.

## A card at the counter, on the cash account (2026-11-25, FR-25 R3, slice 3)

- ⚠ **A card at the counter is booked on `501`, as cash is.** The books code a document paid at the counter `1` and
  debit `501` what was paid, whatever the means: `sales.<kind>.card` books what LGR recorded as paid by card at the
  counter on the document's day, after the cash. It is a rule of its own, so the accountant can point it elsewhere.

- ⚠ **A real run refuses while the org lacks a rule the seed holds.** Without it every document that needs it is
  refused, and a refused document's live posting is reversed: a run at a newer seed before `seed-posting-rules.ts`
  would take the card sales out of the shadow. A dry run reads the missing rules from the seed and counts them.

- **After a rule is added to the seed**, `scripts/seed-posting-rules.ts --org <slug> [--execute]` adds only the rules
  an org lacks, then the next `post-shadow-sales.ts` over the months reposts the documents the new rule changes. Seed
  first: the run's dry run plans the same before and after, the real run refuses before.

## A filed month of purchases against the stores' goods receipts (2026-11-25, FR-25 R4, slice 2)

- ⚠ **A receipt's `reference` is the store program's number, never the supplier's.** Pair a receipt on partner, day and
  amount; a receipt has no field for the supplier's invoice number.

- ⚠ **A receipt is net, and worth its lines' unit cost.** Compare it with a row's base (`03-31` + `03-32`) and count a
  match to the gross apart. Only a receipt booked by the API import carries the supplier's prices; a PDF receipt of an
  existing article and the negative half of a разписка are at average cost.

- ⚠ **A receipt whose `invoiceId` names an outgoing document is a sale taken back**, never a purchase: leave it out.

- **The command.** `scripts/pair-purchase-receipts.ts --org <slug> --period YYYYMM [--details]`: read-only, no
  `--execute`, counts only; `--details` names rows and movements, for the person running it.

## A наложен платеж as the books book it, and a switch over a rule (2026-11-25, FR-25 R3, slice 3)

- ⚠ **A наложен платеж is booked as paid on its day, its whole total.** `sales.<kind>.cash_on_delivery` books
  `D501 K411[partner]` what the counter did not take of the total that day, so a same-day payment is never booked twice;
  the courier's money recorded on a later day is a receipt of its own.

- ⚠ **Its rule is the one switch: off, a наложен платеж posts as LGR holds it.** A rule that is off is ignored, and a
  document that then lacks a rule for an amount it has waits (a payment LGR holds, a line, the VAT). A наложен платеж
  has no such amount in LGR until the courier pays, so it posts with nothing paid instead. A switched rule is the
  accountant's, a seed never turns it back, and what is posted changes only when a run covers its day.

- **Switching a rule:** `scripts/switch-posting-rule.ts --org <slug> --code <code> --on|--off [--execute]`, then
  `post-shadow-sales.ts` over the months it touches, dry run first.
