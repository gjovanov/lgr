# Splitting a legal entity's books over its store orgs — the rollout (FR-25 R7)

Audience: the operator who takes the imported books out of a books org of its own and into the store
orgs. Read it once, top to bottom, before touching anything. The decision is FR-25 D1 and §12,
question 15. **Nothing here deletes anything**: the books org of its own is left exactly as it is,
and is the way back.

Placeholders, used throughout:

| | |
|---|---|
| `<books>` | the books org of its own that holds the books today |
| `<home>` | the store org that will keep the opening, the VAT files and everything no store's series names |
| `<store>` | the other store org |
| `<test-home>`, `<test-store>` | their test copies (`scripts/org-clone.ts`) |
| `<HOME_CODE>`, `<STORE_CODE>` | each store's code, as `<books>` holds it. Its series (the digits its sales documents' numbers start with) is taken from `<books>` by `link-books --from`, never typed |
| `<day>` | a books folder `pull-plusminus-books/pull-books.ts` wrote |
| `<service>` | the books import's service account (`accounting.import` only) |

Every org is named by slug. No id is typed anywhere: `link-books` resolves the slugs and writes the
ids itself.

---

## 1. What lands where

| What | Org |
|---|---|
| A sales document whose number is in a store's series | that store |
| Every other entry: bank, purchases, VAT protocols, operations with no document, stock documents, payroll postings, the till's monthly rows, the sales of a store outside LGR | `<home>` |
| The opening of each year | `<home>`, one entry. `<store>` answers `unchanged, lines: 0` and writes nothing |
| The chart, the analytic tree | both, whole |
| Contacts | linked to what each org already has, by number and of any type; made only for partners the org's own entries or opening name (step 6, "Contacts") |
| VAT returns and registers | `<home>` |
| Payroll (personal data) | stays in `<books>` |

Each org is sent **the same files** and keeps its share. Each entry balances on its own, so each
org's ledger is a share, and the company's books are **the sum of the two**. A store reads its
balances from `<home>`'s last opening on, so the two add up across a year's opening.

---

## 2. The order, and why

1. **Deploy the release first.** The server must know `split`, and the test-org sync must already
   leave a books-holding org's books out of its copy **before any book lands in a store org**: a sync
   never deletes what a copy already holds.
2. Make sure the test-org sync runs that release.
3. Read-only checks.
4. Link the split.
5. Give `<service>` a membership in both orgs.
6. Import both years into both orgs.
7. Take the proofs.
8. Import the VAT files into `<home>`.
9. Switch the nightly.

Scripts that write Mongo directly (`link-books`, `seed-user`, `org-clone`) run on the build host
against the cluster's Mongo, with the port-forward the `seed-user` skill shows. The importer, the
gate and the nightly talk to the API, from wherever the books folders are.

---

## 3. The steps

### Step 1: deploy

The usual deploy (the `deploy-prod` skill). Nothing changes for any org until step 4: an org with no
`split` imports, reads and copies exactly as before.

### Step 2: the test-org sync runs the release

The sync is a CronJob in the deploy repo, on the app's image. Confirm its image tag is the release's.
Then:

```bash
bun scripts/org-clone.ts status --pairs <home>:<test-home>,<store>:<test-store>
```

From step 4 on, the same command lists, under each pair, "the company's books (… keeps them), never
copied", with the counts. Before step 4 the store orgs keep no books, and nothing is listed.

### Step 3: read-only checks

- **The series.** Read `<books>`'s `settings.accounting.books`: its `branches` (code, `docSeries`) and
  `externalBranches`. Step 4 takes both over from `<books>`, and its dry run prints them to compare.
- **One company.** `<books>`, `<home>` and `<store>` have the same `taxNumber`. `link-books` refuses
  otherwise.
- **Fiscal years.** In both store orgs, no year over the years to import may be closed or locked. An
  import refuses a closed period (`period_closed`), and also a closed or locked year that has no
  periods, rather than open periods inside it. A year typed in by hand that holds the dates is used
  as it is, and a missing year is created. Years before the first imported one are never touched.
- **LGR's own postings stay off.** `settings.accounting.autoPostInvoiceEntries` and
  `autoPostPaymentEntries` are false or unset in both orgs. On, LGR would post the stores' own
  documents into the same ledger the books import fills, and every sale would be counted twice.
- **Moves.** Once linked, neither store org can move its home to an on-prem master: a home move
  refuses an org that keeps books (FR-25 §3.11). Check nothing planned needs that.
- **No books in the store orgs yet.** Count, per store org, its rows of the models a books-holding
  org never copies (`policy.ts#BOOKS_NEVER_CLONED`: accounts, analytics, journal entries, journals,
  bank accounts, reconciliations, fixed assets, VAT returns and registers). Expect none. A row of its
  own from before is not the books, but its copy, made by an earlier sync, would be counted by the
  books scan in step 7: remove that copy from the test org first, or reset the test org.

### Step 4: link the split

```bash
bun --env-file=.env run scripts/link-books.ts --split --home <home> \
  --branch <home>:<HOME_CODE> --branch <store>:<STORE_CODE> --from <books>
```

