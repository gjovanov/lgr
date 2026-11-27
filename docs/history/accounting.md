# History: Accounting, payroll and sealed personal data

What was built in this area, release by release: sealed personal data, Bulgarian payroll, VAT files, books imported as booked.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/accounting.md`](../../.claude/rules/accounting.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## Personal data is sealed (FR-25 §3.12)

An employee's ЕГН, tax id, birth date, address, bank details and health-related data live in one sealed
JSON, `Employee.personal` (`pd1.<keyId>.<nonce>.<ciphertext>`). The keys are per org (`PersonalDataKey`),
wrapped by `PERSONAL_DATA_KEK`, which is in no database and no backup. Runbook:
`docs/guides/personal-data-key.md`.

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
- `payroll.read` is a run's totals. Anything about one person needs `payroll.personal`.
- Fixtures use an ЕГН that passes the checksum with month 13, so it can be nobody's: `7513020014`.

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
- A new sealed place joins `SEALED_PATHS` in `personal-data/restore.ts` and `views.ts`, which is an allow-list:
  no route sends a model as it is. A person's amounts come out through `POST …/reveal`, which writes its
  audit row first.
- **Import** (§5.1): `scripts/import-payroll.ts` opens the sealed files in memory and posts to
  `POST payroll/import/{employees,contracts,months}`, which need `payroll.import` and `payroll.personal`.
  `dryRun` is the default of the routes too. A month is replaced whole, and answers in counts. A line is a
  person on a contract (§11): a row goes to the contract in force on its field 9, and two rows landing on
  one contract refuse the month. ⚠ What an import prints, logs or audits is counts and month names, never a
  person.
- **Proof, printing counts only:** `scripts/compare-payroll-files.ts` (re-emit equals the filed bytes) and
  `scripts/prove-payroll-engine.ts` (each filed person-month through the engine). Results: FR-25 §9.
- Обр. 1 and 6 name their software: `PAYROLL_DEVELOPER_EIK`, no default, and no value in this repo.
- ⚠ The CP1251 codec is `config/cp1251` (`fiscal/cp1251` re-exports it): `services` cannot import `fiscal`,
  which depends on it.

## VAT files (2026-11-03, FR-25 R2)

LGR holds the filed Bulgarian VAT registers as data, and regenerates the NRA's files from them byte for byte: `DEKLAR`, `PRODAGBI`, `POKUPKI`, `VIES`. **LGR never files**: it produces the files, a person files them, and it records who, when and the acknowledgement (FR-25 D7). Plan and record: `docs/fr/FR-25-books-payroll-and-bg-filings.md` §7.1, §7.2, §9.
- `services/biz/vat-files/`: `layouts.ts`, `codec.ts`, `rules.ts`, `month.ts` are import-pure. `vat-return.service.ts` is the only one that touches the database. `generateMonthFiles` (`month.ts`) is the ONE path to the files: the gate, the import, `generate` and the download all run it, so what the gate proves is what the app produces.
- ⚠ **Integer cents, keyed by official code** (`02-10`, `01-20`). `codec.ts` refuses what does not fit its width or Windows-1251, and never truncates. A `VatFileError` names the field and the record, never the value: these messages reach terminals and transcripts.
- ⚠ **A VAT file is not stored.** The rows are the record; a download regenerates and must equal the recorded `sha256`, or it answers 409 `vat_return_stale`. A change to a layout must keep the filed months regenerating.
- ⚠ **A return with a `kind` belongs to its flow**: the generic `PUT`/`DELETE` on `tax-return` refuse it (409), or `accounting.write` could do what `accounting.file` guards.
- ⚠ **Never `select: false` on a field a filed month needs.** The backup bundle reads every model through Mongoose (`tenantCollections()` → `.find({ orgId })`), so it would lose the field, and the VIES declarant's ЕГН with it. It is an ordinary field, left out of JSON by `withoutPersonalId`.
- ⚠ **`config/cp1251` is the one codec.** `fiscal/cp1251` re-exports it: `fiscal` depends on `services`, so `services` cannot import `fiscal`.
- The gate: `bun run scripts/compare-vat-files.ts --dir <nap/vat dir>`. The import: `bun run scripts/import-vat-files.ts --org <slug> --dir <nap/vat dir> [--execute]`, dry run by default. Both print months and counts, never an amount, a partner or a document number.
- The golden files in `packages/tests/src/fixtures/vat-files/` are made up, and `binary` in `.gitattributes`: CRLF is part of the format. So a diff does not show them, and a public scan has to read them itself.

## A company's books, imported as booked (2026-11-03, FR-25 R1)

Plan: `docs/fr/FR-25-books-payroll-and-bg-filings.md`, §5 and "R1 — as built". The books of one legal
entity live in a **books org** (`settings.accounting.books.mode: 'books'`), and its stores are
branches. `services/biz/accounting-books/`: `registry` (document types, analytic roots, an account's
shape; nothing else spells them) · `plusminus-exports` (the parsers, import-pure) · `journal-plan`
(what a month becomes) · `import.service` · `books-ledger` (the reports' one reading) · `compare` ·
`link-books.service`.

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
- **Tests:** `unit/accounting-books.test.ts`, `integration/accounting-books-import.flow.test.ts` (every
  row of §1.4 as a made-up fixture), `dal/repos/journal-entry.repo.test.ts`. Held days:
  `unit/books-held-days.test.ts`, `integration/accounting-books-held-day.flow.test.ts`.

## A product's accounting group (2026-11-19, FR-25 R3, slice 1)

`ProductGroupMap` names the goods group (an analytic under `СТОКИ:`) a product's sales book to, in the org that holds
both the product and its share of the books (R7). `services/biz/accounting-books/product-groups.ts` holds the rules
(import-pure), `product-groups.service.ts` the reads and the writes, and `scripts/learn-product-groups.ts --org <slug>
[--from <day>] [--to <day>] [--execute]` runs them, a dry run by default that prints counts only. Plan and rules:
FR-25 §3.6, §6.1 and §9, "R3 after R7: the plan".
- ⚠ **Never change or remove a `ProductGroupMap` row the accountant owns**: `source: 'accountant'`, or any
  row with a `reviewedAt`. Learning writes only `exact` and `learned` rows, and each write names the row as
  it was read, so a row the accountant takes in the meantime is skipped and counted, never overwritten.
- ⚠ **A conflict is never mapped.** A product whose documents name two groups gets no learned row, and
  loses the one it had: it is for the review queue, which reads conflicts from the same evidence.
- `rule` and `ai` rows are suggestions: coverage and posting go by `exact`, `learned` and `accountant`.
- **Tests:** `unit/product-groups.test.ts`, `integration/product-groups.flow.test.ts`.

## A product's group from the books' quantities per group (2026-11-20, FR-25 R3, slice 1b)

Slice 1's two rules teach nothing from a document the accountant booked one operation per group rather than per line,
which is most of them. `services/biz/accounting-books/product-group-partition.ts` (import-pure) reads those documents:
it finds every split of LGR's goods lines between the entry's groups whose quantities sum to the books' per group, and
teaches a product a group only when every split gives it that group, in passes until the anchors settle.
`learnProductGroups` runs it after slice 1, `LearnReport.partition` counts what it did, and the script prints those
counts. Rules, caps and the anchor rule: FR-25 §9, "Partition, as built".
- ⚠ **A document that fits only against an automatic anchor never teaches a new row.** It is counted as
  `anchor_contradicts` and goes to the conflict path: a learned product becomes a conflict and its row is taken away,
  an exact row keeps its group with the document in its `conflictCount`. A document that fits only without the
  accountant's rows teaches nothing, and the rows stay as they are (`accountant_contradicts`).
- ⚠ **Partition's anchors are the run's own**: the accountant's rows, the exact names and what this run learns. Never
  feed it the learned rows an earlier run stored: a run would depend on the one before it, and a second run would no
  longer plan nothing.
- ⚠ **Never leave a goods line out to make the sums meet.** A goods line the books carry as a service is exactly the
  line that must not be taught: when LGR's goods total is not the books', the document teaches nothing.
- **Tests:** `unit/product-group-partition.test.ts` (the search against trying every assignment, each guard, the
  passes and restarts, shuffled input, a second run), `integration/product-groups-partition.flow.test.ts`.

## A store's sales posted into the shadow ledger (2026-11-20, FR-25 R3, slice 3)

LGR books an org's own sales invoices, debit and credit notices the way the accountant does (§1.4), into
`ledger: 'shadow'`, beside the books it imports, so that the two can be compared before LGR takes the books over
(R6). `PostingRule` (§3.7) holds the patterns as data, seeded per books org by
`accounting-books/posting-rule-seed.ts` (four rules a kind of document: the goods at the group's cost and their
net, the services' net, the VAT and its register row, the cash paid at issue). `shadow-sales.ts` turns one
document into an entry and its register row, or into the first reason it cannot post (import-pure);
`group-cost.ts` + `group-cost.service.ts` give the books' own cost of a group as of a day; `shadow-compare.ts`
says where a posting differs from the accountant's entry of the same number; `shadow-sales.service.ts` runs a
period. Scripts: `scripts/seed-posting-rules.ts` and `scripts/post-shadow-sales.ts`, dry runs by default, counts
only. Plan, decisions and the dry run's counters: FR-25 §9, "R3, slice 3, as built".
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
- **Tests:** `unit/shadow-sales.test.ts`, `unit/shadow-cost-compare.test.ts`, `integration/shadow-sales.flow.test.ts`
  (a home and a store end to end, and every reading of their books the same after a run).

## The review queue of a product's group (2026-11-20, FR-25 R3, slice 2)

The accountant's page for the product → group map, `/accounting/product-groups`: the goods a store sold in a period
by net sales value, each with its state (`conflict`, `unmapped`, `learned`, `exact`, `accountant`, `reviewed`) and
the documents behind it, the conflicts and the unmapped by default. There the accountant sets a group, accepts a
proposal, confirms a learned or exact row, or withdraws a decision. `services/biz/accounting-books/product-group-review.ts`
holds the rules (import-pure), `product-group-review.service.ts` the cache, the queue and the writes, and
`accounting-api` `product-group.controller.ts` the API. Design, the cache and the writes: FR-25 §9, "R3, slice 2, as
built".
- ⚠ **No write of the review queue reads its cache.** The evidence a pod keeps only lists; each write reads the row
  from the database and is conditioned on the row the page showed (`expected`, its `updatedAt` or null), so a stale
  listing is refused (409 `row_changed`), never written from.
- ⚠ **The queue's cache key is everything a learning run reads** (`readStamps`: the books' sales entries, the sales
  documents and the till's, the document files, the products, the goods groups, the accountant's rows, the books link,
  the day). A new input to `loadLearning` joins the stamps, or the queue shows a reading that no longer holds for up to
  30 minutes.
- ⚠ **An evidence document's `day` is its UTC midnight: `formatDate(day)`, with no `timeZone`.** The formatter reads a
  UTC midnight as that day wherever the browser is; a zone made it a moment, and east of UTC the page showed the day
  before. A decision's `reviewedAt` is the opposite, a moment: `formatDateTime` (fixed 2026-11-20; as a day alone, a
  browser west of Sofia showed a decision made just after midnight there on the day before).
- ⚠ **A row posts only on a goods group still active** (`postsBy(after, activeGroups)`, `stateOf`; fixed 2026-11-20).
  Slice 3 refuses a line whose group was switched off (`group_inactive`), the accountant's row too, while the queue
  listed such a row as done and its coverage counted it. Now it is the work again (`unmapped`, or `conflict`), its
  group shown inactive, and its sales count as no group.
- ⚠ **The org a sign-in returns has no `settings`; `/auth/me` brings them.** Until then `isBooksOrg` is false, so the
  page waits for them (`settingsKnown`) before it says the org keeps no books or asks for the queue.
- **Tests:** `unit/product-group-review.test.ts`, `unit/product-groups-page.test.ts`,
  `integration/product-group-review.flow.test.ts` (the queue, the writes, the stale listing, who may write, other orgs).

## Books against shadow, a month at a time (2026-11-20, FR-25 R3, slice 5)

The comparison §6.3 asks for, as a script first: for one store and one month, the store's own sales documents each
ledger holds, the ones both hold (equal, or where they differ, by the dry run's own check), each goods group's quantity
and cost over those, the month's cost of sales, the documents one ledger holds alone, and the home's sales register,
the shadow's rows against the filed ones of the store's series. `services/biz/accounting-books/books-shadow-compare.ts`
compares (import-pure), `books-shadow-compare.service.ts` reads, `scripts/compare-books-shadow.ts --org <store>
--from YYYYMM [--to YYYYMM]` prints counts only. The page and the digest section come next. Design: FR-25 §9, "R3,
slice 5, as built".
- ⚠ **A document of a month is that month's entries under its number, each ledger's summed.** The books' invoice and
  its annulment are one document, and so are the shadow's posting, its reversal and its next revision; a void in a
  later month is that month's reversal, never a rewrite of the month of issue. A document whose entries of the month
  cancel out is not held in that month. Read across months, a void would count twice.
- ⚠ **The filed side of the register is the store's own rows only: a ten-digit number in its series, of a document
  type.** The home's register also holds the other store's rows, the tills' months and the protocols; read whole, they
  would all count as filed and not in the shadow.
- **Tests:** `unit/books-shadow-compare.test.ts`, `integration/shadow-sales.flow.test.ts` (before a run, after it, a
  void in a later month, the refusals, the script's output).

## Payroll into the split's home (2026-11-20, FR-25 P1)

The owner's word: payroll lives in the split's orgs too, and the books org that held it is dropped once everything
is moved. It goes to the home, beside the `ЗАП` postings already there: one employer files one обр. 1 and one обр. 6 a
month, and the contracts do not say who works where. Built before any person reaches the home, because a sync never
deletes what a copy already holds. Design: FR-25 §9, "P1 into the home".
- ⚠ **A books org's test copy leaves its payroll out, and only then may it hold a key.** Every model the payroll keeps
  is in `BOOKS_NEVER_CLONED` (people, contracts, absences, leave, runs, payslips, timesheets, elements), and
  `refusedSourceModels` stops refusing a books org that holds a `PersonalDataKey`. Any other org holding one is still
  refused, and so is a books org the day it stops keeping books. A new sealed model (`SEALED_PATHS`) joins that list,
  or `org-clone.flow.test.ts` fails.
- ⚠ **A store of a split never takes payroll:** the import answers 409 `payroll_in_home`, on top of
  `payroll_engine_not_set`. A store's share would declare part of the company.
- **Who reads it is roles:** in the home, every member whose role holds `payroll-people` does, an Administrator
  included. A person who should not gets a role without it.
- **Tests:** `integration/org-clone.flow.test.ts` (a books org holding a key and payroll, copied without either; one
  that stops keeping books, refused again; the sealed models all left out), `integration/payroll-bg.flow.test.ts` (a
  store of a split refused, the home taken).

## The payroll lists export, and a payslip prints (2026-11-23, #830)

FR-32.12 took away the Export menus of Employees, Payroll runs, Payslips and Timesheets and the payslip's PDF button,
which did nothing. They are back, and they work. Each list's `GET …/export?format=xlsx|pdf` takes the list's own query
(one filter per list in `services/biz/payroll/list-export.ts`, which the list's GET uses too) and the screen's words
(`labels`), and prints through the house-style generators the analytics grid and the reports use; a file the cap cut
answers `x-truncated`. A payslip's PDF is `POST payroll/payslip/:id/pdf` (`reporting/pdf/payslip.pdf.ts`).
- ⚠ **A payroll export prints no pay of a person and nothing sealed.** Its columns are a list of their own, narrower
  than the list's answer: no base salary, no masked ЕГН, no payslip amount (sealed or not), no run line; a run's totals
  stay. The screens show salary and a generic payslip's amounts to the same role, but a file of everyone's pay is the
  owner's decision, and then a column each.
- ⚠ **A sealed payslip's PDF is a reveal.** It needs `payroll-people.reveal` (the route rule asks only the list's
  `payroll-people.view`, for the generic run's payslip) and a reason, and writes the row `/reveal` writes
  (`action: 'reveal'`, field `sealed.pdf`, the reason, never the value) before the file leaves. No row, no file.
- The searches now find what they say: a payslip's and a timesheet's search look for the employee (they looked in
  `employeeName` and `notes`, which neither model has), and the timesheets' employee and days filter the list.
- **Tests:** `integration/payroll-list-export.flow.test.ts`, `unit/payroll-list-export.test.ts`, and the Employees
  export in `e2e/tests/payroll.spec.ts`.

## The shadow's cost no longer takes the books' cost of a sale in (2026-11-24, FR-25 R3, slice 3)

Slice 3 read a group's average off the books' balance: value over quantity on hand on 304, every line summed. That
keeps every cost the books booked for a sale in the value left on hand, so one cost booked wrong lowers the average
of what is left, for every later sale of the group. From March 2026 the books cost most groups higher than the
average they used in January and February (FR-25 §9, "Read from the books themselves"), and the balance carried that
into the shadow's cost. `group-cost.ts` now replays the average instead, §3.5's own rule, each day's goods in before
its goods out: what comes in on 304 comes in at the books' value, and what goes out with a quantity leaves at the
average after the day's goods in. The day's sales still post at the average the day starts with.
`group-cost.service.ts` sums a day's lines without a quantity apart (`debitValueOnly`, `creditValueOnly`): they move
the value of what is on hand, never goods.
- ⚠ **The books' cost of a sale is what the shadow is checked against, never what it is built from.** A reading of
  the books that feeds the shadow's cost takes what came in (the opening, purchases, discounts, returns to the supplier)
  at their value, and the quantities of what went out, never the value the books put on a sale.
- ⚠ **Within a day, goods in come before goods out.** A first cut took a day's sales out at the average the day
  starts with, the unit they post at. On a group bought to order, nearly all of a day's purchase leaves the same day:
  what was left then carried the difference between the purchase's price and the old average on a few units, and a
  later return to the supplier made that average run away. Two more rules came from the same check against the books:
  - after a shortfall (sold before the purchase was booked), what is left after the purchase costs what came in, as
    in the books' own euro average; a group still short after a purchase keeps its last average, which measured
    closer than taking that purchase's unit;
  - goods sent back to the supplier go back at the average, not at their purchase price.
- **Checked against the books' 2026 journal** (outside the repo): the replay meets the books' own cost to 0.5% on
  more than nine sales in ten entered before 8 March, and every month's cost of sales comes within 3% of the books'
  euro moving average.
- **Tests:** `unit/shadow-cost-compare.test.ts` (a sale booked at a wrong cost, a purchase after it, a day with both,
  a group bought to order, a shortfall and a purchase after it, a group still short, goods sent back to the supplier,
  a return, a value corrected, a discount and a cost added with nothing on hand),
  `integration/shadow-sales.flow.test.ts` (the cost read from a split's books, with a value-only credit notice; a
  credit notice's cost no longer takes the books' cost of an earlier sale in).

## A filed month of purchases against LGR's bills (2026-11-24, FR-25 R4, slice 1)

R4's first slice counts before it writes: one filed month's purchase register (`POKUPKI`, R2's `VatRegisterEntry` rows
with `side: 'purchase'`, in the home) against LGR's bills (incoming invoices, debit and credit notes, in every org of the
split), and how many rows pair with a bill. `services/biz/accounting-books/purchases/pairing.ts` pairs (import-pure),
`pairing.service.ts` reads, `scripts/pair-purchases.ts --org <slug> --period YYYYMM [--details]` prints counts only and
has no `--execute`. Design: FR-25 §9, "R4, slice 1: the pairing count, as built".
- ⚠ **The supplier's number on a bill is `reference`, never `invoiceNumber`.** The Files pipeline and the bill form
  keep the supplier's number there; `BILL-…` is LGR's own number, a counter unless the supplier's was all digits.
- ⚠ **A bill can be in any org of the split.** The books keep every purchase in the home, but each store enters the
  bills for what it receives. Reading only the home counts a store's bills as missing.
- ⚠ **`--details` prints real document numbers and VAT numbers.** Its output is for the person running it; only the
  counts go in a PR, an issue or the spec.
- **Tests:** `unit/purchase-pairing.test.ts` (the keys, the periods, the amounts and signs, each pass and each outcome),
  `integration/purchase-pairing.flow.test.ts` (a split's home and store, every outcome, nothing written, the script's
  output with and without `--details`).

## The accountant's override of a group's average cost (2026-11-25, FR-25 R3)

The accountant answered slice 3's first question: the cost is the daily average price, as until March, with an option to
override it, because write-offs and other losses do not show in the average. The shadow keeps the group's moving
average at the start of the sale's day, and `GroupCostOverride` (in the home) restates a group's average from a day
on: `group-cost.ts` applies it at the start of its day, after an opening of the same day, and the replay goes on from
there. Accounting → Group costs lists, adds, changes and removes them, with the replayed average beside the unit asked
for (`GET /accounting/group-costs/average`). FR-25 §9, "R3: the accountant's override of a group's average".
- ⚠ **An override restates the average; it moves no value.** It is the accountant's statement of what a unit of the
  group costs from the start of its day: what is on hand is restated to it, what comes in after averages in with it,
  and the write-off or revaluation it stands for stays in the books. Nothing writes it into the books, and the books'
  cost of a sale still never feeds the average.

- ⚠ **Overrides are the HOME's, matched by path.** One company has one average a group: every org of a split reads
  the home's overrides by the group's path, as the replay reads the books (ids differ between orgs, R7). A store of a
  split answers 409 `not_books_home`, so the list cannot fork.

- ⚠ **An override changes nothing until a shadow run covers its day.** The posting hash carries the cost, so the next
  `post-shadow-sales.ts` over its day reverses and reposts what it changes, on their own days. A run over later days
  only never reaches the sales before them: after an override dated in the past, run the window from its day. Since
  2026-11-27 the nightly run covers every day of the shadow, so the next night reaches it.
- **Tests:** `unit/shadow-cost-compare.test.ts` (the restatement: the day's sales at it, a purchase after it, nothing
  on hand, a group the books never held, an opening of its day and one before the first opening, two overrides, a
  unit that is no amount), `integration/group-cost-override.flow.test.ts` (a store's sales post at the home's override
  from its day; a change and a removal repost only what they change; the routes, the audit trail, a stale page, the
  store and an org without books refused), `unit/group-costs-page.test.ts`.

## A card at the counter, on the cash account (2026-11-25, FR-25 R3, slice 3)

The comparison's first run over every month the shadow holds found 360 documents whose cash differed from the books.
Read one by one, 328 were sales paid by card at the counter, which the books book exactly as cash (`ПЛАЩАНЕ` `1`,
`D501 K411` what was paid) and the shadow did not book at all: its only paid rule took cash. The seed now holds a card
rule per kind of document, fifteen rules, not twelve. The other 32 are cash on delivery (the books book it as paid on
the invoice's day; question 5 of slice 3), the books' own cents, and LGR documents that record no counter payment.
FR-25 §9, "R3: the cash place, explained".
- ⚠ **A card at the counter is booked on `501`, as cash is.** The books code a document paid at the counter `1` and
  debit `501` what was paid, whatever the means: `sales.<kind>.card` books what LGR recorded as paid by card at the
  counter on the document's day, after the cash. It is a rule of its own, so the accountant can point it elsewhere.
- ⚠ **A real run refuses while the org lacks a rule the seed holds.** Without it every document that needs it is
  refused, and a refused document's live posting is reversed: a run at a newer seed before `seed-posting-rules.ts`
  would take the card sales out of the shadow. A dry run reads the missing rules from the seed and counts them.
- **Tests:** `unit/shadow-sales.test.ts` (a card alone, a split tender, another account, the rule switched off, a
  refund on a credit note, the seed's fifteen), `integration/shadow-sales.flow.test.ts` (the seed's counts; a rule
  the org lacks: the dry run reads it, the real run refuses and reverses nothing, the seed then adds it).

## A filed month of purchases against the stores' goods receipts (2026-11-25, FR-25 R4, slice 2)

Slice 1 paired none of 202610's 310 rows: LGR holds almost no incoming bills, and the goods are in the stores' receipts.
The owner chose option (c): the same month against the goods receipts of the home and every store of the split, paired
on partner, day and amount. `services/biz/accounting-books/purchases/receipt-pairing.ts` pairs (import-pure),
`receipt-pairing.service.ts` reads, `scripts/pair-purchase-receipts.ts --org <slug> --period YYYYMM [--details]` prints
counts only and has no `--execute`. Design: FR-25 §9, "R4, slice 2: the rows paired with goods receipts, as built".
- ⚠ **A receipt's `reference` is the store program's number, never the supplier's.** Pair a receipt on partner, day and
  amount; a receipt has no field for the supplier's invoice number.
- ⚠ **A receipt is net, and worth its lines' unit cost.** Compare it with a row's base (`03-31` + `03-32`) and count a
  match to the gross apart. Only a receipt booked by the API import carries the supplier's prices; a PDF receipt of an
  existing article and the negative half of a разписка are at average cost.
- ⚠ **A receipt whose `invoiceId` names an outgoing document is a sale taken back**, never a purchase: leave it out.
- **Tests:** `unit/purchase-receipt-pairing.test.ts` (the exclusions, the tiers, net against gross, a return to a credit
  note, the cross-store count, a later register, a row dated early, the rows left by partner),
  `integration/purchase-receipt-pairing.flow.test.ts` (a split's home and store, every outcome, nothing written, the
  script's output with and without `--details`).

## A наложен платеж as the books book it, and a switch over a rule (2026-11-25, FR-25 R3, slice 3)

Question 5 of slice 3, answered by the owner the same day: the shadow books a наложен платеж as the books do, by a rule of
its own that is on by default and can be switched off. The books code 13 of the 14 compared `1` and debit `501` the
total on the invoice's day, while LGR records no payment until the courier pays. The seed holds a third paid rule per
kind of document, eighteen rules, not fifteen, and `scripts/switch-posting-rule.ts` turns a rule on or off. FR-25 §9,
"R3: the cash place, explained".
- ⚠ **A наложен платеж is booked as paid on its day, its whole total.** `sales.<kind>.cash_on_delivery` books
  `D501 K411[partner]` what the counter did not take of the total that day, so a same-day payment is never booked twice;
  the courier's money recorded on a later day is a receipt of its own.
- ⚠ **Its rule is the one switch: off, a наложен платеж posts as LGR holds it.** A rule that is off is ignored, and a
  document that then lacks a rule for an amount it has waits (a payment LGR holds, a line, the VAT). A наложен платеж
  has no such amount in LGR until the courier pays, so it posts with nothing paid instead. A switched rule is the
  accountant's, a seed never turns it back, and what is posted changes only when a run covers its day.
- **Tests:** `unit/shadow-sales.test.ts` (the total on its day, a later receipt, part taken at the counter, a credit
  note, the rule off, two rules), `integration/shadow-sales.flow.test.ts` (the seed's eighteen; posted, switched off
  and reposted without it, the seed leaves it off, an unknown code; the switch script's dry run).

## The shadow posted each night (2026-11-27, FR-25 R3)

The owner's decision of 2026-11-27: the shadow is posted on its own each night after the import, no longer only by a
person running `post-shadow-sales.ts`. Until then it stood still between hand runs: on 11-27 it was posted through
11-24, so the comparison said nothing of the days after, and an override took effect only at the next hand run over its
day. `services/biz/accounting-books/shadow-nightly.service.ts` is the run; the scheduler `shadow-sales` in
`api/src/unified.ts` starts it at 04:00 in Sofia (`SHADOW_SALES_HOUR`; `SHADOW_SALES_CHECK_INTERVAL_MS` 0 turns it
off); `scripts/post-shadow-sales.ts --org <slug> --nightly [--execute]` is the same night by hand, and with
`--execute` exits 3 when the bound holds it. FR-25 §9, "R3: the nightly run, as built".
- ⚠ **The nightly run never starts an org's shadow.** It runs every org homed here that holds a shadow posting. An
  org's first posting is a person's, after its rules are seeded, its products mapped and a dry run read.
- ⚠ **A night covers the whole shadow**, from the first month the org's shadow holds to yesterday (Sofia), so it
  reaches an edit, a void, a cost the books changed or an override anywhere in it, and a missed night is caught up by
  the next. A hand run over part of it is still safe: the posting is idempotent.
- ⚠ **A night above the bound writes nothing at all** (`NIGHTLY_BOUND`: more than 50 reversals and more than a fifth
  of the live postings). It is a rules change, a books import gone wrong or a fault: read the dry run, then post it by
  hand with `--from`/`--to`, which has no bound.
- ⚠ **A rule added to the seed refuses every night** (`no_rules`) until `seed-posting-rules.ts` adds it, as a hand run
  does. Each such night is in the org's audit trail.
- **Where it is told:** the org's audit trail, under the system's name `shadow-sales` (`actor`): `create` for a
  night that wrote, `hold`, `refused`; a night with nothing to write leaves none. The logs (`Nightly shadow posting`)
  and the scheduler's `failures` count a held, refused or failed night.
- **Tests:** `integration/shadow-sales.flow.test.ts` (its hour and once a day, no shadow started by it, what changed
  anywhere in the window, the audit rows, a held night and the bound, a refusal while another org runs, the script's
  `--nightly`).
