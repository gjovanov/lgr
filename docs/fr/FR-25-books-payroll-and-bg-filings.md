# FR-25 — One set of books and one payroll for a legal entity: import from PlusMinus, posting by accounting group, and the Bulgarian filings

| | |
|---|---|
| **Status** | Plan of 2026-11-02, with the owner's decisions of 2026-11-03 (§2, §12). Being built, release by release. The research was read-only: both store servers, the accountant's PC, LGR prod. Employees' files were read on the PC by scripts that print shapes and monthly totals only (§4). |
| **Tracking** | [gjovanov/lgr#471](https://github.com/gjovanov/lgr/issues/471) |
| **Builds on** | FR-06 (report registry), FR-12 (Files), FR-13 (sealed backups, retention), FR-19 (a person in several orgs), FR-20 (`replicate()`), FR-21 (one cash register), #362 (VAT accounts) |
| **Code anchors** | origin/master `f09913a7`. Anchors, not gospel. |

⚠ This repo is public. This document holds counts and account numbers, never amounts, names, identifiers or real document numbers, and nothing about any employee. The evidence with the figures is in `_docs/regal-pz/_accounting/REPORT-2026-11-02.md`, outside the repo; the tools that produced it are beside it in `tools/`.

## 0. The short version

- **The books are not on the store servers.** They are in a third PlusMinus, in local mode with no server, on the accountant's PC. It has one set of books for the one legal entity that both LGR orgs, `regal-pz` and `regal-sf`, belong to. There is one VAT return.
- **Those books are typed by hand.** 19,349 sales invoices and 4,048 purchase invoices in the last 13 months, 20 to 60 seconds each, some days past midnight. That is the problem this FR removes.
- **What is typed is a restatement.** The same invoice, same quantities and same values, with each product replaced by an **accounting group** (`ВИНТ - САМОПР. - 6.3Х50 - DIN 7504 K` → `ВИНТОВЕ`). Stock (304) and cost of sales are kept per group, at the group's average cost, not per product.
- **So the books can be derived.** September 2026's filed sales register has 1,339 rows; 1,293 equal a store invoice by number, net and VAT, and no store invoice is missing from it. What cannot be derived from store documents today is listed in §1.5.
- **LGR holds nothing yet:** 0 accounts, 0 entries, `settings.accounting` unset in all three Regal orgs. Its accounting module cannot express this bookkeeping as it stands (§1.7), and has bugs this data would hit on the first import (§9, R0).
- **Payroll is part of those books, so it comes too.** Every month's result and month-end balances carry it (604, 605, 421, 454, 455), through one aggregate `ЗАП` document. Everything per person lives in a payroll module beside the journal. The filed declarations reconcile with that document to the cent (§1.8). LGR's own payroll module is a placeholder (§1.9).

**The plan, in order:** repair what is broken (R0) → import the books as booked and prove them to the cent against PlusMinus's own trial balance (R1) → rebuild the filed VAT files from them (R2) → import payroll as filed, behind its own personal-data controls (P1) → post sales forward by group in a shadow ledger beside the accountant's, compared daily (R3) → purchases, and payroll calculated in shadow (R4, P2) → bank, and payroll's files and papers (R5, P3) → switch over at a period boundary (R6). PlusMinus stays the book of record until the comparison has been clean for two filed months. LGR never submits anything to the NRA: it produces the files, a person files them.

## 1. What was found

### 1.1 Three installs, one set of books

| | store server (pz) | store server (sf) | accountant's install |
|---|---|---|---|
| Runs as | `pmserver`, API reachable | `pmserver` behind a LAN, API through a tunnel | desktop client, `mode: local`: **in-process, no port, no API** |
| Holds | operational documents since ~2025-02 | same | the books, for years |
| Chart | 18 codes, one of them `#VALUE!` | a template chart | the working chart, 259 codes, opening balances per year |
| `-ФЕ` (sale) | per product | per product | **per group** |
| `СТ` receipt, `СР` | carry no debit or credit | same | **not there at all** |
| `+ФЕ` (purchase), bank, payroll, VAT, assets | no | no | **only here** |

Both store servers and the accountant's install carry the same company name and EIK. Goods have one stock account with no warehouse analytic, so a transfer between the stores is not an accounting event. `+ФЕ` is what brings stock onto the books.

⚠ The accountant's PC also holds other companies' books. They are out of scope for every step of this FR: no listing, no reading.

Its identifiers go in `.secrets/plusminus-stores.env` by name (`ACC_ROOMLER_AGENT`, `ACC_PM_ROOT`), like the store PCs'.

### 1.2 The accountant's month

From the install's own log (`logs/<day>/log.txt`, one line per screen opened and document saved):

- Sales invoices arrive in batches of 50 to 300 a day, dated days earlier. Purchase invoices are keyed separately from the paper.
- `Преизчисление на количества и средни цени на база счетоводни операции` is run from time to time. It **rewrites the cost on documents already saved**, 153,770 log lines on the last run.
- The VAT files are written between the 7th and the 11th, after several rounds of `ДДС` / `Журнал на документите` / `Хронологична ведомост`.

### 1.3 Accounting groups

Every analytic in PlusMinus is a path with a root (`СТОКИ:`, `КЛИЕНТИ:`, `ДОСТАВЧИЦИ:`, `БАНКОВИ СМЕТКИ:`, `РАЗХОДИ:…`, `РАЗЧЕТИ:…`, `ДА:`, `ПЕРСОНАЛ:`, `МАТЕРИАЛИ:`, `УСЛУГИ:`, `ПРОДУКЦИЯ:`, `ПРИХОДИ:`). An analytic under `СТОКИ:` in the books is not a product:

- 2,110 entries against 23k and 26k products in the two store catalogs. 1,138 sold in 2023, and 123 of them carry 80% of the cost of sales. Some are broad (`БОЛТОВЕ`, `БОЛТОВЕ 1`, `БОЛТОВЕ УСИЛЕНИ 2`), some are one article.
- **The grouping is the accountant's judgement, not a rule.** `ДРЪЖКА → БРАВИ`, `ИМБУС → БОЛТОВЕ`, `ЛИТИЕВА ГРЕС VD-40 → СПРЕЙ`. On a sample of purchase lines a first-word match finds about half. Nothing in PlusMinus stores product → group: it exists only in what was typed.
- **The cost is a moving average of the group.** In the 2023 journal, of 55,681 consecutive sales with no purchase between them, 95.3% carry the same unit cost. It steps at a purchase: the first sale after one is within 0.5% of the predicted average in 68% of cases and within 5% in 90%, the misses being same-day order and an estimated on-hand.
- ⚠ **Do not try to recompute history.** A simulation from an opening derived backward matched 42.7% of lines to the cent, because "Преизчисление" has rewritten values between any two exports. History is imported **as booked**. Going forward LGR computes its own, and the comparison is on month totals per group (§6.3).

### 1.4 How each document is booked

From the journal of the whole of 2023 (155,815 rows, 26,272 documents, 129,541 operations) and confirmed on 2025–2026 exports. `[x]` is the analytic on that side.

| Doc | What | Operations |
|---|---|---|
| `-ФЕ` | sales invoice | per group `D702 K304[СТОКИ:group]` + qty, at group cost · `D411[КЛИЕНТИ:x] K702` net · `D411[КЛИЕНТИ:x] K4532` VAT · paid in cash at issue: `D501 K411[x]` · services `K703`, production `K701` + `D701 K303` · advance `D411 K412` |
| `КП` | till, **one document per device per month**, dated the last day | per group `D702 K304` + qty (100–200 lines) · `D411[КЛИЕНТИ:ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ] K702`, `K4532` · `D501 K411` |
| `-ФЕА` / `-ФИ` | annul / re-issue | same shape, negative |
| `+ФЕ` | purchase invoice | goods `D304[СТОКИ:group] K401[ДОСТАВЧИЦИ:x]` + qty · materials `D302` · expense `D601/D602/D609[РАЗХОДИ:…]` · lease `D159`, interest `D621` · prepaid `D651` · asset `D20x[ДА:…]` · `D4531 K401` · cash: `D401 K501` |
| `-П` | protocol for an EU purchase (чл.117 ЗДДС) | `D4531 K4532`, naming the `+ФЕ` in its comment |
| `МД` | customs declaration | `D4531 K457`, `D304 K457` |
| `-ПЛН` | VAT on own use | `D609 K4532` |
| `СИ` | write-off | `D601 K304[СТОКИ:group]` + qty |
| `+ББ` / `-ББ` | bank, money in / out | `D503[БАНКОВИ СМЕТКИ:iban] K411[x]`, comment naming the invoices · `D401[x] K503` |
| `ББ` | bank, other | fees `D629`, cash deposited `D503 K501`, taxes `D4539/D454/D455/D452/D457 K503`, salaries `D421`, dividends `D425`, between accounts `D504 K503` |
| `+БВ` / `-БВ` | foreign-currency bank | `D504 K411`, `D401 K504`, rate differences `D624`, `K724` |
| `ЗАП` | payroll, monthly | `D604 K421` · `D605 K455` · `D421 K455` · `D421 K454` |
| no document | monthly | amortization `D603 K241x[ДА:…]` · `D601 K302` · VAT `D4532 K4531`, `D4532 K4539` |
| no document | 31.12 | `D611 K601..609` per analytic · `D702 K611`, `D702 K123` · `D70x K123`, `D72x K123` · `D123 K62x` · tax `D123 K452` · `D123 K122` · dividends `D122 K425`, `D425 K454`, `D425 K50x` |

Three things in this table that read as mistakes and are not:

1. **Cost of sales is a debit on revenue**, `D702 K304`, not on a 6xx account. The credit side of 702 is revenue, the debit side is cost, and the balance is the margin. A report that nets 702 shows margin as revenue (§1.7).
2. **Corrections are negative amounts on the same side** (593 operations in 2023), so turnovers come out as the books show them. Swapping sides, as `createInvoiceJournalEntry` does, would give different turnover columns.
3. **The customer's account is hit even for cash**: `D411 K702`, then `D501 K411`. The partner ledger sees every sale.

The `Вид` column on each document header (`1`, `3`, `17`, `35`, `39`…) is the VAT kind, which decides the register columns.

### 1.5 The VAT files, against the store documents

The accountant's install writes `nap/vat/<yyyymm>/<eik>/{DEKLAR,POKUPKI,PRODAGBI}.txt`: fixed width, CP1251, 42 months on disk. For September 2026:

| Sales register rows | Count | Can LGR derive it? |
|---|---:|---|
| `01`/`03` matching a store `-ФЕ` by number, net and VAT | 1,293 | **yes, today.** Every store invoice is present |
| `09` protocols for EU purchases | 18 | from the purchase side, once `+ФЕ` is in LGR |
| `01` in a third, 5-digit invoice series | 24 | ⚠ on neither store server, source unknown (§12) |
| `81` monthly till turnover | 3 | partly: one row per device, see below (§12) |
| `09` own use | 1 | keyed |

The same reconciliation for three months of 2025 gives the same picture: 94–95% of the rows equal to the cent, one row differing (an annulment), at most 2 store invoices absent from the register.

**The till rows.** Against all nine months of 2026: pz's row is the till's net minus the receipts that name an invoice, within 0.35 in 8 of the 9. sf's row follows its till register but is no formula on it, so it probably comes from the fiscal device's own report. The third row belongs with the third invoice series.

**The return itself is arithmetic.** On all 42 filed months (2023-04 to 2026-09), every `DEKLAR` field equals the sum of its register columns, the row counts equal, input VAT equals the purchase column, and payable equals output minus credit. 42 of 42, no exceptions. Rows are sorted by date and numbered 1..n in all 42. So the work in a return is in the registers: once those are right, the return follows.

All 296 purchase register rows exist only in the accountant's install. LGR holds no purchase invoices at all (one, voided). Four of them are dated outside the month: the period is chosen per document.

### 1.6 The filings

The install's `nap/` folder shows what is produced: `vat`, and for payroll `decl_1_6`, `ETZ`, `SPR73_6`, `UvedTD` (§1.8). Exports show the annual set: `balans`, `opr`, `opp`, `osk`, `dand92`. An Intrastat module and the NRA's own declaration program are installed on the same PC. §7 covers each.

### 1.7 LGR's accounting module today

Models exist for accounts, journals, journal entries, fiscal years and periods, fixed assets, bank accounts, reconciliation, tax returns. Against §1.4:

| Need | Today |
|---|---|
| Analytic per line, in a tree | Only `contactId`, a free `costCenterId`, free `tags` (`journal-entry.model.ts:6-18`) |
| Quantity on a line | None |
| Which debit pairs with which credit | None. The main book and the chronology are built on correspondence |
| Document type, number, date on an entry | `reference`, `sourceModule`, `sourceId` only |
| Reports | Trial balance has net debit/credit with no opening, turnover or closing columns. No main book, no chronology, no analytic turnover |
| VAT | `TaxReturn` is CRUD on free-form lines (`tax-return.controller.ts`): no register, no cells, no files |
| Legal entity | None. Each org is its own world, and rightly so for tenancy |
| Forward posting | Revenue + VAT at `invoice.posted` to single default accounts; cost as a separate entry from the movement, per product, at `resolvedUnitCost` |

Bugs are in §9, R0.

### 1.8 Payroll in the accountant's install

Payroll is a full module of the same install, beside the journal. The books see only its result, and that result is in every month's figures:

| In the books | Operations |
|---|---|
| `ЗАП`, one document a month, no person on any line | gross `D604[РАЗХОДИ:ЗАПЛАТИ:…] K421` · employer's contributions by fund `D605[РАЗХОДИ:ОСИГУРОВКИ:…] K455[РАЗЧЕТИ:…]` · employee's contributions `D421 K455` · income tax `D421 K454[РАЗЧЕТИ:ДАНЪЦИ:…]` |
| paying it | salaries `D421 K503`, in cash `D421 K501` · contributions `D455 K503`, three payments a month · tax `D454 K503` |
| 31.12 | `D611 K604`, `D611 K605` |

So without payroll the ledger is wrong from the first month: 604 and 605 are in the result, and 421, 454 and 455 are open at every month-end. R6 cannot happen without it.

**It runs on data, which helps:**

- **Posting rules** are plain JSON (`docs/payrollAccountingSalaries.json`, three templates): rows of debit, credit, the two analytics and a formula over numbered payroll elements, with the insured-person types to leave out. They also cover what this company rarely uses: civil contracts `602/499`, a partner's own labour `604/498`, garnishments `421/499`.
- **Statutory parameters** are dated tables (`docs/payrollSettings.json`, `payrollMinInsuranceIncomes.json`): minimum wage, lowest and highest insurable income, public holidays, minimum insurable income by КИД and qualification. ⚠ They change inside 2026, on 08-01, as the law does (§7.4). A rate is looked up by date, never by year.
- The programs (`*.pm`) and the database are encrypted, so the calculation cannot be read. It can only be proven by its results, and the results turn out to be very provable (below).

**What it writes:**

| File | What | On disk |
|---|---|---|
| `nap/decl1`, `nap/decl_1_6/…/EMPL2021.TXT` | обр. 1, one row per person per month: 53 CSV fields, CP1251 (§7.4) | 44 months: 2022-06, 2022-07, 2023-04 to 2026-09 |
| `nap/decl6`, `nap/decl_1_6/…/NRA62007_<eik>.txt` | обр. 6, the month's totals: one record of 59 fields, ending in `0x1A` | 42 months |
| `nap/ETZ/…/ETZ*.xml`, `.pdf` | електронен трудов запис, one per event (§7.5) | 18 pairs since 2025-09 |
| `nap/UvedTD/…/UTD62_*.txt`, `Uvedomlenie.{txt,xml}` | the old чл. 62 КТ notification, which ЕТЗ replaced on 2025-06-01 | 15 sets, 2023 to 2025 |
| `nap/SPR73_6/…/SPR73_6.xml` | annual справка по чл. 73, ал. 6 ЗДДФЛ | 4 runs |
| `exports/payrollSalaries_*.xlsx` | the monthly sheet (Разчетно-платежна ведомост) | 40 exports |

13 of the 44 months hold more than one generated version, and nothing on disk says which was filed (§12). One employer: one обр. 1 and one обр. 6 a month for both stores, which is D1's point again.

**It reconciles, as VAT does.** Monthly totals, computed on the PC, compared to the cent:

| Check | Months | Equal |
|---|---:|---|
| обр. 6 contributions = `ЗАП` `D605 K455` + `D421 K455` | 9 | 9 |
| next month's `D455 K503` = обр. 6 contributions | 8 | 8 |
| `ЗАП` `D421 K454` = Σ tax on обр. 1 | 9 | 9 |
| tax on обр. 6 = Σ tax on the previous month's обр. 1 | 41 | 37 |

The ledger rows cover 2023 from April, the one year whose journal has been exported and overlaps the files; E1 extends them. The four misses in the last row are explained: January 2026 equals December's tax at 1.95583 to the cent (the euro), and three Februaries are within 0.02%, where the annual recalculation due by 31 January reaches the next payment (ЗДДФЛ чл. 49; a fit, not yet a proof). ⚠ The tax on a month's обр. 6 is the tax on the **previous** month's salaries, while its contributions are that month's own. So the first обр. 6 LGR produces carries a tax PlusMinus calculated.

**And the calculation can be reproduced from the declaration itself.** Обр. 1 carries each person's insurable income and the percentages, and Н-13 refuses a filing unless обр. 6 equals what they compute to (§7.4). Tested on the PC, with only pass counts printed:

| Rule | Holds in |
|---|---|
| income × percentage, employer's and employee's shares rounded separately, half up, per person, summed per fund = обр. 6's ДОО, ДЗПО and ЗО | **42 of 42 months, all three, to the cent** |
| (taxable income − employee's contributions) × 10% = the declared tax | 99% of person-months. The few others are where reliefs would apply; to be confirmed |
| gross − employee's contributions − tax = the declared net | 72%. In the rest the declared gross is blank or differs from insurable income; to be explained with the accountant |

Every person-month is вид осигурен `01`, a labour contract with one employer. So the engine's core (§6.4) is largely proven before a line of it is written. What remains unproven is the input side: how days and earnings become gross.

**What is used.** The install ships 151 payroll and 79 HR scripts. In 13 months of logs 29 payroll screens were opened, and none of the HR ones:

| Screen | Opens | Release |
|---|---:|---|
| Ведомост за заплати | 110 | P2 |
| Декларации обр. 1 и обр. 6 | 30 | P3 |
| Параграфи НАП (what to pay, per fund) | 30 | P3 |
| Осчетоводяване на заплати (`ЗАП`) | 28 | P2 |
| Удостоверение | 22 | P3 |
| Заповед за уволнение | 21 | P3 |
| Електронен трудов запис | 20 | P3 |
| Трудов договор, Допълнително споразумение | 15, 7 | P3 |
| Издадени документи (register of papers issued) | 12 | P3 |
| Начисляване на ваучери за храна | 12 | P2 |
| Справка по чл. 73, ал. 6, годишно изравняване, служебни бележки | 10, 4, 7 | P3 |
| Статистика, годишна и тримесечна | 13, 3 | later |
| Персонал, Разчети НАП, рекапитулации, Осигуровки за сметка на работодателя, Проверка на МОД | 1 to 4 each | P2 |

### 1.9 LGR's payroll module today

Four models (`Employee`, `PayrollRun`, `Payslip`, `Timesheet`), a UI and tests, written for no country in particular. On prod only demo and e2e orgs hold any of it, so the models can change with no real data to migrate.

| Need | Today |
|---|---|
| Calculation | Two copies. The route that runs (`run.controller.ts`, `/calculate`) sets gross = base salary, with no tax and `employerContributions: []`. `payroll.service.ts#calculatePayroll` uses flat rates from org settings, still no tax, and only tests call it: the suite passes on code that does not run |
| Payslips | `approvePayroll` generates them, but the `/approve` route does not call it: approving a run in the UI produces none |
| Books | `PayrollRun.journalEntryId` exists, nothing writes it |
| Tax, insurable income with its floor and cap, day codes, advance, bank and cash split | None |
| Contract, annexes, КИД, НКПД, insured-person type, class, length of service | A few flat fields on `Employee`, most absent |
| Leave | None. The HR package and its leave models were deleted in `f63e54bc`; `docs/models/hr/` and CLAUDE.md still describe them |
| Files and papers | `payroll.excel.ts` and `payslip.pdf.ts` only |
| Parameters | `settings.payroll`: three undated rates |
| Who sees what | `payroll.read` is all or nothing, and the approve routes check the role by name (§3.11) |

## 2. Decisions

Recommendations, except where marked as the owner's. §12 lists what is decided and what is still open.

- **D1. Books live per legal entity, in a dedicated books org while Accounting and Payroll stabilise, and then move into `regal-pz` and `regal-sf`** (owner, 2026-11-03). A new org (`regal-acc`) holds chart, analytics, entries, partners, VAT and payroll, and the two stores are its branches. Merging the two store orgs is rejected: a large migration of two diverging catalogs for no gain to this FR. ⚠ One EIK has one ledger, one VAT return and one обр. 6, so the move (R7) has a question of its own: what lands in each store org and what stays single. To keep that open, every row carries its branch from the first day (`branchOrgId`), and ids are never reissued. **Decided 2026-11-13 (§12, question 15): split by branch.** Each store org keeps the sales documents of its own series; one of them, the home (`regal-pz`), keeps everything else, the opening and the VAT files included. Payroll's personal data stays in the books org. The stores' ledgers are shares, and the legal entity's books are their sum (§3.1, R7).
- **D2. A single-org tenant is unchanged.** Unset means it keeps its own books, as today.
- **D3. Group costing stays.** Book value of stock is per accounting group at the group's moving average, and inventory keeps its per-product cost. These are two different numbers on purpose, with a report showing the gap. СС 2 allows it where a group's items really are similar (§7.9). SAF-T will want quantities per article from 2029, which LGR has and the current books do not (§7.7). Whether to move to per-product cost later is the accountant's call with the evidence in hand, not a side effect of this work.
- **D4. Import as booked, never recompute history.**
- **D5. The product → group mapping is data, owned by the accountant.** LGR proposes, the accountant confirms. An unmapped product stops only that document's posting, never the sale.
- **D6. Shadow first.** Posted entries go to a separate ledger until two consecutive filed months compare clean. PlusMinus stays the book of record until then.
- **D7. LGR does not file.** It produces byte-exact files and records who filed them, when, and the acknowledgement. No credential for the NRA portal is stored.
- **D8. Payroll moves to LGR, into the books org, by the same path as the books.** Import as filed (P1), calculate beside PlusMinus and compare (P2), produce the files and papers (P3), switch with R6. The ledger needs its result every month, so the books cannot leave PlusMinus while payroll stays.
- **D9. The start of the live ledger is a fiscal-year boundary, 2027-01-01,** unless the accountant wants an earlier month. Payroll starts with the January run: the annual tax recalculation and the annual справка are cleanest that way. If P2's gate is not met by then, payroll can start in any later month, because the year's runs are already imported.
- **D10. Employees' personal data is its own class** (§3.11). One person's ЕГН, pay and sick days need a dedicated permission, are masked by default, and never reach a log, an audit payload, an email, a fixture or a store's server.
- **D11. Scope is what the accountant opens** (§1.8): 29 screens out of 230, and one insured-person type, `01`. The budget-sector, piece-rate, brigade, civil-contract and HR modules stay out until someone asks. A type the engine does not know is refused, never calculated as `01`.
- **D12. No double keying.** During shadow the month's inputs (days by code, one-off amounts) are read from PlusMinus's own output, so the accountant keys payroll once.

## 3. Data model

Everything additive. Every new model calls `replicate(schema, { class: 'R' })`, with `gen:replication-meta` regenerated (`unit/replication-meta.test.ts` fails otherwise), and every new collection joins the org backup bundle. The one exception is `PayrollParameter`, which is global reference data, class `G`.

### 3.1 Org

```ts
settings.accounting.books?: {
  mode: 'own' | 'books' | 'branch'      // unset = 'own'
  booksOrgId?: ObjectId                 // on a branch
  branchCode?: string                   // 'PZ', 'SF': tags what a branch posts
  branches?: { orgId: ObjectId; code: string; label: string; docSeries?: string[] }[]   // on the books org
  externalBranches?: { code: string; label?: string; docSeries: string[] }[]          // on the books org
  split?: { homeOrgId: ObjectId }       // R7: on every org of a split, the same home in each
}
```

**A split (R7).** No books org of its own: every store org of the legal entity is `mode: 'books'`, each with the SAME `branches` (the group, itself included, with their series), the same `externalBranches` and the same `split.homeOrgId`. Each is sent the same files and keeps its share (`journal-plan.ts#ownerOf`): a sales document whose number is in a store's series is that store's, everything else is the home's. `link-books --split --home <slug> [--from <books org>]` writes it; `--from` takes the stores out of a books org of their own, which keeps its copy untouched. An org without `split` behaves exactly as before.

`externalBranches` are the legal entity's stores that sell outside LGR, in a program of their own (§12, question 1): no org, nothing posted, known only by the series their documents' numbers start with. The books carry their documents as the accountant keys them. The register's comparison names those rows by their store instead of counting them missing, and no series may start another, so a number has one owner. `link-books --external <CODE>:<series>` sets them; a re-run that leaves the option out keeps them.

⚠ This is the one place where an org knows about another. It is set by a sys-admin script (`scripts/link-books.ts`), never through an org admin's API, and refuses when the two orgs' `taxNumber` differ. **No request-scoped read crosses orgs:** the tenant guard (`isForeignOrg`) is untouched. Only the posting worker reads a branch's documents. A drill-down from an entry to its invoice is a link that switches the tab's org (FR-19), and works only for a person who is a member there.

### 3.2 `AccountingAnalytic` (new, аналитичен признак)

```ts
{ orgId, path, root, parentId?, name, nameLower,
  kind: 'goods_group' | 'material' | 'product' | 'service' | 'customer' | 'supplier' | 'partner'
      | 'bank_account' | 'expense' | 'income' | 'settlement' | 'personnel' | 'fixed_asset' | 'equity' | 'other',
  unit?, contactId?, bankAccountId?, fixedAssetId?, isActive, deactivatedAt? }
// unique { orgId, path }; { orgId, root, nameLower }
```

### 3.3 `Account`

Add `balanceSide?: 'debit' | 'credit' | 'both'` (411 and 401 run on both sides), `analyticRoots?: string[]` (which trees its lines use; the accountant's `checkjournalentries` config holds this), `quantitative?: boolean`. `type` and `subType` stay; the seed sets them from the first digits.

`Account.balance` is a cache of one number with no date. Statements must stop reading it (R0).

### 3.4 `JournalEntry`

```ts
// header
ledger?: 'books' | 'shadow'       // unset = 'books'; every report filters on it
docType?: string                  // '-ФЕ', '+ФЕ', 'КП', '+ББ' … from a registry, never a literal in code
docNumber?: string
docDate?: Date                    // `date` stays the posting date
vatKind?: string                  // the 'Вид'
branchOrgId?: ObjectId            // whose document this is
sourceOrgId?: ObjectId            // with the existing sourceModule + sourceId
importBatchId?: ObjectId

// each line
opNo?: number                     // pairs a debit line with its credit line. One operation = two lines
analyticId?: ObjectId
quantity?: number
unit?: string
settles?: { docType: string; docNumber: string }[]   // the invoices a bank line pays
```

Indexes: `{orgId, ledger, date}`, `{orgId, 'lines.analyticId', date}`, `{orgId, docType, docNumber}`. Keep lines embedded: 26k documents and 130k operations a year, largest document 245 operations. Reports are aggregations, never `findMany` into memory (a pod OOM is how this repo learned that).

**FR-25a (2026-11): the rest of the document header.** The accountant's database says more of a document than the export this section was built from: how it is paid and how much of it (`paymentCode`, `paidAmount`, `paidCash`), the NRA register's document type that tells a credit notice from an invoice (`registerDocType`), what a notice corrects (`reasonRef`), the VAT rule, rate and exemption ground, the month a late purchase is declared in (`reportingMonth`), the documents it is linked to and what each link settles (`links`), its switches (`docOptions`) and who keyed it when (`source`). Each was verified against the whole journal before it was added; analytics keep the file's own properties (`AccountingAnalytic.params`), contacts their МОЛ (`Contact.representative`), fixed assets their tax side, and the org its representative, place of issue and activity code. The register of every property against ours, the decisions, the deferred items and the UI CRUD plan are in [FR-25a](FR-25a-books-schema-reconciliation.md).

### 3.5 `GoodsGroupCost` (new)

`{ orgId, ledger, analyticId, quantity, value, avgCost, asOf }`, updated by the posting worker: on a debit to 304 add quantity and value, on a credit take `round2(quantity × value / quantity_on_hand)`. One writer per books org, so there is no race to reason about ([the stock-level lost update](https://github.com/gjovanov/lgr/pull/460) is the cautionary tale). A negative on-hand keeps the last average. Rebuildable at any time from the lines.

### 3.6 `ProductGroupMap` (new, in the books org)

```ts
{ orgId, sourceOrgId, productId, analyticId,
  source: 'exact' | 'learned' | 'rule' | 'ai' | 'accountant', evidenceCount, reviewedBy?, reviewedAt? }
// unique { orgId, sourceOrgId, productId }
```

Not a field on `Product`: a product belongs to one store, and the mapping is the books' decision about it.

### 3.7 `PostingRule` (new)

The observed patterns as data, seeded per books org, editable by the accountant, not hardcoded in `auto-journal.service.ts`:

```ts
{ orgId, code, label, isActive,
  match: { docKind, direction?, lineKind?, paymentMethod? },
  operations: [{ debit: accountCode, credit: accountCode,
                 amount: 'net' | 'vat' | 'gross' | 'cost' | 'paid',
                 analyticDebit?: 'contact' | 'group' | 'bank' | path,
                 analyticCredit?: …, perGroup?: boolean }],
  vat?: { register: 'sales' | 'purchase', docTypeCode, vatKind } }
```

The accountant's `typeOperations` (ready-made templates) seed the manual entry screen.

### 3.8 `VatRegisterEntry` (new) and `TaxReturn`

```ts
VatRegisterEntry { orgId, period /* 'YYYYMM' */, side: 'sales' | 'purchase', rowNo, docTypeCode, docNumber, docDate,
                   partnerVat, partnerName, description, cells: Record<string, number>,
                   source?: { orgId, kind, id }, ledger, frozen: boolean }
```

`TaxReturn` gains `cells`, `files: { name, fileId, sha256, bytes }[]`, status `draft | generated | filed | paid | corrected`, `ack?: { number, fileId }`, `supersedesId?`. Rows regenerate while the return is a draft and freeze at `filed`.

### 3.9 Invoice (bills)

`lines[].accountId` exists. Add `lines[].analyticId`, header `vatPeriod`, `vatKind`, `vatDocTypeCode`. Defaults come from the rule, so a sales invoice stays as it is.

### 3.10 Payroll

In the books org. The fields follow what the install keeps per person (the templates of its personnel report use 46).

```ts
Employee {            // existing, additive
  identifierType: 'egn' | 'lnch' | 'service'
  idCard?: { number, date, issuer }, education?, retiree?
  disabled?: { percent, from, to }         // ТЕЛК: changes the tax
  childRelief?: { children, disabledChildren, declaredAt }  // ЗДДФЛ чл. 22в, 22г taken in advance
  isMainEmployer?                          // ЗДДФЛ чл. 45, чл. 49
  insuredAtMaxElsewhere?                   // already at the cap with another employer
  payment?: { method, iban, bic, bank }
}

EmploymentContract {  // new: one employment and its annexes
  orgId, employeeId, number, date, type, ekatte
  startDate, endDate?, position, nkpd, kid, laborCategory, qualificationGroup
  socialSecurityType, healthSecurityType   // the 'вид осигурен' codes on обр. 1
  hoursPerDay, daysPerWeek, statutoryHours, payKind: 'monthly' | 'hourly'
  salary, currency, classPercent, annualLeaveDays
  experienceAtStart: { years, months, days }
  amendments: [{ number, date, effectiveFrom, salary?, currency?, classPercent?, position?, kid?, nkpd?, byLaw? }]
  termination?: { date, basis, orderNumber, compensations: [{ code, amount }] }
}

PayrollParameter {    // new: global, no orgId, class G, like ExchangeRate
  key, effectiveFrom, value, currency?, source   // 'minWage', 'maxInsurableIncome', 'rate.doo.pension.employer' …
}                     // plus the holiday calendar and the МОД table, same shape

PayrollElement {      // new, per org, seeded: what one line of a payslip is
  orgId, code, label, kind: 'days' | 'earning' | 'deduction' | 'employer'
  insurable, taxable, leaveBase, formula?, pmCodes: string[], isActive
}

AbsenceEntry {        // new: where the day codes come from. Sick leave is health data
  orgId, employeeId, contractId, code, from, to, workingDays, document?
}

LeaveBalance { orgId, employeeId, year, entitled, carried, taken }   // new

PayrollRun {          // existing, additive; one per period + kind
  periodCode: 'YYYYMM', kind: 'advance' | 'salary', source: 'engine' | 'imported'
  status: … | 'imported' | 'posted', ledger?: 'shadow', parametersAsOf
  items[]: { contractId, days: Record<code, number>, lines: [{ code, qty?, amount }]
             insurableIncome: { doo, dzpo, zo }, contributions: Record<fund, { employer, employee }>
             taxBase, tax, paidBank, paidCash }
}
```

`Payslip` stays what one person receives, generated at approval from `items`. `Timesheet` is left alone: this company's months run on day counts, and nothing here needs hours.

`PostingRule` (§3.7) gains `match.docKind: 'payroll'` and `amount: { formula }` over element codes, seeded per books org from the install's own `payrollAccountingSalaries.json` by the import: customer configuration, never copied into this repo. The rules' analytics join the tree in §3.2.

`TaxReturn` (§3.8) generalises with `kind: 'vat' | 'decl1_6' | 'etz' | 'art73_6' | …`, so every file has one life: `draft | generated | filed | corrected`, its `files` and its `ack`.

### 3.11 Personal data

Covers `Employee`, `EmploymentContract`, `AbsenceEntry`, `LeaveBalance`, `PayrollRun.items`, `Payslip`, and the extracted files. The employer is the controller; LGR and its operator process on its behalf (§12).

- **Permissions.** `payroll.read` means run totals. A new `payroll.personal` means anything about one person. `payroll.import` and `payroll.file` join them. `member` loses `payroll.read`, the approve routes check the permission instead of a role name, and `accounting.read` sees `ЗАП` and its totals, no person. `manager` holds neither `payroll.approve` nor `payroll.personal` by default: until now only the role name on the route kept it off approval. So `manager` is the plain case of reading totals: a run answers without its `items`, whatever the route, and the app opens on the runs and offers no page about a person. The stored `Manager` sets keep the `payroll.approve` they list, so assigning one grants it. `nra_auditor` gets payroll only by explicit grant. Rollout: deploy → backfill → re-login, as FR-6.2 did.
- **Masked by default.** Lists and gets answer the last digits of an ЕГН and an IBAN, and no ID card. Reading the whole value is a separate call, audit-logged with who and why. An ЕГН is never a login, a URL key or a display identifier (ЗЗЛД чл. 25ж).
- **Encrypted at field level** (owner, 2026-11-03): §3.12.
- **Never in:** logs, audit payloads (an employee number, not a name), `BackgroundTask` results, the digest, the Files app, emails other than a person's own payslip, a report export without `payroll.personal`, `docs/`, fixtures. A flow test posts a run and greps what was logged and audited for the fixture's ЕГН.
- **Stays off the stores.** The books org is homed on global. A home move refuses `settings.accounting.books.mode: 'books'`, so a store's on-prem master (FR-20) never holds this data, and a store admin has no membership in it (D1).
- **Backups and retention.** Org bundles already carry every `tenantPlugin` model, sealed off-site (FR-13). Retention is an allow-list of two collections (`TOUCHABLE`), so nothing here can be pruned by accident. A person's erasure request meets the statutory 50 years (ЗСч чл. 12); the UI says so. If the employer ceases with no successor, ведомости go to НОИ, so they must export in readable form.

### 3.12 Encrypting personal data

**What it answers:** a database dump or an over-broad script, a disk or backup outside the sealed path, a developer's copy of prod. A compromised running app holds the key, so permissions, masking and the audit log are what answer misuse of the app itself.

**Keys, two levels:**

```text
PERSONAL_DATA_KEK              32 random bytes in a sealed secret. Never in Mongo, never in a backup
└─ PersonalDataKey             one row per org, travels with the org and its backups
     keys[]: { keyId, wrapped, status }   the data key (DEK), wrapped by the KEK
     indexKey                  wrapped too: keys the lookup HMAC
     canary                    a known value sealed with the DEK
```

One key per org keeps a leak or a restore inside that org, and destroying one row ends that org's data when its retention is over. Two levels make rotating the KEK a rewrap of a few rows that touches no data.

**A value** is a string: `pd1.<keyId>.<nonce>.<ciphertext+tag>`, AES-256-GCM with a random 96-bit nonce, and `keyId|model|docId|fieldPath` as additional data. So a ciphertext copied to another person or field does not open: someone with database write access cannot redirect a salary by copying their own sealed IBAN onto a colleague's row. Another org simply has no key to try. A restore into another org gives documents new ids, so it re-seals (`personal-data/restore.ts`). The same `node:crypto` AEAD the sealed backups use. The core is import-pure, `services/biz/personal-data/crypto.ts`.

A document's sensitive fields go in one sealed JSON, so adding a field needs no schema change and no migration.

| Model | Encrypted | In clear beside it |
|---|---|---|
| `Employee` | `nationalId`, `taxId`, `dateOfBirth`, `address`, `idCard`, `disabled`, `childRelief`, `salary`'s bank fields, `payment` | `nationalIdMask` (last 4), `nationalIdHmac` for lookup, names |
| `EmploymentContract` | `salary`, each amendment's salary, `termination.compensations` | dates, position, codes |
| `AbsenceEntry` | `code`, `document`: sick leave is health data | dates, `workingDays` |
| `PayrollRun.items[]` | the whole item, one sealed JSON per person, under `engine: 'bg'` | `employeeId`, `contractId`, the run's totals |
| `Payslip` | earnings, deductions, gross, net, year to date, under `engine: 'bg'` | `employeeId`, period, status |
| `TaxReturn.files`, payroll kinds | the file's bytes | name, kind, period |

Names stay in clear: lists and search need them, and alone they say little. `Employee`'s fields are encrypted in every org, because plain ЕГН is no better for a demo tenant; a run's items only under the Bulgarian engine, so D2 holds. Sums over people are done in memory after opening, which this scale allows; a run's totals are stored in clear, as `ЗАП` carries them anyway.

**Nothing decrypts by itself.** Repositories return ciphertext, so a forgotten projection leaks only ciphertext. There are two paths to a value: `forOrg(orgId)` in server code (the engine, the generators), and `POST …/employee/:id/reveal { fields, reason }` for a person, needing `payroll.personal`, with an audit row of who, which fields and why, never the value. That row is written before the answer, and no row means no value.

**A missing or wrong key fails loudly:**

- No KEK: the app starts and everything else works. Personal writes and reveals answer **503 `personal_data_locked`**, never a blank and never plaintext stored instead.
- Startup opens each org's canary. A failure is logged as an error and shown in the morning digest's ops section.
- A restore opens the canary before committing, and refuses a bundle this server's KEK cannot open.
- A home move (FR-20) carries the wrapped keys, so on a target with no KEK the data stays locked, never lost. A books org refuses a home move at all (§3.11).

**Custody.** ⚠ Payroll is kept for 50 years, so losing the KEK loses what the law says to keep. `scripts/personal-data-key.ts` generates it without printing it, stores it in the sealed `lgr-secret`, and writes an escrow copy sealed to the backup's public key (`lgr-sealed-1`), kept beside the private half. Runbook: `docs/guides/personal-data-key.md`.

**Rotation.** New KEK: set `PERSONAL_DATA_KEK_PREVIOUS`, run `rewrap`, remove it. New DEK: add a key id, new writes use it, a `reencrypt` job moves old values, and the old key is retired only when none is left. Values name their key, so both open meanwhile; the job is built when a rotation is first needed. The index key does not rotate, so lookups survive.

**P1's gate includes the drill:** an org backup restored into a throwaway server with the KEK opened from escrow, the canary and a made-up person read back. Plus a raw-collection test: no plain ЕГН in any stored document, log or audit row.

**Rows from before this** are demo and e2e data only (§1.9). A startup sweep seals them once the key is there. Until then they are left alone and counted, and `employeeView` keeps what they hold out of every response.

## 4. Extraction

A new skill, `pull-plusminus-accounting`, beside `pull-plusminus-api`, on the same rules: read-only allowlist, `lgr-api` accounts, never evicts, always disconnects, identifiers from `.secrets`, output outside the repo.

| # | Source | What | How |
|---|---|---|---|
| **E1** | accountant's install | journal for 2025 and 2026 to date; chart with opening balances; analytic trial balance per root; `ap_*` except `ПЕРСОНАЛ`; fixed assets | The GUI export only (`journalReport`, `chartOfAccounts`, `trialBalance`, `readWriteAP`, `fixedAssets`), then a byte-exact copy off `exports/`. **Needs the accountant, or remote desktop when the accountant says the PC is free.** A year is ~150k rows, 8 MB. The file is proven: 2023 parsed whole |
| **E2** | same | `nap/vat/*`, 42 months | File copy. No GUI |
| **E3** | both store servers | `journalEntries(from, to, '', '', '', 'false', '')`: every operation with its product and quantity. `documents` + `document`, `posDocuments`. From ~2025-02 | API, today |
| **E4** | E1 + E3 | Product → group evidence: the same document number on both sides | Offline |
| **E5** (try) | accountant's install | The `saft` report. It writes an `AuditFile` with entries, partners and products in one standard XML. If the install's licence includes it, this replaces half of E1 | One run by the accountant, on one month |
| **E6** | `archive/<day>.arz` | The vendor's nightly backup, which is the whole database: journal, chart, analytics, openings, personnel and salary sheets | Read directly, with no server (as built, below). Written when the accountant closes PlusMinus, ~50 MB. **Sealed on arrival** |
| **E7** | accountant's install | `nap/decl1`, `nap/decl6`, `nap/decl_1_6`: обр. 1 and 6, every month. `nap/ETZ`, `nap/UvedTD`, `nap/SPR73_6`. `exports/payrollSalaries_*` | File copy, no GUI. **Sealed on arrival** (below) |
| **E8** | same | What the files lack, from the GUI: `payrollEmployee` in its templates for positions and classifiers, contracts, and payment details; `hrSalaryChanges`; `payrollEmployeeHistory`; `payrollAnnualLeaves`; the months missing from `payrollSalaries`; `payrollAccountingSalaries` | **Needs the accountant.** Exports, then sealed copies |
| **E9** | same | `docs/payrollAccountingSalaries.json`, `docs/payrollSettings.json`, `docs/payrollMinInsuranceIncomes.json`: no person in them | File copy. The first seeds `PostingRule`. The parameter values are only a cross-check: LGR's table comes from the law (§7.4) |

⚠ What is known not to work: there is no API on the accountant's install, its database files are encrypted (its nightly archive is not: E6), and the store servers hold no books. Do not spend time there.

**As built, 2026-11-05: E6, read without a server.** The plan was to restore the archive into a throwaway `pmserver` if E1 proved too slow. It needs none: the archive is the database gzipped in a simple dump, and `plusminus-archive.ts` reads it directly. Restoring it into the vendor's server was tried on the vendor's empty template and rejected; the skill says why. The skill is `pull-plusminus-books`, not the `pull-plusminus-accounting` named above.
- It fetches the newest archive over `roomler ssh`, sealed on arrival, and writes nothing on the books PC.
- It writes the journal, chart and analytic openings per year and the analytics without `ПЕРСОНАЛ`, already parsed into the shapes `plusminus-exports.ts` gives E1's files. The personnel rows and salary sheets are sealed. The importers take the folder with `--books`.
- It also copies E2's, E7's and E9's files, only those that changed.
- Against E1 and E8 exported from the same state, every artifact is equal, but for the export's own damage (§9, R1) and one salary sheet exported before its month was final. What it does not cover still comes from the GUI: fixed assets, contracts, salary changes, history and leave.
- The GUI's salary sheets held about half of each month's declared people. The archive holds every one, joined to обр. 1 by ЕГН, and equal wherever both have the person-month, that December 2025 sheet aside. P1's months and both years of books were re-imported from it on 2026-11-05, on the owner's word (§9).
- **From 2026-11-05 the books import runs unattended until go-live, on the owner's word.** The skill's `nightly.ts` runs every two hours by day, imports each new archive once, and mails only on a change or a failure. It signs in as a service account whose only right is `accounting.import`. Payroll and VAT stay runs by hand, because which months are filed is a person's to say.
- ⚠ The archive holds the payroll, so it is handled under E7's and E8's rules below.

**E7 and E8 hold ЕГН numbers, pay and sick leave, and carry stricter rules than the rest.** The employer's owner agreed on 2026-11-03 (§12). Everything in §1.8 was read before that, on the PC, by scripts that print shapes and monthly totals (`tools/pay-*.ps1`, `decl-recon*.ts`). A file is sealed with a public key as it arrives (`lgr-sealed-1`, never written in clear), is decrypted only in memory by the import CLI, and is deleted when P1's gate has passed and the accountant has confirmed. Prod is its only lasting home.

## 5. Importing the books (R1)

`POST /org/:orgId/accounting/import/{chart,analytics,opening,journal}`, `accounting.write` plus admin, driven by a CLI with `--dry-run` by default, rehearsed against a throwaway local server first. Each answers with what it would change.

1. **Chart.** Upsert by code. Drop the junk rows PlusMinus accumulates (a `#VALUE!` code, a code that is a stray number), reported, not silent.
2. **Analytics** from `ap_*` and from every path seen in the journal. `КЛИЕНТИ:`/`ДОСТАВЧИЦИ:` link to a `Contact` in the books org, created by EIK/VAT from `ap_КЛИЕНТИ`/`ap_ДОСТАВЧИЦИ` (the existing seed skills' parser). `БАНКОВИ СМЕТКИ:` to `BankAccount` by IBAN. `ДА:` to `FixedAsset`.
3. **Opening balances** as one `type: 'opening'` entry per account and analytic at 2026-01-01, with quantity for goods. Check: the 2026 opening equals the 2025 closing at 1.95583, to the cent, per account.
4. **Journal.** Group the export's rows into documents: a row with no accounts is a document header (date, type, number, total, `Вид`, comment), the rows after it are its operations. Each operation becomes two lines with one `opNo`. Rows with no document become one entry per operation. Comments like `-ФЕ 123,-ФЕ 124` on bank rows become `settles`. Negative amounts stay negative on their side.
5. **Idempotency is per month.** The export has no stable row key, and "Преизчисление" rewrites old values anyway, so a re-import replaces the month's imported entries wholesale and reports the difference (new, changed, gone). Prove it with a dry rerun, never a live one. `Account.balance` is rebuilt once at the end.
6. **Link** an entry to the LGR invoice with the same number where one exists. A convenience, not required.

**History scope:** 2026 to date, and 2025 for the comparatives the annual statements need. 2023–2024 only if the accountant asks: they are in BGN and PlusMinus keeps them. Amounts before 2026-01-01 keep `currency: 'BGN'`, `exchangeRate` to EUR and the rounded `baseDebit`/`baseCredit`, using the line-level balancing `balanceLines` already does.

**Gate, per month and per year, before anything else is built on it:**

- every document balances;
- the synthetic trial balance equals PlusMinus's export **cell by cell**: opening, turnover and closing, debit and credit, per account;
- the analytic trial balance equals it for `СТОКИ:` with quantities, `КЛИЕНТИ:`, `ДОСТАВЧИЦИ:`;
- the main book's correspondences equal `mainbook`.

Results in public say "equal". The figures stay in `_docs/`.

The one person-level analytic in the journal is `ПЕРСОНАЛ:` on 425, the partners' dividends. It imports like any other analytic; `ap_ПЕРСОНАЛ` itself is not needed for the books.

### 5.1 Importing payroll (P1)

`POST /org/:orgId/payroll/import/{employees,contracts,months}`, needing `payroll.import` and `payroll.personal`, driven by a CLI with `--dry-run` by default that decrypts the sealed files in memory. Rehearsed against a throwaway local server with made-up people, then for real.

1. **Employees** from обр. 1's ЕГН and name, upserted by the HMAC.
2. **Contracts** from the ETZ files, the older `UTD62` notifications and E8's exports. A contract with a gap is listed for the accountant, never guessed.
3. **Months.** One `PayrollRun { source: 'imported', status: 'imported' }` per month: days, insurable income, gross and tax per person from обр. 1, then the earnings and deductions of that month's `payrollSalaries` where an export exists. Where a month has several versions, the import takes the one the accountant names.
4. **Link** each run to that month's `ЗАП` from R1.
5. **Idempotency is per month,** as in §5: a re-import replaces the month and reports what changed. Prove it with a dry rerun, never a live one.
6. **BGN before 2026-01-01** stays BGN, with the rate and the rounded EUR beside it. Each contract's salary gets an amendment dated 2026-01-01 for the conversion, marked as the law's, whether or not a paper annex exists.

**History scope:** the 44 months on disk. Older years stay in PlusMinus and its `archive/`; certificates for a former employee may need them (§12).

**Gate, per month:**

- обр. 1 and обр. 6 re-emitted from the imported rows equal the filed files byte for byte, the developer field aside (§7.4);
- the checks of §1.8 hold on every month with a journal, extended by E1, and contributions recomputed from the imported rows equal обр. 6;
- the people and the row counts equal.

## 6. Posting forward (R3–R6)

### 6.1 Product → group

Seeded in this order, each step only for what the last left unmapped, and everything reviewable:

1. **`exact`**: the product's name is a group's name.
2. **`learned`** from E4. For each document in both sources: a one-group document maps every product on it; otherwise a quantity unique on both sides maps that line. A product whose evidence disagrees goes to review with the counts.
3. **`rule`**: stems and the existing fastener tags (`DIN 933`, `ZN`…) as a suggestion.
4. **`ai`**: the name against the group list, as the bill import does for suppliers' wording, a suggestion only.
5. **`accountant`**: a review screen, sorted by sales value, so the accountant's first hour covers most of the money.

The sales side's coverage is not known until E1. Measuring it is the first thing R3 does, and if `learned` turns out weak, the review effort goes up, not the risk.

### 6.2 The worker

`invoice.posted` and friends keep firing in the branch. A worker in the books org:

- resolves each line's group; when one is unmapped the document waits in a **queue** in the accounting app, and nothing in the store is affected;
- applies the matching `PostingRule`, takes cost from `GoodsGroupCost`, writes one entry and its `VatRegisterEntry`;
- runs on the global node only (FR-20: a branch's documents arrive there by replication);
- is idempotent on `(sourceOrgId, sourceId)`, and a void or an edit writes a reversal, never a silent change. ⚠ Documents are editable in every status and an edit does not re-post today (CLAUDE.md, Draft+Issued): the worker has to notice, and a change after filing goes through the correction path, not through the frozen row.

**What posts nothing, as in the books:** a receipt (`СТ`, the `+ФЕ` does it), a transfer between the stores, a stock correction. The corrections are real and invisible to the books, which is one reason the report in D3 exists.

**A till sale that is also invoiced** (CLAUDE.md, Document Import; FR-21; FR-23): the books must count it once. The rule for `КП` is the open question in §12.

**Recalculation.** A backdated document re-costs that group from its date, in open periods only, in the audit log. In a closed period it becomes an adjusting entry in the current one. PlusMinus rewrites silently; LGR does not.

### 6.3 Shadow and the comparison

Everything above writes `ledger: 'shadow'`. The accountant's month keeps arriving by re-import into `ledger: 'books'`. A comparison page and a morning digest section show, per month:

- each sales register row: equal, or why not;
- each group: quantity and cost, books against shadow;
- documents in one ledger and not the other.

**Bar to switch over:** two consecutive filed months with the sales and purchase registers equal and DEKLAR equal; обр. 1 and обр. 6 equal; `ЗАП` equal per account and analytic; cost of sales per month within a tolerance the accountant sets (suggested 0.5%); every difference explained. Then `shadow` becomes `books` from the agreed date, opening from the accountant's closing balances, and the typing stops.

### 6.4 Payroll forward (P2, P3)

**One calculation.** `services/biz/payroll/` replaces both copies (§1.9). Its core is import-pure and deterministic: `calculatePerson(input, parameters) → { lines, insurableIncome, contributions, taxBase, tax, net }`, so a unit test boots nothing, and the route, the importer's proof and the shadow all call the same function. It is chosen by `settings.payroll.engine: 'bg'`. Unset keeps today's generic behaviour, so `acme-corp` and other tenants see no change.

**The order** is §7.4's: days → earnings → insurable income, with floor and cap → contributions per fund, each share rounded per person → tax base → reliefs → tax → net → advance and payment split. Every parameter by date (`parametersAsOf` on the run), never by year.

**Proof before anyone keys anything.** §1.8 already proves the second half: from insurable income on. The inputs of each imported month (days by code, the amounts that are not derived) then go through the whole engine, and the result is compared with what was filed: per person, per fund, per month, to the cent or explained, over all 44 months. The tool lives outside the repo and prints counts. A month that cannot match, such as one under a rule LGR does not implement, is listed with its reason.

**Shadow.** While PlusMinus is live, its output feeds each new month's inputs (D12), the engine calculates, and `ЗАП` posts to `ledger: 'shadow'` through `PostingRule`. The comparison page (§6.3) gains a payroll block: per fund and per account, books against shadow. Per-person differences need `payroll.personal`.

**After the switch.** Calculated → approved (`Payslip`s generated, on the one path) → posted (`ЗАП`) → paid. The bank's lines settle 421, 455 and 454 through R5's rules. A correction is a new run for the same period, with the declaration's correction code; a filed run is frozen, like a filed VAT row. The annual recalculation, due by 31 January, is its own run kind and needs the whole year's items, which is why those are imported per person.

## 7. Filings

The law was read on 2026-11-02 from consolidated texts (lex.bg, kik-info.com, which reproduce the official ones; sources in §7.10). ⚠ nra.bg answered automated requests with a CAPTCHA, so what lives only there is marked **unread**. Anything marked **unverified** rests on a vendor or a search summary. This is an implementer's reading, not legal advice: the accountant confirms it before R2 and P3.

Across the whole section LGR produces and a person files (D7).

### 7.1 VAT return: DEKLAR, PRODAGBI, POKUPKI

ППЗДДС Приложение № 12. Due by the 14th of the next month, electronically, a nil return too (ЗДДС чл. 125(4), (5), (7)). The tax is paid by the same day (чл. 89(1)).

CP1251, fixed width, no separators, CRLF after every record. Text is left-aligned, numbers right-aligned with `.` and an optional minus, unused positions are spaces. **A zero is blank.** DEKLAR is one record. A register with no documents has no records.

| File | Bytes per record | Fields, widths in brackets |
|---|---:|---|
| DEKLAR | 590 | 00-01 VAT id (15), 00-02 name (50), 00-03 period (6), 00-04 filer (50), 00-05 sales rows (15), 00-06 purchase rows (15); then 15 each: 01-01, 20, 11, 21, 12, 22, 23, 13, 24, 14, 15, 16, 17, 18, 19, 30, 31, 41, 32, 42, 43; 01-33 coefficient (4); then 15 each: 01-40, 50, 60, 70, 71, 80, 81, 82 |
| PRODAGBI | 424 | 02-00 VAT id (15), 02-01 period (6), 02-02 branch (4), 02-03 sequence (15), 02-04 type (2), 02-05 number (20), 02-06 date (10), 02-07 partner id (15), 02-08 name (50), 02-09 goods or service (30); then 15 each: 02-10, 20, 11, 21, 12, 26, 22, 23, 13, 24, 14, 15, 16, 17, 18, 19, 25; 02-27 code (2) |
| POKUPKI | 274 | the same ten leading fields, numbered 03-02, 03-01, 03-03…03-10; then 15 each: 03-30, 31, 41, 32, 42, 43, 44; 03-45 code (2) |

The cells this company has ever used:

| Cell | Meaning | In DEKLAR |
|---|---|---|
| 02-10, 02-20 | total base, total VAT | 01-01, 01-20 |
| 02-11, 02-21 | 20% base, VAT | 01-11, 01-21 |
| 02-12 + 02-26, 02-22 | ВОП and чл. 82 base, VAT | 01-12, 01-22 |
| 02-23 | VAT on personal use | 01-23 |
| 02-15 | 0% ВОД base | 01-15 |
| 02-19 | exempt base. ⚠ Outside 02-10 and 01-01 | 01-19 |
| 03-30 | purchases with no credit right | 01-30 |
| 03-31, 03-41 | full credit base, VAT | 01-31, 01-41 |
| | total credit = 41 + 42 × 33 + 43 | 01-40 |
| | payable, or refundable: the difference of 01-20 and 01-40 | 01-50, 01-60 |
| | payable, actually paid (equal to 01-50 in all 42) | 01-71 |

Document types: `01` invoice, `02` debit note, `03` credit note, `07` customs, `09` protocol or other, `11`–`13` the same under cash accounting, `23`, `29` чл. 126б, `81` sales report, `82` sales report under special taxation, `91`–`95` protocols, `04`, `05` call-off stock, `50`, `83`–`85` compensation reports. In 42 months this company used sales `01 02 03 09 81` and purchases `01 02 03 07 09`.

**What the generator has to hold** (Annex 12, ЗДДС чл. 124, чл. 126):

- Rows run 1..n by the sequence field, no gaps. The filed files also sort by date, which looks like the vendor's choice.
- All value cells of a record share one sign, or the file is refused.
- DEKLAR's totals exclude sales types 11, 12, 13, 04 and purchase types 11, 12, 13, 94, 05.
- A document cancelled in its own period has blank values; in a later period, the original values with the opposite sign.
- A foreign person with no registration, or an individual the supplier need not identify, is `999999999999999`.
- A purchase document may enter any of the 12 following periods; a credit note enters the period of its issue. So `vatPeriod` is per document (§3.9).
- A correction before the deadline is a re-filing. After it, a missed document enters the period it is found in, and a wrongly entered one needs a written notice to the revenue body (`TaxReturn.supersedesId`).

**Proven on what is on disk, all 42 filed months:** 74,188 records in 126 files parse into these fields and re-emit **byte-identical**. Every cell rule above holds in 42 of 42. 197 purchase rows are dated outside their period, the oldest 10 months back. 64 rows are blank, as the annex says for a same-period annulment. 469 rows are negative, and none mixes signs. So R2's work is in getting the cells right, not the format.

**The euro.** Filed files for 2026 carry EUR in the same layout, and all nine pass the round trip. A draft amendment (№ 12153-K) rewrites the annexes' currency words and two labels, with no change of width I could find. I found no evidence it was adopted; **unverified**.

### 7.2 VIES

ППЗДДС Приложение № 15. Same deadline, required for ВОД, triangular supplies, чл. 21(2) services and call-off stock; ВОП does not trigger it. CP1251, fixed width (or CSV with `;`), records `VHR` period and count · `VDR` declarant · `VTR` the company · `TTR` totals · `VIR` one per recipient, with `CHR` and `COS` for call-off stock.

On disk: 9 files, the 9 months with a non-zero 02-15 and no others. Every record has the annex's length, the count in `VHR` equals the `VIR` rows, and `TTR` equals the sum of `VIR` and the month's 02-15. It costs little, so the generator joins R2.

### 7.3 Intrastat

Per flow, against a threshold set by the NSI each year. 2026: arrivals EUR 899,874, dispatches EUR 1,150,407 (order РД-05-665). 2027: arrivals EUR 900,000, dispatches EUR 1,100,000 (order РД-05-640 of 2026-10-06, through a republished notice). Due by the 14th, the 20th for a first period, through the NRA's e-services with a qualified signature. The accountant confirms whether the company is above either. Nothing is generated until it is; it is in Later.

### 7.4 Payroll: обр. 1, обр. 6 and the calculation

Наредба № Н-13 от 17.12.2019, which repealed Н-8; last amended ДВ 90/2026. The file structure is set by order of the NRA's executive director, and NRA's client (now v18.08) validates it.

- **Deadlines.** Обр. 1, and обр. 6 for contributions: by the 25th of the next month. Обр. 6 for tax under ЗДДФЛ чл. 42: from the 1st to the 25th of the month after withholding, when it is also paid (ЗДДФЛ чл. 65(11)). Tax under чл. 49(5): by 25 February.
- **Channel.** Above 10 insured persons a month, online only with a qualified e-signature (чл. 8(2)). Whoever holds the signature can be authorised (чл. 10).
- **Corrections.** Code `К` corrects and `З` deletes. Month, year, ЕГН and вид осигурен cannot be corrected: delete and refile. None after 30 April of the next year without permission. On обр. 6 `К` only reduces; an increase is a new declaration with the positive difference. A correction of обр. 1 that changes contributions goes with a matching обр. 6 (чл. 9).
- **The check.** Each month's liability on обр. 6 must equal the contributions computed from обр. 1: income × percentage, employer and employee separately, each rounded separately, summed per liability (чл. 2(4), § 2). The filing is refused otherwise (чл. 11(2)). The rounding rule is in чл. 3 of the ordinance adopted by ПМС 175/2018, still **unread**. Its predecessor's чл. 2а, [as quoted here](https://trudipravo.bg/izbrani-statii/novoto-v-naredba-n-8-i-podavaneto-na-danni-ot-rabotodatelite-za-osigurenite-pri-tyah-litza-kakto-i-ot-samoosiguryavashtite-se-litza/), works per person and on decimal digits: a third decimal of 0–4 leaves the second alone, 5–9 adds one. Half up matched all 42 months (§1.8). ⚠ That is a rule about decimal digits, so the engine does it in integers: rounding a double can land a tie on the wrong side.

| | `EMPL2021.TXT`, обр. 1 | `NRA62007.TXT`, обр. 6 |
|---|---|---|
| Spec | NRA, for data after 31.12.2020, published 2021-03-05 | NRA, 2013-01-02, still citing Н-8 |
| Shape | CSV, 53 fields, a row per person and вид осигурен | CSV, 59 fields, one record |
| Text | Windows-1251, CR LF, double-quoted uppercase Cyrillic, no comma or quote inside | same |
| Empty number | `0`. The vendor writes `0.00` | stays empty |
| End of file | Ctrl+Z in the spec. The files on disk have none | Ctrl+Z, also on disk |

Обр. 1's fields: 1 month, 2 year, 3 employer, 4 ЕГН, 5 its kind, 6 surname, 7 initials, 8 вид осигурен, 9–18 from and to days ×5, 19 total days, 20 worked, 21 incapacity, 22 childcare, 23 without contributions but counted as service, 24 unpaid leave counted as service, 25 employer-paid sick days, 26–27 hours, 28 qualification group, 29 КИД, 30 employer's main activity row, 31 summed-time code, 32–33 ЗО base and % during sick leave, **34 insurable income**, 35–36 ДОО % employer and employee, 37–38 ЗО %, 39 ТЗПБ %, 40 УчПФ %, 41 ППФ %, 42–43 УПФ %, 44–45 health-only base and %, 46 gross, 47 ГВРС %, **48 taxable income, 49 tax**, 50 net, 51 каса code, 52 correction `0 | 1 | 8`, 53 developer's EIK.

Обр. 6's fields: 1 employer, 2 name, 3 каса member, 4–6 contact, then four columns of 13 (month, year, payment date, change flag, payment type, ДОО, УчПФ, ДЗПО УПФ, ДЗПО ППФ, ЗО, ГВРС, tax withheld, advance tax), 59 каса or developer. Payment types under Н-13: `5` the month's pay, `6` additional income after the 25th, `4` no labour contract, `8` withheld tax, `9` чл. 49(5). ⚠ The 2013 spec does not list `8`. On disk, the first column is the contributions and the second the tax.

Both specs are old and disagree with the ordinance in places, so **the NRA client is the arbiter** (P3's gate runs it). Whether the portal accepts the vendor's `NRA62007_<eik>.txt` over the spec's name is unverified.

**2026's parameters.** ЗБДОО 2026 (ДВ 68/28.07.2026) applies from 01.01.2026, after an extension law, with **two periods**:

| | 01.01–31.07 | 01.08–31.12 |
|---|---:|---:|
| Highest insurable income | €2,111.64 | €2,300.00 |
| Lowest, self-insured | €550.66 | €620.20 |
| Minimum wage (ПМС № 243/2025; after August through a vendor summary) | €620.20 | €620.20 |
| Minimum by КИД and qualification group (86 rows, nine columns) | Annex 1 | Annex 1А |
| ТЗПБ by activity | Annex 2 | Annex 2А |

For employees the working floor is at least the minimum wage (КТ чл. 245; NRA opinion of 12.01.2026). A partial month is pro rata. The annexes speak of КИД-2025 while Н-13 still says КИД 2008, and НКПД changed on 01.01.2026: which code set field 29 expects is unverified.

| Rates, third category, labour contract, % | Total | Employer | Employee |
|---|---:|---:|---:|
| Пенсии, born before 1960 | 19.80 | 11.02 | 8.78 |
| Пенсии, born from 1960 | 14.80 | 8.22 | 6.58 |
| Общо заболяване и майчинство | 3.50 | 2.10 | 1.40 |
| Безработица | 1.00 | 0.60 | 0.40 |
| ДЗПО УПФ, born from 1960 | 5.00 | 2.80 | 2.20 |
| Здравно осигуряване | 8.00 | 4.80 | 3.20 |
| ТЗПБ | 0.4–1.1 | all | |
| ГВРС | 0 in 2026 | | |

(КСО чл. 6, чл. 157; ЗБНЗОК чл. 2; ЗБДОО чл. 14, 15.)

**Income tax,** ЗДДФЛ чл. 42: taxable income accrued for the month, less the employee's contributions, less ТЕЛК relief (чл. 18: 660 лв. a month in the statute, about €337.45 by conversion; no official figure found), less voluntary-insurance relief, less child relief where a one-time declaration asks for it in advance (NRA: €255.65 a month for one child, €511.29 for two, €766.94 for three or more, in 2026), × 10%. The main employer at 31 December recalculates the year by 31 January, on documents received between 30 November and 31 December (чл. 49). A служебна бележка within 14 days on request (чл. 45); its current form is **unread**.

**Sick pay and leave.** The employer pays the first two working days at 70% (КСО чл. 40(5)), and they go in day field 25 and inside insurable income. НОИ pays from there, on a certificate (Приложение № 9) due by the 10th of the next month (КСО чл. 40а). Leave pay comes from the last month with at least 10 worked days (КТ чл. 177), and unused leave is paid out at termination (чл. 224). Class supplement: НСОРЗ чл. 12. ⚠ ДВ 69/2026 rewrote the rule for стаж (КТ чл. 355). [Решение № 17 of 20.10.2026](https://www.constcourt.bg/bg/act-10456), к.д. № 15/2026, declares unconstitutional, in the text § 11 gave it: ал. 1 in the part „часове,“; ал. 2; ал. 3 in the part „всички работни дни за съответния месец“; ал. 4. The operative part says nothing on past periods or on which text applies after it. So стаж is never counted in hours, and the class supplement stays an input amount, proven against the filed months, until the accountant confirms the rule.

**The euro in payroll.** Wages, benefits and pensions round **up** on any non-zero third decimal, per pay element: 1,000 лв. is €511.30, not €511.29 (ЗВЕРБ чл. 45; state FAQ). That includes amounts set in BGN and paid later. Deductions and food vouchers use the general rule, and so do statutory thresholds. A leva period's sheet stays in leva, and back-pay for it is declared in leva and paid converted (чл. 50). What the rule means for a salary set in EUR from the start, and for КТ чл. 224 compensation, is **unverified**.

### 7.5 Other payroll filings

**Електронен трудов запис** replaced the чл. 62 notification and the labour book on 2025-06-01 (КТ чл. 62(3)–(5); Наредба за вписване в регистъра на заетостта, ПМС № 267/2024). So LGR never generates a `UTD62`: it only reads the old ones. Format: заповед № З-ЦУ-30-1072/22.06.2026, XSDs `etz_employ_restrict.xsd` and `etz_123_employer.xsd`, Windows-1251, one employer per file, recommended names `ETZ<eik>.XML` and `ETZ123_<eik>.XML`. The tags on the 18 filed files match Приложение № 1.

| Event | Deadline |
|---|---|
| Contract concluded, or a change of basis, term, basic pay, НКПД, КИД, place, working time or agreed leave | 3 days |
| Start of work | **before the employee starts** |
| Termination, compensation under КТ чл. 222(2), (3) | 7 days |
| Change of employer | 10 days, by the new one (Приложение № 2) |

Filed through the NRA portal with a qualified signature or ПИК. An amendment in `EmploymentContract` is what starts the 3-day clock, so the contract screen shows what is due. To change a key field: delete (`2`), then file new (`0`). Experience goes as `ГГММДД` at termination, and days of leave used that year are required. The code lists are in that ordinance's annexes.

**Справка по чл. 73, ал. 6 ЗДДФЛ:** by 28 February, electronic only, XML named `SPR73_6`, Windows-1251, XSD `dec73_6_publish.xsd`; corrections until 30 September. The tags on disk match. **Чл. 73а(5):** income paid to residents of other EU states, by 30 April, if any.

**Open reading before P2 and P3,** each a short job:

1. Run NRA's client v18.08 over generated files: file names, payment type `8`, field 5's values.
2. What applies to стаж after Решение № 17/2026 (§7.4): with the accountant. The decision itself is read.
3. ПМС 175/2018 чл. 3, on rounding. The predecessor's text is read and the rule fits all 42 months (§7.4), so this confirms rather than decides.
4. КИД-2025 or КИД 2008 in the files. For the minimum insurable income, [NRA's 2025 handbook](https://kik-info.com/files/naruchnik-osiguriavane-2025/FISH-I.I.8.1.pdf) uses КИД-2008 to 31.03.2025 and КИД-2025 from 01.04.2025. Nothing read says the same of field 29, so NRA's client decides.
5. НОИ's Приложение № 9 schemas, if LGR is to produce it (§12).
6. ЗДБРБ 2026's own text on child relief, and an official euro figure for ТЕЛК relief.
7. СС 19 on accruing unused leave, and the minimum class percentage: with the accountant.

### 7.6 Annual: tax return, statements, statistics

- **ГДД по чл. 92 ЗКПО:** filed 1 March to 30 June of the next year, electronically, and the tax is paid by 30 June (чл. 7(2), чл. 92(2), чл. 93(1)). The form and its XSD are on nra.bg, **unread**; "form 1010" comes from a vendor, **unverified**.
- **Advance corporate tax:** monthly when net sales of the year before last exceed 3,000,000 лв. (ЗКПО чл. 84), otherwise quarterly (чл. 85), none at or under 300,000 лв. (чл. 83(2)). Declared 1 March to 15 April, changeable until 15 November (чл. 87а, чл. 88). Monthly payments: January to March by 15 April, then by the 15th of each month, December by 1 December (чл. 90).
- **Статистика:** the Годишен отчет за дейността goes with the return, by 30 June, through ИС „Бизнес статистика" with a qualified signature (ЗКПО чл. 7(3), чл. 92(3); NSI).
- **Годишен финансов отчет:** the size category (ЗСч чл. 19: two of assets, net sales, staff, and it changes only after two consecutive periods) decides which statements apply (чл. 29) and whether an audit is required (чл. 37). Publication in the Търговски регистър by 30 September (чл. 38). In thousands of EUR (чл. 23). The accountant knows the category.
- **The first statements in EUR are for 2026,** published by 30 September 2027, with 2025 restated at the fixed rate (guidance on evroto.bg; I did not read that chapter of the Euro Act). One more reason §5 imports 2025.
- **`balans`, `opr`, `opp`, `osk`, `dand92`** read as баланс, отчет за приходите и разходите, за паричните потоци, за собствения капитал, and ГДД. That is from the names; the files were not opened for this.

These stay in PlusMinus through 2026's close. With a switch at 2027-01-01, the first year LGR must close is 2027. They are in Later, and R1's gate already proves the trial balance they would be built on.

### 7.7 SAF-T

ДОПК чл. 71з–71к. A monthly `AuditFile` by the end of the next month, except fixed assets (by the ГДД's deadline) and stock (on request, by a date the NRA sets). Penalties from 5,000 лв. (чл. 277а). Waves, § 17 ПЗР ЗДБРБ 2025:

| From | Who |
|---|---|
| 2026-01-01 | large at 31.12.2023, and net sales over 300M лв. or net receipts on NRA accounts over 3.5M лв. in 2023 |
| 2027-01-01 | large, medium or small at 31.12.2024, same amounts in 2024 |
| 2028-01-01 | large, medium or small at 31.12.2025, and net sales over 15M лв. **or receipts over 1.5M лв.** in 2025 |
| 2029-01-01 | large, medium or small at 31.12.2026, no amount |
| 2030-01-01 | everyone else obliged |

**This company: 2029-01-01,** first file due 28 February 2029. An estimate from the filed files puts its 2025 receipts well below the 2028 test, and the NRA account statement decides it (§12). There are no first-months' holidays for these waves, and corrections stay open for 12 months.

The format: XSD 1.0.1, namespace `mf:nra:dgti:dxxxx:declaration:v1`, read from a third-party copy. Version 1.0.2 and its order are reported by vendors, **unverified**. The filing requirements (Annex 3) are **unread**. Corrections must match the XSD current when they are filed.

**What it decides here, read from the structure workbook and the NRA's March 2026 answers:**

- **Quantities are per article, not per group.** A movement or invoice line "задължително" carries the code of the product (артикул) from the company's system, stock is per warehouse with an 8-digit CN code, and `ProductGroup` is a separate optional attribute. A group spanning several CN codes cannot carry a correct one. Nothing I read forbids a group as the product in so many words, but I would not build on that.
- **Value may still be the group's.** The NRA leaves valuation to the accounting policy and СС 2. Articles priced at their group's average fill the fields, and `ValuationMethod` says so. Whether stock values are checked against 304 is in Annex 3, unread.
- **So LGR is better placed than the books it replaces:** it holds the articles and their warehouses, and `ProductGroupMap` supplies the value. Add `Product.cnCode` (23k and 26k articles need one; `0` where none applies) and `Account.nraCode`: accounts go in at the lowest analytic level, mapped to the NRA's nomenclature.
- **Aggregated entries are fine with traceability:** a `КП`, and sales with no mandatory invoice, may be aggregated when each summary traces to its documents.
- The vendor's `saft` report (E5) shows what the current install can produce.

### 7.8 E-invoicing

⚠ A draft, not law. A draft ЗИД на ЗДДС (consultation reportedly 23 September to 23 October 2026; its status since is unknown) would bring, from **2028-01-01**: structured e-invoices for domestic B2B, reported to the NRA in real time (чл. 120г), an invoice counting as issued only once a compliance code exists (чл. 120а(3)), a CN code on each line (чл. 120а(2)), and an end to filing the registers, with the NRA preparing the return instead (§ 44, § 45). The penalty applies from 2028-07-01. Directive (EU) 2025/516 (ViDA) lets member states mandate this now, and from 2030-07-01 makes e-invoices the rule, with other forms allowed only outside its new intra-EU reporting.

If it passes, it changes this plan in three ways. The register generators have a short life for domestic periods, though they stay this plan's proof of the books and they are cheap. D7 cannot hold for invoices, because the software talks to the NRA. And `Product.cnCode` is due a year before SAF-T. That is a separate FR, once there is a law.

### 7.9 Accounting law this plan leans on

- **Chart.** ЗСч asks for an individual chart approved by the head of the enterprise (чл. 11(1) т. 5, чл. 16(1) т. 1), and does not mention a national one. So the imported chart is legitimate as it stands. The accountant confirms no other regulation applies.
- **Group costing (D3).** СС 2 has no clause on grouping. Its hook is one word, in т. 9.2(б): the weighted average is of „сходни" stock, and „може да бъде изчислена на периодична основа или след всяко постъпление". So a moving average per group is allowed outright, and holds only where the items really are similar, in one unit of measure. The policy must be written, approved and disclosed (ЗСч чл. 11(1) т. 6, СС 2 т. 12(а)), and net realisable value still tested (т. 11). A very broad group is what an auditor would ask about (§12).
- **Retention.** Payroll 50 years; registers and statements 10; other carriers 3 (ЗСч чл. 12(1)) or 5 (ДОПК чл. 38(1)); VAT documents 5 years after the limitation period (ЗДДС чл. 121(1)). Take the longest that applies. Technical carriers are allowed (ЗСч чл. 4(5), чл. 12(1)).
- **Changing system.** ЗСч has no rule on it. It is a management decision (чл. 16(1) т. 3), on condition that chronology and traceability survive the cut and the old registers stay reproducible for ten years. So R6's gate includes the head's written decision and an updated accounting policy, and PlusMinus stays readable.
- **The euro.** Divide by the full rate and round to two decimals (Euro Act чл. 12–13). Wages round **up** on any non-zero third decimal (чл. 45). Balances are recalculated item by item at the changeover, and quantity items per unit (чл. 48). Bookkeeping is in EUR.

**⚠ Two things LGR does today that a system of record may not.** Neither matters while PlusMinus is the book of record, and both must be settled for R6, in `branch` mode only:

1. **ЗСч чл. 8:** „Поправки и добавки в първичните счетоводни документи не се допускат": a wrong document is annulled and a new one issued. LGR's issued documents are editable in every status, by a decision (CLAUDE.md, Draft+Issued). The owner's answer, 2026-11-03: from R6, a `branch` org (`regal-pz`, `regal-sf`) cannot edit an issued document, and the form offers annul and re-issue. Other tenants keep today's behaviour.
2. **ЗДДС чл. 114(1) т. 2, ЗСч чл. 6(1) т. 1:** a ten-digit number of Arabic digits only. LGR's counters print `INV-2026-…`, and imports keep `INV-` in front of the ten digits. The printed number, and 02-05, must be the digits alone, and one system must own each series (today's counter sits inside PlusMinus's range).

### 7.10 Sources

[ЗДДС](https://lex.bg/laws/ldoc/2135533201) · [ДОПК](https://lex.bg/laws/ldoc/2135514513) · [ЗКПО](https://lex.bg/laws/ldoc/2135540562) · [ЗСч](https://kik-info.com/normativna-baza/zakoni/zsch/) · [ППЗДДС](https://kik-info.com/normativna-baza/pravilnici/ppzdds/) · [СС 1](https://kik-info.com/normativna-baza/nss/0X2135501601/) · [СС 2](https://kik-info.com/normativna-baza/nss/0X2135501610/) · [Euro Act, ДВ 70/2024](https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=224950) · [NRA, SAF-T questions and answers, March 2026](https://kik-info.com/forum/index.php?action=dlattach;topic=39012.0;attach=9473) · [SAF-T XSD and workbook, third-party copy](https://github.com/IvanNIvanov/BG-SAFT-Schema) · [NRA, Intrastat](https://nra.bg/wps/portal/nra/intrastat) · [Intrastat 2027 notice](https://kik-info.com/novini/nap/Vazhno-za-targovtsite-koito-osashtestvyavat-vatresayuzna-targoviya-sas.15344.php) · [draft № 12153-K](https://www.strategy.bg/bg/public-consultations/12153) · [NSI, annual report](https://www.nsi.bg/pages/godishen-otchet-za-deinostta-na-nefinansovite-predpriyatiya-sastavyashti-balans-prez-2025-godina-856) · [euro guidance on accounting](https://evroto.bg/upload/810/Nasoki%20schetovodstvo.pdf) · draft ЗИД на ЗДДС: [act](https://www.strategy.bg/download/1327069), [motives](https://www.strategy.bg/download/1327071) · [ViDA, Council text](https://data.consilium.europa.eu/doc/document/ST-15342-2024-INIT/bg/pdf)

Payroll: [Наредба № Н-13](https://www.tita.bg/laws/669) · [Наредба за регистъра на заетостта](https://www.tita.bg/laws/898) · [КСО](https://kik-info.com/normativna-baza/kodeksi/kso/) · [КТ](https://kik-info.com/normativna-baza/kodeksi/kt/) · [ЗДДФЛ](https://kik-info.com/normativna-baza/zakoni/zddfl/) · [ЗЗЛД](https://kik-info.com/normativna-baza/zakoni/zzld/) · [НПОПДОО](https://kik-info.com/normativna-baza/naredbi/npopdoo/) · [НСОРЗ](https://kik-info.com/normativna-baza/naredbi/nsorz/) · [ЗБДОО 2026](https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=244982) · [ЗБНЗОК 2026](https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=244981) · [НОИ on 01.08.2026](https://nssi.bg/dohod01082026/) · [NRA, обр. 1, 3, 6](https://nra.bg/wps/portal/nra/Programni-produkti/Programni-produkti-za-obhvashtane0-na-danni-ot-deklaracii-ob1-ob3-ob6) · [NRA, ЕТЗ](https://nra.bg/wps/portal/nra/Programni-produkti/Elektronni_trudovi_zapisi) · [NRA, справки](https://nra.bg/wps/portal/nra/Programni-produkti/Spravka-za-izplateni-dohodi-na-fizicheski-lica/spravka-za-izplateni-dohodi-na-fizicheski-lica) · [NRA, child relief](https://nra.bg/wps/portal/nra/taxes/godishen-danak-varhu-dohdite/Danuchni_oblekchenia_za-deca) · [NRA opinion of 12.01.2026, reprinted](https://kik-info.com/novini/novini-i-akcenti/NAP-publikuva-stanovishte-po-prilagane-na-osiguritelnoto-zakonodatelstvo.205593.php) · [state euro FAQ](https://evro.egov.bg/faq)

## 8. The accounting app

New, in the existing app and on the report registry where it fits (FR-06): **Оборотна ведомост** (synthetic and analytic, six columns, quantities), **Главна книга** (correspondence), **Хронологична ведомост**, **Журнал на документите**, **Отчет по журнал**, analytics tree, group mapping review, posting queue, shadow comparison, VAT period screen (rows, cells, generate, download, mark filed), period lock, recalculation, import wizard, stock value by group against by product.

Changed: the entry form gains analytic and quantity per side, and pairs operations; statements read from entries, as of a date.

**Payroll**, in the existing `payroll` views: employee with masked fields and a contract tab with its annexes; absences; the month's sheet as a grid, with day codes and one-off amounts editable and the rest calculated; run statuses; a declarations screen sharing the VAT screen's generate, download and mark-filed flow; the papers of §1.8 as PDFs in the house style, with a register of what was issued; reports through the registry: рекапитулация, Осигуровки за сметка на работодателя, Разчети НАП, Параграфи НАП, leave balances. The file import keeps a person's data on the screen only for someone holding `payroll.personal`.

Labels and i18n ×4 (en/bg/de/mk), account and report names in Bulgarian as data. New permissions `accounting.import`, `accounting.file`, `accounting.close`, and `payroll.personal`, `payroll.import`, `payroll.file`: ⚠ a JWT carries what it was issued with, so the rollout is deploy → backfill → re-login, as FR-6.2 did. `nra_auditor` reads the accounting side; payroll by explicit grant (§3.11).

## 9. Releases

Each is deployable alone and each has a gate. No release turns anything on in a store org.

| | Content | Gate |
|---|---|---|
| **R0** | Repairs, below. Independent of everything else | Tests + `bun run test` |
| **R1** | §3.1–3.4 models, books org, E1–E3, §5, Оборотна ведомост, Главна книга, Хронологична, Журнал | §5's gate, to the cent, 2025 and 2026 to date |
| **R2** | Filed files as `VatRegisterEntry`, generators (VIES included), cell logic, VAT screen | 42 filed months regenerate equal (§7.1), and the 9 VIES files (§7.2) |
| **P1** | §3.10–3.11 models and personal-data controls, E7–E9, §5.1, payroll reports. Needs the books org from R1 | §5.1's gate over 44 months, the personal-data flow test, and the key drill (§3.12) |
| **R3** | §3.5–3.7, mapping + review, worker, shadow for sales and till, comparison | Sales register equal for a filed month, except the rows §12 explains |
| **R4** | Purchases in LGR: bills through the existing OCR pipeline, expense analytic, VAT period, protocols (`-П`), customs | Purchase register + DEKLAR equal for a filed month |
| **P2** | The engine, `PayrollParameter`, `PostingRule` for `ЗАП`, the month's sheet, payroll in the comparison | §6.4's proof over 44 months, then `ЗАП` equal per account and analytic for two running months |
| **R5** | Bank import with the accountant's rules (`bankImportRules`, 12 banks' formats), `settles`, cash book | Bank and cash ledgers equal for a month |
| **P3** | обр. 1 and 6, ЕТЗ, чл. 73(6), служебни бележки, annual recalculation, Параграфи НАП, contract papers, leave | Each file equal to the last filed one, the annual ones on last year's data, and accepted by NRA's client (§7.4) |
| **R6** | Amortization, month-end VAT entries, year-end close, period lock, the two conflicts of §7.9, switch over, payroll included | §6.3's bar, the head's written decision and updated policy (§7.9), then the accountant's say-so |
| **R7** | The books move from `regal-acc` into `regal-pz` (the home) and `regal-sf`, split by branch (D1, §12 question 15): rebuilt by the importer from the archive into each org, not moved, so `regal-acc` stays as the rollback copy. Payroll's personal data stays in `regal-acc`. The test-org copies never carry a books-holding org's books. Runbook: `docs/guides/books-split-rollout.md` | Per org: the dry rerun unchanged, and the shares adding up to the file. The group: §5's gate over the summed books (`compare-accounting-books.ts --org <home> --org <store>`), the same verdict as `regal-acc`'s; no copy of the books in a test org; then the owner's say-so |
| Later | ГДД and annual statements fully from LGR, SAF-T with `cnCode` and `nraCode` (due 2029, §7.7), e-invoicing (if it passes, 2028, §7.8), Intrastat, NSI statistics | |

R1, then R2 and P1 in parallel, then R3. R4 and P2 can run side by side, then R5 and P3. Nothing in P1–P3 touches a store org.

### P1 and the engine of P2, as built

The models of §3.10, sealed per §3.12. A person's month is `PayrollRun.sealedItems[]`, not `items[]`, which keeps the shape other tenants use. The class supplement is an input, not derived: РКС № 17/2026 struck parts of КТ чл. 355, and what applies after it needs the accountant (§12). `scripts/compare-payroll-files.ts` and `scripts/prove-payroll-engine.ts` print counts, and this is what they say.

| Check, on what is on disk | Holds |
|---|---:|
| Parse and emit again equals the filed bytes, the developer field aside | 59 of 59 обр. 1 files (974 records), 57 of 57 обр. 6 |
| Insurable income: the larger of gross and the floor for the days, then the cap | 720 of 720 person-months |
| The engine's rates equal the percentages filed: ДОО, ЗО, УПФ | 705 of 705 |
| ТЗПБ from Annex 2 and 2А, 2026 only | 149 of 149 |
| Each share rounded per person, summed per fund = обр. 6: ДОО, ДЗПО | 42 of 42 |
| The same for ЗО | 41 of 42 (January 2026, below) |
| Tax = (taxable income − employee's contributions) × 10% | 714 of 720, and the other 6 with the disability relief |
| Declared net, outside January | 670 of 670, 6 of them with that relief |
| Health base on sick and childcare days | 719 of 720 (January 2026, below) |
| Health base on unpaid leave | 720 of 720 |
| Employer's sick pay: 70% of the month's daily average | 41 of 49. 2 rows have no worked day, so the contract's day decides, which the declaration does not carry |
| Tax on обр. 6 = the previous month's | 37 of 37 outside the rows below; January 2026 equal at the fixed rate; 2 of 3 Februaries within one unit once the annual recalculation is taken off |
| A month's salary = the full salary × days ÷ working days, on the sheets | 16 of 17 that can be compared |

What these taught, beyond §1.8 and §7.4:

- **Field 19** is four characters: the days, two; statutory hours, one; contract hours a day, one (Н-13, т. 16).
- **The floor.** The filed months fit the self-insured minimum, in proportion to days worked and the employer's sick days, in every month. Annexes 1 and 1А agree on all of 2026. Earlier years' annexes are not held, so the engine uses that minimum for them, and refuses a month where an annex is in force and the group or the row is missing. ⚠ The install's own table by КИД is 2016's: whether a floor above the minimum was owed in a month before 2026 cannot be told from what is held.
- **Field 46 is blank** on all 168 rows of 4 people, whose taxable income is above the cap on 165 of them. For them the taxable income stands in for gross. Why the install leaves it blank is not known.
- **Field 50 is the wage's net, capped at the highest insurable income** (НПОПДОО чл. 32). A compensation at leaving is taxable and not insurable, and stays out of it, with the tax on it. In January it also carries the annual recalculation.
- **Health on sick and childcare days** is the employer's 4.8% on the self-insured minimum, in proportion. At the cap there is none: 7 rows have none, and the other 55 carry it whole.
- **Health on unpaid leave** is 8% on half that minimum, in proportion, and in all 15 rows the net leaves it out (§12).
- **January 2026 was filed with 22 working days** in all 16 rows, where the calendar has 20: the weekdays, with no holiday taken off. The month's one health base on sick days is a share of 22, not of 20, and that is the one ЗО month that misses.
- **January 2026's two versions,** written the same day, differ only in field 50, on 10 rows. On the older, net = gross − contributions − tax on all 16. The newer leaves that on 9 rows, for no reason found (§12).
- **Leave pay does not follow КТ чл. 177 as read.** On the sheets it is this month's day, (salary + class) ÷ days worked, in 35 of 42 rows to the cent and 40 within 1%. The last month with 10 worked days gives it in 4 of 43. So the engine defaults to this month's day and takes `leaveDailyBase` when given one (§12).
- **The class supplement** keeps one share of the salary all year in 22 of 26 person-years, and is the personnel export's class percentage within 0.15 points in 26 of 45 rows. Not enough to derive it, as above.
- **A line is a person on a contract** (§11). An imported row goes to the contract in force on its first day of insurance (field 9), and a month where two rows land on one contract is refused, rather than guessed. Every month on disk has one row a person.
- **Not yet proven:** the annual recalculation, within 2 cents on most January rows and no more; an advance run, which is refused; January's correction in 2026.

**Re-imported from the archive (E6), 2026-11-05, on the owner's word.** Every declared person now has sheet lines, joined by ЕГН; the GUI's sheets held about half of them.
- 39 of the 44 months were replaced and 5 left unchanged, and a dry rerun changes nothing. §5.1's gate holds on every month: обр. 1 44 of 44, обр. 6 42 of 42, contributions 42 of 42, people 44 of 44.
- 27 contracts were updated from the 11-05 personnel data: the same 27 that a re-import of the GUI exports updates. The archive also gives 12 of them a class percentage that no GUI export carries.
- 202206 and 202207 hold one person each, whose sheet row only the GUI's export has. Those two months were left as they were.
- ⚠ A re-import pins 202601 to the version that was filed (`--version 202601=20260211_084833`) and leaves out any month not filed yet (`--months`). 202610 was already on disk: written on 11-03, due on 11-25. People and contracts still read every month on disk. Folding the contracts with and without 202610 changed none of them.

### R0 — repairs the import would hit first

| # | Where | What is wrong |
|---|---|---|
| 1 | `accounting.service.ts#postJournalEntry`, `#voidJournalEntry` | Balance updates use the value loaded before the loop, so two lines on one account lose one. Most entries in §1.4 have many lines on 702 and 304 |
| 2 | `report.controller.ts:11` → `getTrialBalance(orgId, periodId)` | The UI sends `fiscalYearId`, the service filters `fiscalPeriodId` with it: selecting a year returns nothing |
| 3 | `getProfitLoss` | Nets debit and credit per account: 702 shows the margin as revenue. Split by side |
| 4 | `/report/balance-sheet` | Reads `Account.balance`, has no date, ignores 411 and 401 balances running on both sides |
| 5 | `getTrialBalance`, `getProfitLoss` | `findMany` every entry into memory. Aggregate |
| 6 | `journal-analysis.controller.ts` | Compares `orgId` as a string in a raw aggregation (not cast), so it returns nothing, and runs a discarded full query first |
| 7 | `createMovementValuationEntry` | Falls back to `unitCost`, which on a dispatch is the sale price (CLAUDE.md, FR-07) |
| 8 | `tax-return.controller.ts` | No body schema on create |
| 9 | `run.controller.ts`, `payroll.service.ts` | Two calculations, and the tested one does not run. One path, and approval generates the payslips (§1.9) |
| 10 | `DEFAULT_ROLE_PERMISSIONS`, the employee routes | `payroll.read` is no default for `member`, and personal fields are projected by permission (§3.11), before any real payroll is imported |

`КП`, `ЗАП` and month-end entries are dated on a month's last day, which the period lookup has handled since `786c33db`.

**As built.** Items 1–9 and the first half of item 10. The second half, personal fields by permission, needs `payroll.personal` and lands with the personal-data work (§3.12). What a later release should know:

- A P&L row's `amount` only nets the two sides. A debit on a revenue account is not reclassified, so with cost of sales kept on the revenue account (`D702 K304`) that account's `amount` is the margin. Each row carries `debit` and `credit` for the reader who can tell.
- Statements add up posted lines with `sumPostedLines`. `Account.balance` stays a cache, and no statement reads it.
- The balance sheet moves a partner on the far side of an asset or liability account to the other side of the sheet. Lines that name no partner stay on the account's own side, so this needs `contactId` on the lines.
- ⚠ Rollout: deploy → `scripts/backfill-member-payroll-read.ts` (dry run, read what it leaves, then `--execute`) → members sign in again. A session issued earlier keeps `payroll.read` until it expires, 24 hours at most, so no real payroll is imported before that has passed.

### R1 — as built

The models, `scripts/link-books.ts`, the import (`scripts/import-accounting-books.ts`), the four reports on the registry, and the gate's tool (`scripts/compare-accounting-books.ts`). Beyond §3.4, a line states its `side`, because a correction is a negative amount on its side and a quantity can stand with no amount, so neither reads off the amounts. `fx`, `journalCode` and `taxCode` keep the journal's other columns; `docTotal`, `docVat`, `docCurrency` and `partnerAnalyticId` keep what a document says of itself. What a later release should know:

- **`sumPostedLines` is the one reading of balances.** It leaves out `ledger: 'shadow'`, which R3 is the first to write. The six-column reports go through it. What does not add up per account (the main book's pairs, the chronology, the document journal, the dashboard's totals, the journal analysis) spreads `POSTED_BOOKS` or its `ledger`. Anything new that reads journal entries does the same.
- **An imported opening restates the year before.** A balance up to a moment starts at the last one, so two imported years are not added together. Only an imported one does this: an `opening` typed by hand in another org adds, as it always did.
- **`contactId` is on every line whose analytic has a Contact,** openings included, because the balance sheet splits an account by it. So every partner path gets a Contact, keyed as the seed skills key them: ЕИК, VAT number, or name. One first met in the journal has only a name, and a later `ap_*` fills in what is blank.
- **The sheet splits only an account that runs on both sides.** Cash paid to a supplier names the supplier on 501 too (`D401[x] K501[x]`), and that is still cash. `balanceSide` says which accounts run on both sides, and an account with none set, as in every other org, is split as R0 left it.
- **The analytic opening has no account.** PlusMinus's analytic trial balance is per root, so `--opening-analytics <file>=<account>` names the account its rows go on, and what they leave of the account's balance stays on the account with no analytic. КЛИЕНТИ is on 411 and 412 at once, so a partner's opening can sit on 411 while part of it was on 412. Both the account's balance and the analytic's are the file's.
- **A sales document's branch comes from its number** (`branches[].docSeries`, given to `link-books`), because the journal names no store. Every other document stays the books org's until R3.
- **A re-import keeps ids.** An entry is found by `importKey` (type, number, date, partner, never an amount), updated in place, and those gone are deleted, in one transaction a month. An entry no import wrote is left alone.
- ⚠ `$ne: null` on a line's field, before an `$unwind`, reads "no line lacks it" and drops every document with one line that does. Use `$exists`.

Not built, on purpose: §5.6's link to the store invoice (it would read a branch's documents from a request, and §3.1 keeps that to the worker), `Платено` and `Неплатено` in the document journal (they need `settles` with amounts, R5), and §8's import wizard (the CLI does it).

**Run 2026-11-05 on E1, 2025 and 2026 to 04.11.** Both years imported; a second dry run changed nothing. 2026's opening equals 2025's closing on all 66 accounts. The first real run found three things, each fixed before the gate was read:

- **A journal can hold an operation whose document PlusMinus lost** (#518). The year's own `Брой документи` leaves the document out while `Брой счетоводни операции` counts the operation. It is imported as a document of its own, and the import names it.
- **An analytic trial balance of a root kept without quantities** (КЛИЕНТИ, ДОСТАВЧИЦИ) has 7 columns, not 11 (#519). The parser read it at СТОКИ's positions. The analytic openings of 401 and 411 were imported again from the corrected reading.
- **Such a file states no quantities,** while the books carry an operation's quantity on both of its analytics. The gate compares quantities only where the file states them.

The gate, after them:

- **Equal:** the main book, the journal's turnovers per account and per analytic, and for 2026 the synthetic trial balance and ДОСТАВЧИЦИ.
- **What is left differs in two ways, and neither is the import's:**
  - two cells of 2025's synthetic trial balance, by the cent PlusMinus rounds a balance to;
  - a few dozen analytic rows a year, whose name holds U+FFFD in place of a Cyrillic letter. The amounts agree, split between the journal's spelling and the trial balance's. **That is the GUI export's damage, not the books'** (found 2026-11-05): read from the archive (E6), the database spells every one of those names right, so there is nothing for the accountant to repair.

**The export's damage,** each kind checked value by value against the archive: it cuts text at 120 characters, it breaks some Cyrillic letters into U+FFFD, and it rounds numbers to 10 decimals (the archive reader rounds the same way). **Re-imported from the archive, 2026-11-05, on the owner's word.** Each year's dry run changed exactly the documents the damage touched. That was checked by planning both files with the server's own `planMonth` and comparing them month by month:
- 2025: of 27,442 entries, 272 changed and 146 replaced. 2026: of 22,151, 126 changed and 41 replaced;
- the chart and analytics are unchanged, finish changed 0 accounts, and a dry rerun of each year changes nothing;
- the opening changed by the corrected names, and on 27 analytic lines by less than half a cent each (26 in 2025, 1 in 2026). The printed trial balance rounds a line to the cent, and the archive carries the database's value. No account total moved, and 2026's opening still equals 2025's closing on all 66 accounts.

The gate after the re-import, against the same printed files:
- **Equal:** the main book and the journal's turnovers per account, both years; 2026's synthetic trial balance and ДОСТАВЧИЦИ.
- 2025's synthetic trial balance differs in the same two cells, by a cent.
- **The analytic comparisons now show the export's damage.** The journal export's turnovers per analytic matched while the books were that export. Now they differ on every name the export broke (12 in 2025, 5 in 2026), and so do the analytic trial balances (10 and 4). Moved onto its real name, each broken row equals LGR's.
- One row is left: a 2025 supplier whose closing differs from the print by 0.62 of a cent, because its opening now carries the database's sub-cent value.

**What the GUI files left behind in regal-acc was deactivated on 2026-11-05, on the owner's word.** That was 39 analytics and 14 contacts, with `scripts/deactivate-books-leftovers.ts`.
- First counted as 20 analytics. That count took only the paths the journals and trial balances booked. The database also held the broken roots (the import creates every ancestor of a path) and damaged rows of the analytics lists.
- The export breaks one Cyrillic letter into two U+FFFD. Each of the 53 rows has exactly one active twin under the real spelling, and nothing points at any of them.
- After the deactivation, a dry run of both years' imports is unchanged in full.

⚠ Rollout: `accounting.import` belongs to admins by default, and `tokenize()` gives an admin every permission, so there is no backfill; an admin signs in again after the deploy. The new indexes must be on prod before the first import: the unique one on `importKey` is what stops two imports of a month doubling it.

### R2 — the VAT files

**As built.** `services/biz/vat-files/`: the annexes as data (`layouts.ts`), parse and emit (`codec.ts`), the arithmetic (`rules.ts`), the one path from a month to its files (`month.ts`), and the return's life (`vat-return.service.ts`). §7.1's gate, `scripts/compare-vat-files.ts`, on all 42 filed months: 42 equal, 135 files of which 9 VIES, 74,233 records. It keeps only the rows and who filed: row totals, row numbers, all of `DEKLAR`, all of `VIES` and whether a month has one are computed. The import, rehearsed over the real files on a throwaway replica set: 42 months written, 74,146 rows, a second run changing nothing, and 135 of 135 files read back from the database equal to the filed bytes.

What a later release should know:

- **A VAT file is not stored.** Its bytes regenerate from the frozen rows on every download, and are refused unless they equal the `sha256` recorded for them. The import runs from where the private files are, over a port-forward, and that is not where a `File`'s bytes live. So `files[].fileId` stays empty for VAT, and a layout that changes must keep regenerating the months before it, or the download refuses rather than serving other bytes.
- **A zero is printed in VIES** (`0.00`), and blank everywhere else. The annex is silent; the 9 filed files decide it.
- **A return with a `kind` belongs to its flow.** The generic `PUT` and `DELETE` on `tax-return` refuse it, or `accounting.write` could file or unfreeze what `accounting.file` guards. A hand-made return has no `kind` and behaves as it did.
- **The VIES declarant's ЕГН** is an ordinary field on the return, left out of every JSON answer by `withoutPersonalId`. Not `select: false`: the backup bundle reads through Mongoose and would lose it, and a restored month could no longer regenerate its VIES. It is in `VIES.txt` by law, and anyone holding `accounting.read` can download that file. Whether that stays is the owner's call.
- **Nothing sets `paid`, `corrected` or `supersedesId` yet.** They are in the model. A correction needs rows to correct (R3, R4), and a payment belongs with the bank (R5).
- **`01-60` is written positive, unproven.** None of the 42 months has a refund. The accountant confirms it on the first one.
- **`01-33`, `01-70`, `01-80`, `01-81` and `01-82` are what a person decides.** `generate` takes them as `declared` and carries them forward; the screen does not ask, since no filed month used them. `01-71` follows: `01-50` less `01-70`.
- **The screen replaces the old tax return form,** which never saved. It sent fields no model had, and posted to a `/submit` route that did not exist.
- ⚠ Rollout: deploy → `bun run migrate` (0013 grants `accounting.file` to whoever holds `accounting.post`) → people sign in again → `scripts/import-vat-files.ts`, a dry run first. It needs the org's VAT or tax number to equal the files', and the indexes only the deployed app builds.

### R3 — the sales register first, as built so far

R3's gate is the sales register, and R2 already holds the filed one, so that half needs no E1. Built: the row of a document (`services/biz/vat-files/sales-register.ts`), the read across a books org's branches (`sales-register.service.ts`), and the gate, `scripts/compare-sales-register.ts --org <books org> --period <YYYYMM>`, which prints counts only. Not built: the worker, the shadow ledger, the mapping to accounting groups (all wait on E1), the till's `81` rows (§12), and a page in the app.

On prod, against `regal-acc`'s filed months: every filed row of the first store's series is in LGR for August and September, and LGR holds none the register lacks. September is 258 equal of 386. The rest is one cause in LGR's documents, already fixed for new imports, and one in its contacts:

- **The VAT of an imported invoice.** The register carries the VAT the invoice prints, worked out once on its base. The PDF reader took the base only, so the import stored the sum of the lines' rounded VAT, one or two cents away on about a quarter of the documents (#485). The documents imported before that fix still carry it.
- **A contact without its VAT number.** The register names the partner by its VAT number, the contact had only its ЕИК.

What a later release should know:

- **A row's VAT is the document's own, never a sum of its lines.** The form rounds once too (`round2` of the unrounded lines' VAT). The import was the one path that did not.
- **Only 20% is derived.** In 42 filed months this company's invoices and notes carried no other rate. A 0% line can be an intra-EU supply, an export or an exempt one, and the document does not say which, so any other rate is refused with its reason.
- **A document annulled in a later period keeps its values in its own.** The row of opposite sign in the later period is counted as missing, not derived. ⚠ LGR's date of a void is when LGR was told. For a document annulled in PlusMinus that can be weeks after the annulment, and the gate shows such a row as differing, which it is.
- **An import is told by the document import's own marks** (`ocr-import`, a first status of `ocr_import`). Only the Files pipeline keeps the PDF. The CLI and API imports keep none, and on August's documents the PDF alone counted 297 imports as issued in LGR.
- **Typed in LGR as well as in PlusMinus.** While the stores issue in both, a document typed into LGR can carry an import's number. The gate matches the import and counts the other apart.
- **A store outside LGR.** The third series belongs to a third store that keeps its own program (§12, question 1). Its rows are counted as that store's, by the series `link-books --external` names, and are no gap.
- **A partner that differs is not always LGR's mistake.** Of the filed rows whose partner differed from LGR's, some were invoices the store re-issued under their number to another customer after the PDF was imported: the register was right, and `scripts/repair-invoice-customer.ts --printed` moves LGR's copy. Others carry a wrong number in the books' own partner card, the same on every row of that customer: the accountant corrects those. Read the store's current document before deciding which side is wrong.

## 10. Tests

- **Integration**, fictional data only: every row of §1.4 as a fixture, posted and checked per account and analytic; the moving-average table (purchase, sale, negative on-hand, backdated); a month re-imported with changed values; the branch link refused across different `taxNumber`; `isForeignOrg` still refuses a branch user on the books org; idempotent worker; void and edit after filing.
- **Golden files for the formats**, with made-up registers: a `DEKLAR`, a `POKUPKI` and a `PRODAGBI` in the repo, CP1251 and fixed width, generated and compared byte for byte. The same for an `EMPL`, an `NRA62007` and each XML, with checksum-valid fake ЕГН numbers: never a real one in a fixture.
- **Payroll, unit:** the engine as a table: floor and cap on insurable income, 2026's two periods, a person born before 1960, ТЕЛК and child relief, partial month, unpaid leave, the employer's two sick days, each share rounded per person, чл. 45's upward rounding against a deduction's general rounding, BGN and EUR.
- **Payroll, integration:** a run through every status with `ЗАП` posted and checked per account and analytic; a correction after filing; `payroll.personal` refused and masked in every list and export; a store user refused on the books org; nothing personal in logs or audit rows.
- **Real data stays out of the repo.** `scripts/` tools compare against `_docs/` and print "equal" or the row count that differs.
- ⚠ No `.rejects`/`.resolves` in this suite (CLAUDE.md, Known Issues). A new script that imports models connects with `autoIndex: false, autoCreate: false`.
- **Field:** R1's and R2's gates are the field test, on prod, read back from the running API. Remove any temporary account afterwards and say how it was checked.

## 11. Constraints and edge cases

- `/bills/import/*` and `POST /invoices` stay byte-compatible (README, global constraints). The worker reads documents and never changes them.
- A document number is not unique across suppliers: key on partner + number + date.
- Prefixes come from `sequence-registry`, doc types from a registry. Nothing hardcoded.
- Cyrillic through `$regex` from Bun is broken (CLAUDE.md): analytics are searched through `nameLower` and equality.
- The EUR changeover: anything before 2026-01-01 is BGN in the source. PlusMinus converts at read time at 1.95583; the import converts once and stores both.
- Backups enumerate the models by themselves, so the new collections join if they use `tenantPlugin`. Retention is an allow-list of two collections (`TOUCHABLE` in `retention.service.ts`), so nothing new can be pruned; the header comment that names what must never be pruned gains `VatRegisterEntry`, `TaxReturn` and the payroll models. An entry in a closed year is never rewritten by a recalculation.
- Other tenants: `settings.accounting.books` and `settings.payroll.engine` unset means no code path here runs for them. Their auto-journal and generic payroll are untouched.
- The accountant's PC is in use, evenings too. File copies do not disturb it; the GUI is the accountant's. Ask first.
- The first LGR обр. 6 carries a tax that PlusMinus calculated (§1.8), so December's run must be imported before January's file.
- A declaration's rows are per person per month. History has exactly one row each, but a person with two contracts, or who leaves and returns inside a month, must not collide: key on person + contract + period.
- A person leaving mid-month, a mid-month parameter change and a partial month all reach the same day-based calculation, never a special case.
- Both payroll files name their software in a developer field. Compared with it masked; LGR writes its maker's EIK there, from configuration (§12).

## 12. Questions

**For the accountant** (none blocks R0–R2):

1. **The third invoice series and third till.** 24 invoices a month in a 5-digit series and one `81` row belong to neither store server. Where are they issued, and do they stay? (R3 can't pass without this.) **Answered 2026-11-03:** a third store of the same company, with its own warehouse, on a PlusMinus of its own that is not online. Its invoices, 10 to 20 a month, are printed and keyed into the books by hand. It keeps selling outside LGR for now: the two stores go live first, the third later. Its series is named with `link-books --external` (§3.1), and the `81` row that goes with it is its till's.
2. **How is the monthly till figure built?** pz's follows its till less what was invoiced (§1.5). Is sf's taken from the fiscal device's monthly report? Which report, and what is subtracted? *Open.* For September's sf row the accountant suggested it may include the three stores' invoices. The numbers do not bear that out, and every store invoice already has its own row, so including them would declare them twice. The private report has the figures.
3. **Does group costing stay?** D3 assumes yes. Would the accountant keep the same groups, and who adds a new one?
4. **How does a product land in a group?** Is there anything written down, or is it recall? The answer decides how much weight `learned` gets.
5. **Exports:** E1's list, plus one trial run of the `saft` report. A few minutes each. **Answered 2026-11-03:** we run them ourselves, signed in as `lgr-api`, when the PC is free.
6. **The tolerance** for cost of sales in §6.3, and the switch-over date.
7. **Payroll exports:** E8's list. Which version was filed, for the 13 months with more than one? **Answered 2026-11-03:** the newest everywhere but January 2026 (below). E8's exports we run ourselves, as `lgr-api`.
8. **Where do a month's inputs come from today:** a paper attendance sheet, messages, memory? It decides the shape of the month's sheet in P2.
9. **Sick leave:** the НОИ forms in the install were not opened in 13 months. Where is Приложение № 9 filed from today? LGR produces it only if that is wanted (§7.4).
10. **Salaries part-paid in cash** (`D421 K501`): a standing arrangement per person, or case by case?
11. **How far back must LGR answer?** Older years stay in PlusMinus (§5.1). Certificates for a former employee can reach far back: how often is that asked for?

12. **The NRA account statement for 2025:** do net receipts exceed 1.5M лв.? It decides SAF-T 2028 or 2029 (§7.7). Which size category is the company, and is it above an Intrastat threshold?
13. **Are the groups "similar" enough for СС 2** (§7.9), and is the policy written down?

**From P1's proof** (§9):

- **Leave pay:** this month's day, as the sheets show, or КТ чл. 177's last month with 10 worked days? They differ when a month has fewer working days.
- **January 2026:** which of the two versions was filed? Was it filed with 22 working days, and does that need a correction? **Answered 2026-11-03:** the older one. It is re-imported on prod, and §5.1's gate is equal in every month. The 22 working days are still open, like the rest of this list: the accountant answers them later.
- **Health on unpaid leave:** who bears it? It is declared and paid, and it is not taken from the person's net.
- **The class supplement** after РКС № 17/2026 (§7.5, item 2): what rule applies, from when, and to which past periods?
- **The disability relief:** the tax on 6 person-months shows it, and no file holds the decision. E8 should.

**Decided by the owner, 2026-11-03:**

- **The employer agrees** to moving payroll to LGR, through its owner and manager. So E7 and E8 may run, and P1 may start.
- **Editing issued documents:** no longer possible in `regal-pz` and `regal-sf` from R6 (§7.9).
- **Field-level encryption:** yes, designed in §3.12.
- **The developer field** on обр. 1 and обр. 6 carries the EIK of LGR's maker, from configuration (`PAYROLL_DEVELOPER_EIK`), never hardcoded.
- **The books org:** `regal-acc` while the two apps stabilise, then into `regal-pz` and `regal-sf` (D1, R7).

**Still open for the owner:**

14. **A written processing agreement.** The company is the controller of its employees' data and LGR's operator becomes a processor (GDPR art. 28). The agreement above should be on paper before real payroll runs in LGR.
15. **R7's shape.** **Decided 2026-11-13**, below.
16. **E6,** only if E1 is too slow: is a copy of `.arz` in a throwaway server acceptable, under PlusMinus's licence and for the data? This plan does not need it. **No longer arises (2026-11-05):** the archive is read directly (§4, as built), so no copy of PlusMinus's server runs. Its payroll is handled as E7's and E8's is.

**Question 15, decided 2026-11-13: R7's shape is the natural answer.** One ledger, one VAT return and one обр. 6 per EIK cannot be split per store, so one store org, the home (`regal-pz`), holds them, and the other keeps its share. Each org keeps:

| What | Where |
|---|---|
| A sales document whose number is in a store's series | that store's org |
| Every other entry: bank, purchases, VAT protocols, operations with no document, stock documents, payroll postings (`ЗАП`, totals, no person), the till's monthly rows, the sales of a store outside LGR | the home |
| The opening of a year | the home, one entry. A store's share starts from nothing and reads its balances from the home's opening on, so a year is never added twice |
| The chart and the analytic tree | every org, whole |
| A partner's Contact | linked to a contact the org already has: a partner with a number by the digits of any number a contact holds, whatever its type (its own type first, then `both`, then the other type; the oldest of equals), one without a number by its name (`contact-match.ts`); made only for a partner the org's own entries or opening name, from what its analytic keeps of the file. What the first import made twice: `scripts/relink-books-contacts.ts` |
| VAT returns and registers (`TaxReturn`, `VatRegisterEntry`) | the home |
| Payroll's personal data (employees, contracts, runs, the sealed key) | **stays in `regal-acc`** |

Payroll stays where it is because it is personal data (§3.11), kept off the stores: every admin of a store org would read it there, and a store org holding its sealed key would stop the store's own test copy (the copy refuses such a source). `regal-acc` keeps it, dormant otherwise, until the owner says to delete it. A store's ledger is therefore a share: each entry balances, and only the group's sum is the company's trial balance. `branchOrgId` stays as it was: the store when a series names one, else the org that holds the entry. The rollout, with its proofs and the way back: `docs/guides/books-split-rollout.md`.