A dry run. Each store keeps the series `<books>` holds for it. Read it:

- `split: every branch keeps its share; home <home>`
- `branch <home> (<HOME_CODE>, series …): would_link, leaving <books> (which keeps its copy)`, and the same
  for `<store>`: the series must be the ones step 3 read
- `outside LGR <code> (series …): would_set`: taken over from `<books>`

Add `--execute`. Then run the dry run again: every line says `already`. `<books>` is untouched: its
own import keeps working, and its branches list still names the two stores.

Refused, and why:

| Code | Means |
|---|---|
| `linked_elsewhere` | a store is a branch of a books org not named with `--from`, or keeps a share of another split |
| `branch_is_books` | a store keeps books of its own: a split would cut them down to a share |
| `no_series` | a store other than the home has no series: it would keep nothing |
| `home_not_a_branch`, `split_creates_nothing`, `tax_number_differs`, `series_overlap` | what they say |

### Step 5: the service account in both orgs

```bash
bun run scripts/seed-user.ts --org <home> --email <service's address> --username <service> --password <unused> \
  --first <…> --last <…> --role member --permissions accounting.import --set-name "Service: books import"
```

A dry run; then `--execute`; then the same for `<store>`. It must say "Linked to the existing person
… Their password is unchanged; --password was not used.": one person, one password, a membership per
org, each holding `accounting.import` and nothing else. The importer signs in per org
(`POST /api/auth/login` with the org's slug), so nothing else changes.

### Step 6: import, per year, per org

Oldest year first; within a year, `<home>` first. The root accounts are the nightly's
(`BOOKS_NIGHTLY_ROOT_ACCOUNTS`).

```bash
LGR_USERNAME=<service> LGR_PASSWORD=… bun run scripts/import-accounting-books.ts --org <org> --books <day> --year <YYYY> \
  --root-account <ROOT>=<account> … --finish            # dry run: read it
… --execute                                             # write
…                                                       # dry again: must be unchanged
```

What each line should say:

| Step | `<home>` | `<store>` |
|---|---|---|
| chart | the whole chart | the whole chart |
| analytics | the whole tree; `contacts.created: 0`, `deferred`: partners with no contact yet | the same |
| opening | `new` (then `unchanged`), `split.role: home`, `continuity: null` | `unchanged`, `lines: 0`, `split.role: member` |
| journal months | `split.contacts.created`: partners its own entries met first | the same, for its own customers only |
| journal total | `entries`: its share; `fileEntries`: the whole file's | the same |
| finish | the accounts it changed | the same |

`continuity` is `null` in a split: a share's closing is not the company's. The nightly checks it for
the group, from the archive (step 9); the gate's opening columns prove it too (step 7).

#### Contacts

A partner analytic (`КЛИЕНТИ`, `ДОСТАВЧИЦИ`, `ПАРТНЬОРИ`) stands for a Contact of the org. Each org
finds its own, by the rule in `contact-match.ts`:

- **A partner with a number** is linked to the contact that holds the number, whatever the contact's
  type and however the number was typed. Only the digits count (`BG`, spaces, dashes and dots do not),
  and the ЕИК, the form's ЕИК field and the VAT number are all looked at. Fewer than 5 digits, or a
  number typed to fill the box (`000000000`), is no number. Of several contacts, the partner's own type
  comes first, then one that both buys and sells, then the other type; of equals, the oldest. Being found
  never changes a contact's type: a supplier of the shop that the books sell to stays a supplier.
- **A partner with no number** is linked by its name, to a contact of its own type or one that both buys
  and sells. A partner with a number is never linked by name: two companies can share one.
- **Nobody found:** the analytics step only links (`contacts.deferred` counts the rest). A journal month
  or the opening makes a Contact for a partner its own entries name, with the numbers, address and МОЛ
  its analytic keeps (`split.contacts.created`). A sister store's customers and the supplier list never
  become a store's contacts.

The first import into the store orgs ran before this rule. It compared numbers as written and looked
only at contacts of the partner's own type, so it made a second contact for some companies a store
already had. Once the release with the rule is deployed, repair each org of the split, while nothing
imports into it (not while the nightly or a daily document import runs):

```bash
bun scripts/relink-books-contacts.ts --org <org>                                   # dry run: counts only
bun scripts/relink-books-contacts.ts --org <org> --execute --expect <pairs> [--out <dir>]
```

It runs on the build host against the cluster's Mongo, like `link-books`. A **pair** is a contact the
import made and an older contact that holds one of its numbers. "Made by the import" means made since
the books import began in that org and named by nothing but the books: no document, file, e-mail,
notification or document-import analysis names it, and nobody edited it in the app. For each pair, the
analytics and every journal line of the org point at the older contact, and the made one is deleted once
nothing names it any more. It leaves alone, and only counts:

- made contacts with no number, or with numbers no older contact holds;
- those something besides the books names;
- those that only share a name with an older contact that has no number.

Before its first write it writes a manifest outside the checkout. The manifest holds whole contacts, so
keep it private. `--undo <manifest>` (a dry run, then `--execute`) makes the deleted contacts again,
exactly as they were, and points the books back. A second run finds no pair.

⚠ The contact on a line is part of an imported entry's stored hash. So the next import of each month
(the nightly's) reports the re-pointed entries as `changed`, once, and writes them as they already are.
Take step 7's "unchanged" proof after that import, not between the repair and it.

### Step 7: the proofs

Counts only, as everywhere in FR-25.

1. **The shares add up.** Per year, `<home>`'s `journal total.entries` plus `<store>`'s equals
   `fileEntries`, which equals `<books>`'s own: `--org <books>` without `--execute` prints it.
2. **Unchanged.** Every dry rerun of step 6: `unchanged` equals `entries`, nothing new, changed or
   gone, in both orgs and both years.
3. **The gate over the group**, with the printed files used for `<books>`:

   ```bash
   LGR_USERNAME=… LGR_PASSWORD=… bun run scripts/compare-accounting-books.ts --org <home> --org <store> \
     --trial-balance <…> --main-book <…> --journal <…>
   ```

   Then the same files with `--org <books>` alone. The two verdicts must be the same, row for row:
   whatever differs from the print differs for `<books>` too (FR-25 R1 says what and why).
4. **No flood of partners.** `<store>`'s contacts grew only by the partners its own sales name: the
   sum of its `split.contacts.created` over the months.
5. **No books in a test copy.**

   ```bash
   bun scripts/org-clone.ts leaks --pairs <home>:<test-home>,<store>:<test-store>
   ```

   It must end `NO LEAKS`, and say for each pair "the company's books: N rows of the real org looked
   for in the copy: 0 copied". Run it again after the next nightly sync.

### Step 8: the VAT files into the home

```bash
bun run scripts/import-vat-files.ts --org <home> --dir <nap/vat dir>             # then --execute
bun run scripts/compare-sales-register.ts --org <home> --period <YYYYMM>
```

The sales register's counts are the same as with `--org <books>`: the home's `branches` are both
stores, so it reads both stores' documents.

### Step 9: switch the nightly

1. Move the nightly's pinned checkout to a commit of this release, after the deploy.
2. In its env file, add `BOOKS_NIGHTLY_ORGS=<home>,<store>`. Leave `BOOKS_NIGHTLY_ORG` as it is: it is
   ignored while `BOOKS_NIGHTLY_ORGS` is set, and it is the way back.
3. `bun .claude/skills/pull-plusminus-books/nightly.ts --dry --local`: each year reads as the group,
   then a line per org, and nothing fails.
4. Let the scheduled task run. A failure in one org is mailed with that org named, beside the other
   org's counts, and the run exits 1. The run also stops when the shares do not add up to the file
   or a year does not open where the last closed.

---

## 4. The way back

- **The nightly:** remove `BOOKS_NIGHTLY_ORGS`. The next run imports `<books>` alone, as before.
  `<books>` was never changed, so nothing else is needed for the books to be read where they were.
- **The link:** a store org that keeps a share is refused as a branch of a books org
  (`branch_is_books`). To make the stores branches of `<books>` again, set each one's
  `settings.accounting.books` back to `{ mode: 'branch', booksOrgId: <books' id>, branchCode: <its code> }`
  on global, by hand. No script does this.
- **The books in the store orgs**, if they must go. No script does this either, so do it by hand,
  after a backup bundle of each store org, filtering every step on that org's `orgId`:
  1. collect the ids of the Contacts the import made: those an `AccountingAnalytic.contactId` points
     at, created after step 4, and named by no invoice, order or payment;
  2. delete the `JournalEntry` rows with `sourceModule: 'plusminus'`, and the `Sequence` row with
     prefix `PM`;
  3. delete the `AccountingAnalytic` rows, the `Account` rows, and the `BankAccount` rows whose IBAN is
     under `БАНКОВИ СМЕТКИ`: before the split the store orgs held no accounts;
  4. delete the fiscal years the import created, with their periods, and the periods it created in a
     year that was there before;
  5. delete the Contacts collected in 1.
  No other document points at an imported entry's id.

---

## 5. What not to do

- Never let the test-org sync run a release without the books rule after the first book lands in a
  store org: the company's ledger would be copied to the testers' orgs, and a later sync never removes
  it. If it happened, `org-clone.ts leaks` says so (`N copied`). The cure is `org-clone.ts reset` of
  that test org, then a fresh `sync`.
- Never import into one org of the split alone. The other's share goes stale, and the nightly stops
  on the shares not adding up.
- Never import the VAT files into `<store>`. One VAT return per company: the home's.
- Never run `link-books --books <home> …` without `--split` on a split org. It is refused
  (`split_member`), because it would turn the group's home into a books org of its own.
- Never turn on LGR's own postings (`autoPost…`) in a store org that keeps books.
- Never move the nightly's pin before the deploy: a client ahead of its server fails.
- Never delete `<books>`: it holds payroll's personal data, and it is the way back. That is the
  owner's to decide.
