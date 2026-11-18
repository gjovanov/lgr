# FR-31 — Forms and lists that do not lose or mislead, in one format and one language

| | |
|---|---|
| **Status** | Specified 2026-11-16. Being built slice by slice: §11 says what is done. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | FR-05 (a list's state in the address), FR-22 (`EntityFormShell`, `RowActionsMenu`, the walks and their click budgets, `createIdempotentAction`), FR-28 (server-searched pickers, `useContactSearch`, the product list engine), FR-06 (the Reports entries three inventory lists link to), #737 (`DecimalField`), the coded refusals of `stock-refusals` |
| **Touches** | `ui-shared` (`usePendingChanges`, `usePaginatedTable`, `useSnackbar`, `useHttpClient`, `EntityFormShell`, `ListScaffold`, `PriceCombobox`, `DecimalField`, one formatter, one confirm dialog), `ui-shell` (top bar, app switcher), `invoicing-ui`, `inventory-ui`, `accounting-ui`, `payroll-ui`, `portal-ui` (forms, lists, pickers), one small lookup endpoint, `tests` and `e2e` |
| **Tracking** | [gjovanov/lgr#796](https://github.com/gjovanov/lgr/issues/796) |
| **Code anchors** | origin/master `cb7d18c5` (2026-11-16), re-read and re-counted at `cb039b1a`. Anchors, not gospel. |
| **Batch** | One of the four FRs of the 2026-11-16 audit: [FR-29](FR-29-atomic-bookings-records-runtime.md) reliability, [FR-30](FR-30-speed-at-shop-volume.md) speed, FR-31 (this one), [FR-32](FR-32-code-health.md) code health. [`README.md`](README.md) maps every finding to its FR. |

## 0. The request (owner, 2026-11-16)

> identify what are the technical debts, code smells, performance bottle-necks and suboptimal UX aspects of the app and propose a solution to each of them

and, after reading the findings: create the FRs, grouped as much as makes sense.

**How the audit was done.** `cb7d18c5` was read, and then walked in a real browser at 1366x768 against a throwaway local copy, signed in to the seeded demo organization in Bulgarian. The copy was filled to about one shop-year, so lists, pickers and forms were seen at the size a shop has.

**This FR** holds the seventeen findings about what a person sees and types. **Part A** is about work that is lost and screens that say something untrue. **Part B** is about one look. Each finding keeps the id it had in the audit.

**Evidence.** *reproduced*: made to happen on the local copy. *measured*. *read*: the code was read and the effect inferred. *counted*: a pattern count. *observed*: seen in the walk.

| Finding | In short | Evidence | Today | Requirements | Slice |
|---|---|---|---|---|---|
| R5 | An edit made after the first Save is dropped without a question, on eight forms | reproduced on one, read on seven | §1.1 | FR-31.1 | A1 |
| U11 | A half-second timer decides what counts as an edit | read | §1.1 | FR-31.2 | A1 |
| T7 | The composables that guard a person's work have no unit tests | counted | §1.1 | FR-31.3 | A1 |
| R6 | A slow answer to an earlier search can put the wrong article on a line | reproduced | §1.2 | FR-31.4, .5 | A2 |
| U1 | A document that could not be loaded looks like an empty draft | reproduced | §1.3 | FR-31.6, .7 | A3 |
| U2 | A refused action is explained by a toast that disappears | read, observed | §1.3 | FR-31.8, .9 | A3 |
| R10 | Five pickers only ever offer the first ten | read, measured | §1.4 | FR-31.10 | A4 |
| R11 | An Export that does nothing, on eight lists | reproduced on one, read on seven | §1.5 | FR-31.11 | A5 |
| C6 | Eight editable grids identify a line by its position | counted | §1.6 | FR-31.12 | A6 |
| U3 | Numbers, money and dates are formatted differently from screen to screen | counted, observed | §1.7 | FR-31.13, .14 | B1 |
| U5 | English text in a Bulgarian session | counted | §1.7 | FR-31.15 | B1 |
| U6 | Money and quantity fields are raw number inputs | counted | §1.8 | FR-31.16 | B2 |
| U7 | Three actions ask through the browser's own dialog | counted | §1.8 | FR-31.17 | B2 |
| U8 | Seventeen lists lose their filters and page on Back; three more are off the shared list shell | counted, read | §1.9 | FR-31.18, .19 | B3 |
| U4 | The daily screens are short of room at 1366x768 | observed | §1.10 | FR-31.20 | B4 |
| U10 | Icon-only buttons without a name | measured, counted | §1.10 | FR-31.21 | B4 |
| U9 | No way to jump to a document by its number | read | §1.11 | FR-31.22 | B5 |

**Where to look.** A1, A2 and A3 are the three where a person loses work or acts on something untrue, and each is small. Part B changes what people are used to seeing, so its formats and its room budgets are decisions (§9) with defaults.

## 1. What is wrong today

### 1.1 The guard on unsaved edits (R5, U11, T7)

- `usePendingChanges` (`ui-shared/src/composables/usePendingChanges.ts`) has two ways to say "this was saved":
  - `markSaved()` raises a flag. The leave guard, the tab-close capture and the organization-switch check all read the flag as "nothing to ask about", and nothing lowers it again.
  - `markClean()` takes a new clean state and keeps guarding. The file's own comment says why it exists: "`markSaved` alone would leave every later edit to be dropped on leaving".
- Fourteen forms call `markSaved()` only. Eight of them stay open after a save: Movement, Inventory count, Price list, Warehouse, Category, POS device, Timesheet, Payroll run. Five forms use `markClean()` and are fine: the document forms, both order forms, the product form and the fixed asset form.
- **Reproduced** on the warehouse form:
  - edit, leave: the "Unsaved changes" dialog appears;
  - edit, Save, edit again, leave: no dialog, nothing under Pending Changes, and the second edit is gone.
- **The timer (U11).** The clean state is taken 500 ms after the form mounts.
  - A load that takes longer counts as an edit: leaving an untouched form asks about unsaved changes.
  - An edit made in the first half second is not counted.
  - Two e2e specs wait the half second out by hand and say so in a comment (`order-forms.spec.ts`, `customer-order-tree.spec.ts`).
  - The document forms take their clean state when the document has loaded. The others rely on the timer.
- **No unit test (T7).** Nothing exercises the guard of `usePendingChanges`, `useDialogPendingChanges`, `useGridNavigation`, `useContactSearch` or `useSearchDebounce`. One unit test covers the address a pending change is restored at. That is how one flag could switch the guard off on eight forms without a test going red.

### 1.2 A late answer wins (R6)

- `ProductLineDescription.vue` puts a search's answer into the list without asking whether it answers the latest question. Enter picks the highlighted row.
- **Reproduced** with the first answer delayed by three seconds: the field held the second word typed, the list showed the matches of the first, and its first row was highlighted. Enter would have put that article on the line.
- The same gap is in `usePaginatedTable.fetchItems` (36 screens use it), in `MovementsView.vue`, and in `PriceCombobox.vue`, whose price lookup also fires on every keystroke in the quantity field.
- Two places already drop a late answer by hand: `useContactSearch.ts` and `useProductList.ts`.

### 1.3 A failure that looks like something else (U1, U2)

- **A document (U1).** `loadDocument()` in `useDocumentForm.ts` ends in an empty catch, and `useHttpClient` shows a message only for 5xx answers and network failures.
  - Reproduced: an invoice id that does not exist answers 404, and the page shows the title "Edit Invoice", a Draft chip, an empty form and enabled Issue and Save buttons.
- **A list (U1).** A list whose request is refused looks like a list without rows: the error is thrown into a call nobody awaits, and `ListScaffold` has no error state.
- **A refused action (U2).**
  - `useSnackbar` has one slot. An error shows for five seconds, and the next message replaces it. The document form's save reports a refusal only through it.
  - The text falls back to the API's English sentence, or to the literal `'An unexpected error occurred'`.
  - A refusal can carry database ids ([FR-29](FR-29-atomic-bookings-records-runtime.md).6), and after a failed confirm the same message returns for ten minutes ([FR-29](FR-29-atomic-bookings-records-runtime.md).2).
- The pattern that works is in the repository: `stock-refusals` maps a coded refusal to the line it is about, in the user's language, and `useHttpClient` translates a coded 409.

### 1.4 Pickers that know only the first page (R10)

- Payment orders ask for contacts, bank accounts and unpaid invoices without a size. Cash orders do the same for accounts, and the timesheet form for employees. Each endpoint answers its default page of ten.
- Measured on the fixture: 10 of 620 contacts, 10 of 35 accounts.
- A payment to the eleventh supplier cannot be entered from that screen.

### 1.5 An Export that does nothing (R11)

- Eight inventory lists offer an Export whose handler only writes a line to the browser's console: Categories, Inventory counts, Inventory valuation, Movements, Price lists, Products, Stock levels, Warehouses.
- Reproduced on Movements: the menu offers CSV, Excel and PDF, and choosing one makes no request and no download. The other seven were read.
- [FR-28](FR-28-supplier-facts-product-search-order-tree.md) §10 already records the one on Products.

### 1.6 Lines identified by their position (C6)

- Eight editable grids use the row's index as its key: the document line table, the movement form, the count form, the price list form, the product form's price rows, the journal entry form, the journal entry dialog of the journal entries list, and the till's cart.
- When a row is removed, the rows below it are reused for other lines. What a row holds by itself moves to its neighbour: an open menu, a typed search text, a loaded option list, the focus. Each reused row also loads again ([FR-30](FR-30-speed-at-shop-volume.md).10).
- Both order forms already give every line a stable `_key`.

### 1.7 Formats and languages (U3, U5)

- **Formats (U3).**
  - 41 UI files carry their own map from the app's language to a formatting locale. Twelve of them have no Bulgarian entry, so a Bulgarian session is formatted as English there: Sales invoices is one of the twelve, Bills is not.
  - 26 calls format a number or a date without naming a locale at all, and follow the browser.
  - Seen in one Bulgarian session: the currency sign before the amount on lists and after it in lines; ISO dates in tables, `dd/mm/yyyy` in forms, the browser's own format in date filters; unit prices with five decimals where the price has two.
- **English (U5).**
  - Forty field labels are handed to the Pending Changes panel as English literals, in 21 files.
  - `BulkPriceAdjustmentView.vue`, `StockTransferDialog.vue`, `AppSwitcher.vue` and one text in `PriceCombobox.vue` carry English literals.
  - Key parity between the four catalogues is tested and exact. Literals are not tested.

### 1.8 Fields and dialogs (U6, U7)

- **Fields (U6).** 92 raw `type="number"` inputs in 44 files. `DecimalField` is used by one form. It exists for three things a raw input gets wrong:
  - a column of figures shows the same number of decimals;
  - it has no spin buttons, so the mouse wheel over a focused field cannot change a price;
  - a figure that was loaded is never rewritten by the field, only one that was typed.
- **Dialogs (U7).** Deleting a supplier order, deleting a customer order and pre-empting a reservation ask through the browser's `confirm()`. A comment in the same file says why the app avoids it: its two buttons, „OK" and „Отказ", both read as cancelling. There is no shared confirm dialog; each form that asks carries its own.

### 1.9 Lists that lose their place (U8)

- Seventeen lists keep nothing in the address: Categories, Warehouses, Price lists, Accounts, Bank accounts, Exchange rates, Fixed assets, VAT returns, Employees, Payroll runs, Payslips, Timesheets, POS devices, POS sessions, Users, Invites, Desktops. Back from a record returns to page one without the filter.
- Movements, Stock levels and Inventory counts keep their state and are not on `ListScaffold`: no column picker and no remembered columns. Movements also shows raw ISO dates, has a locale map without Bulgarian, and fetches a contact list it never reads.

### 1.10 Room and names (U4, U10)

- **Room at 1366x768 (U4).**
  - New invoice: the first line row starts at y = 680 of 768. The party block and the header fields take the screen, and each line repeats the article's name as a chip under its description.
  - Products: a row is about 77 px tall because of stacked warehouse chips; five articles are visible, and one column header is cut.
  - Sales invoices: the KPI cards and two filter rows leave about eight rows.
  - The top bar clips its last menu group beside the language switch.
- **Names (U10).** Between 3 and 13 icon-only buttons per screen have no accessible name: theme, apps, menu, column picker, list and board toggle, close, chevrons. By pattern, 69 of 188 icon buttons. Up to four inputs on the invoice form have no label.

### 1.11 Finding a document (U9)

- The shell has no search. Opening a document whose number is known means choosing the right list first and searching there.

## 2. Design

### 2.1 Terms

- **Guard**: what asks before unsaved edits are lost, on leaving the page, closing the tab and switching organization.
- **Clean state**: the copy of a form's values the guard compares with.
- **Coded refusal**: an answer that carries a `code` the UI can translate and place.

### 2.2 The guard

- The fix is in the composable, so that no form can rebuild the trap.
- `markSaved()` no longer means "stop guarding". It means "what is on the screen now is saved": the clean state is taken again and the guard stays on (D-1).
- A form that leaves right after its save is clean at that moment and is not asked. A form that stays open is guarded for the next edit.
- **The clean state is taken when a load resolves**: the first load, and a reload after a save. The timer goes. A form without a load (a new record) is clean when it mounts.
- An edit made before the load resolves is kept as an edit. The loaded values do not overwrite it silently: this is a requirement, with a test, because it is what the timer got wrong in the other direction.
- All fourteen forms are read once against the new rule, and the eight that stay open get a test each.

### 2.3 The latest question wins

- One helper in `ui-shared`, `latestOnly()`: it wraps an asynchronous function so that only the answer to the most recent call is delivered. An earlier call's answer, and its error, are dropped. Where the request can be aborted, it is.
- Used by the product line search, `usePaginatedTable.fetchItems`, `MovementsView` and `PriceCombobox`. `useContactSearch` and `useProductList` move onto it.
- [FR-30](FR-30-speed-at-shop-volume.md).6 de-duplicates in the same function, so the two are built together.
- The price lookup that follows the quantity waits 250 ms after the last keystroke. Leaving the field or saving runs a waiting lookup at once, so a save never carries the price of a quantity that was already replaced.

### 2.4 Failures on the screen

- **`EntityFormShell` gets a load-error state.** It shows what happened (not found, not allowed, could not be loaded), a Back button and a Retry. It shows no form and no Save or Issue. `loadDocument()` reports the outcome instead of swallowing it, and each of the 21 forms on the shell passes its own.
- **Lists get an error state**, apart from "no rows": a sentence and a Retry. `ListScaffold` renders it, and the lists that are not on the shell read the same flag from `usePaginatedTable`.
- **A refused action stays.** It is said in an alert at the top of the form until it is dismissed or the next action succeeds. When it is about a line or a field, it is said there too. Success stays a toast.
- **Error toasts stay** until dismissed, and two messages queue instead of the second replacing the first.
- **Language.** A coded refusal is translated by its code. The server's sentence is shown only for a code the UI does not know. The last fallback is a translated sentence.

### 2.5 Pickers

- Contacts: the server-searched picker of the document forms (`useContactSearch`).
- Accounts and bank accounts: the accounting store's `fetchAccounts()`, which already asks for all of them.
- Unpaid invoices: asked for the chosen contact, searched by number on the server.
- Employees: searched on the server.

### 2.6 Exports

- The rule: a control that is offered does something.
- Stock levels, Movements and Valuation link to their entries in Reports (`stock-levels`, `stock-movements`, `inventory-valuation`), which export to Excel and PDF. The link carries the list's filters where the report has the same parameter, and is shown only to a person who may open the report.
- Products: an export of the catalogue is a feature of its own. Until it exists the control is not shown.
- Categories, Warehouses, Price lists and Inventory counts: the control is not shown (D-2).

### 2.7 Lines keep their identity

- Each line gets a `_key` when it is created or loaded, the grid uses it as the row's key, and it is not sent to the server. The order forms are the pattern.

### 2.8 One formatter

- `ui-shared` exports `intlLocale()` (the app's language to a formatting locale, for all four languages) and three functions: money, number and date.
- Every screen formats through them. The 41 local maps and the 26 calls without a locale go.
- What each language looks like is a decision (D-3 to D-5), written once in the formatter's test table.
- A check over the source fails on a formatting locale named outside the formatter and on a `toLocaleString()` family call outside it. `unit/session-keys.test.ts` is the pattern.

### 2.9 No English literals

- A label handed to the Pending Changes panel is the key the field itself is labelled with, never a literal.
- The four named files move to keys.
- A check beside `web-catalogue-i18n.test.ts` fails on a string literal as a `label` in a `usePendingChanges` call.
- The Bulgarian walk looks for a short list of English words on the daily screens.

### 2.10 Fields and dialogs

- `DecimalField` in the four grids used every day: the document line table, the movement form, the count form and the till's cart. Quantities, prices and discounts.
- The other number inputs move as their forms are touched. A count in a test keeps the number of raw number inputs from growing.
- One confirm dialog in `ui-shared`, opened by a function that returns the answer. Its buttons name the action. The three `confirm()` calls use it, and a check fails on `confirm(`, `alert(` and `prompt(` in UI source.

### 2.11 Lists

- `urlSync: true` on the seventeen lists, which is one option of `usePaginatedTable`. Their filters go into the address the way the other lists' do.
- Movements, Stock levels and Inventory counts move onto `ListScaffold`, Movements first. Their route names do not change: the per-user column choice and the e2e suite depend on them.

### 2.12 Room

- **New invoice.** Once a customer is chosen, the party block is one line that opens on a click. The header of the lines stays visible while the lines scroll. The chip that repeats the article's name goes.
- **Products.** One row per article: the stock per warehouse is one cell with the total, and the split in a tooltip.
- **Sales invoices.** The KPI row can be folded, and stays folded for that person.
- **Top bar.** Groups that do not fit go into a "More" menu instead of being cut.
- Each has a budget in rows (D-6), measured by the walk at 1366x768. The click budgets of FR-22 must not get worse.

### 2.13 Names

- Every icon-only button has an accessible name and a tooltip, translated. Row actions use `RowActionsMenu`.
- The walk fails on a button without a name and on an input without a label, on the screens it opens.

### 2.14 Jump to a document

- A field in the top bar: type or paste a number, Enter opens the document.
- One lookup endpoint under `/org/:orgId/`. It matches the number exactly, then as a prefix, over invoices of every type, supplier orders, customer orders, reservations and movements. An issued document is also found by the draft number it had.
- A family is searched only if the caller may read it, so a match the caller may not open is not revealed.
- One match opens. Several are listed, with the type, the date and the contact.
- The numbers' own unique indexes serve the lookup. A keyboard shortcut focuses the field (D-7).

## 3. Requirements

### Part A — nothing is lost, nothing misleads

**FR-31.1 — Saving does not switch the guard off (MUST).**
- In a form that stays open after a save, an edit made afterwards is asked about on leaving the page, on closing the tab and on switching organization, and is listed under Pending Changes.
- Leaving right after a save, with no edit in between, never asks.
- This holds for every form that uses `usePendingChanges`, with no change needed in a form for it to hold.
- The eight forms of §1.1 each have a test: edit, save, edit, leave.

**FR-31.2 — The clean state is taken when the load resolves (MUST).**
- No timer decides what counts as an edit.
- A form whose load takes five seconds, left untouched, is left without a question.
- An edit made while the load is still running is kept and counts as an edit.
- The two e2e specs that wait out the half second lose that wait and still pass.

**FR-31.3 — The composables that guard work have unit tests (MUST).** `usePendingChanges`, the pending-changes store, `useDialogPendingChanges`, `useGridNavigation`, `useContactSearch`, `useSearchDebounce` and `latestOnly`. The cases of FR-31.1, .2 and .4 are among them.

**FR-31.4 — The latest question wins (MUST).**
- In the product line search, in every list on `usePaginatedTable`, in the movements list and in the price lookup, an answer to an earlier question never replaces the answer to a later one, and never raises an error message.
- An e2e test delays the first answer of the line search by three seconds: the list shows the matches of what the field holds, and Enter puts one of those on the line.

**FR-31.5 — The price lookup waits for the typing to stop (SHOULD).** Typing a three-digit quantity makes one price lookup. Leaving the field or saving runs a waiting lookup first: what is saved is the price of the quantity on the screen.

**FR-31.6 — A document that did not load says so (MUST).**
- A form on `EntityFormShell` whose record was not found, may not be read or could not be loaded shows that, with Back and Retry.
- It shows no form fields and no Save, Issue, Delete or Print.
- This holds for the invoice, bill, proforma, offer, credit note, debit note and both order forms, and for the forms of §1.1.

**FR-31.7 — A list that did not load says so (MUST).** A list whose request failed or was refused shows a sentence and a Retry. It never shows the "no rows" state for a request that did not answer 200.

**FR-31.8 — A refused action stays on the screen (MUST).**
- A save, an issue, a delete or a confirm that is refused is said in the form until the person dismisses it or the next action succeeds.
- A refusal about a line or a field is marked there.
- An error message outside a form stays until dismissed. A second message does not remove the first.

**FR-31.9 — Refusals speak the user's language (MUST).** A refusal with a code the UI knows is shown in the session's language. No message a person reads is a literal in the source. A refusal names no database id (the server's part is [FR-29](FR-29-atomic-bookings-records-runtime.md).6).

**FR-31.10 — Pickers search the server (MUST).** In the five pickers of §1.4, a record that is not among the first ten can be found by typing and can be chosen. A test seeds more than ten and picks the last.

**FR-31.11 — An Export that is offered exports (MUST).**
- On Stock levels, Movements and Valuation, Export opens the report with the list's warehouse, period and type, and the report's own Excel and PDF work.
- On the other five lists no Export is offered.
- No handler in UI source only writes to the console. A check fails on one.

**FR-31.12 — Lines keep their identity (MUST).**
- The eight grids of §1.6 key their rows by a stable key.
- Removing a line leaves every other line's open menu, typed text and focus with its own line, and loads nothing again for them.
- The key is not in any payload: the payload tests of the document form pass unmodified.

### Part B — one look

**FR-31.13 — One formatter (MUST).**
- Money, numbers and dates are formatted by the three functions of `ui-shared` on every screen.
- No UI source outside the formatter names a formatting locale or formats without one. The check of §2.8 is green with an empty allow-list.

**FR-31.14 — The same value looks the same everywhere (MUST).**
- In one session, an amount is written the same way on a list, in a form's lines, in a total and in a dashboard tile: the same separators, the same place for the currency.
- A date is written the same way in a table, in a form and in a document's header.
- A unit price shows two decimals, and more only when the stored price has more.
- The formats per language are those of D-3 to D-5.

**FR-31.15 — No English in another language's session (MUST).**
- The forty labels and the four files of §1.7 use catalogue keys, in all four languages.
- The check of §2.9 is green.
- The Bulgarian walk finds none of its English words on the daily screens.

**FR-31.16 — Decimal fields in the four daily grids (MUST).**
- Quantities, prices and discounts in the document line table, the movement form, the count form and the till's cart are `DecimalField`s.
- The mouse wheel over a focused field changes nothing. A decimal comma and a decimal point are both accepted, on Windows and on Linux.
- A loaded figure is not rewritten by opening and saving the form.
- The keyboard grid of the document line table works as before: its e2e tests pass unmodified.
- The count of raw number inputs in UI source only goes down.

**FR-31.17 — No browser dialogs (MUST).** The three actions of §1.8 ask through the app's dialog, whose buttons name the action in the session's language. UI source calls no `confirm`, `alert` or `prompt` of the browser.

**FR-31.18 — Lists keep their place (MUST).** On the seventeen lists of §1.9, the page, the page size, the sort, the search and the filters are in the address. Back from a record returns to the same rows, and the address can be shared.

**FR-31.19 — Movements, Stock levels and Inventory counts on the shared list shell (SHOULD).** They get the column picker and the remembered columns. Their route names, their filters and their addresses do not change. The dead Export, the raw dates and the unused fetch on Movements go with the move.

**FR-31.20 — Room at 1366x768 (SHOULD).**
- A new invoice with a customer chosen shows at least five line rows without scrolling.
- Products shows at least nine articles, and no column header is cut.
- Sales invoices shows at least eleven rows with the KPI row folded.
- The top bar shows every menu group or a "More" menu, in all four languages.
- The owner sees a screenshot of each before the slice ships (D-6).

**FR-31.21 — Icon buttons have names (MUST).** On the screens the walk opens, every button has an accessible name and every input a label. Icon-only buttons show a tooltip. The names are translated.

**FR-31.22 — Jump to a document by its number (SHOULD).**
- Typing a document's number in the top bar and pressing Enter opens it, from any screen.
- A number that matches several documents lists them. A number that matches none says so.
- A document the caller may not read is not found.
- The lookup reads through the numbers' indexes: an `explain` test shows no collection scan.

### Across this FR

**FR-31.23 — Contracts that do not move (MUST).**
- Route names stay: the per-user column choice is keyed by them and the e2e suite navigates by them.
- No payload changes: `_key` and the formatter are display only. The document, movement and count payload tests pass unmodified.
- The walks of FR-22 stay inside their click budgets.
- `ui-shared/src/session/session.ts` stays the only reader of the session keys.

**FR-31.24 — Guards, languages, data, Windows (MUST).**
- The new lookup route carries `:orgId`, gets its rows in the route-permission tables, and the tenant-isolation and permission suites pass unmodified.
- Every new text exists in `en`, `bg`, `de` and `mk`.
- No test, fixture, screenshot, issue comment or PR carries a customer's name or figure. Screenshots come from the demo organization.
- No new test uses `.rejects` or `.resolves`. An e2e spec does not `import type` from `@playwright/test`. Ad-hoc Playwright scripts run under Node.

## 4. Migration

| What | Change | Procedure |
|---|---|---|
| Stored data | none | Every change is in the browser, except one read-only lookup route |
| Remembered list state | seventeen lists start keeping it | Nothing to move: they kept none |
| Remembered columns | three lists get a column choice | Keyed by route name, so nothing to move |
| Catalogue keys | new keys in four languages | The parity test keeps them aligned |
| A folded KPI row | a per-user choice in the browser | Starts unfolded |
| What people are used to | formats and layouts change | D-3 to D-6 are shown to the owner as screenshots before B1 and B4 ship |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| A1 | FR-31.1 to .3 | a form that stayed open asks before a later edit is lost | the unit tests; the eight form tests |
| A2 | FR-31.4, .5 | none, unless a search answer was late | the delayed-answer test |
| A3 | FR-31.6 to .9 | a missing document and a refused list say so; a refusal stays | the missing-document and refused-list tests |
| A4 | FR-31.10 | five pickers find everything | the eleventh-record test |
| A5 | FR-31.11 | five dead Exports go; three open a report | the console-only check |
| A6 | FR-31.12 | none | the remove-a-line test |
| B1 | FR-31.13 to .15 | one format; no English | the formatter table; the two checks |
| B2 | FR-31.16, .17 | fixed decimals in four grids; the app's own dialog | the grid's e2e tests unmodified |
| B3 | FR-31.18, .19 | Back keeps the place; three lists get a column picker | the Back tests; the movements e2e |
| B4 | FR-31.20, .21 | more rows; named buttons | the row budgets; the name check |
| B5 | FR-31.22 | a number field in the top bar | the lookup tests |

**Order.** A1, A2 and A3 first. A2 is built with [FR-30](FR-30-speed-at-shop-volume.md).6. B1 before B3, because the move of Movements uses the formatter. A6 before [FR-30](FR-30-speed-at-shop-volume.md).10. The rest in any order.

**Rollback.** Every slice is a change in the browser and reverts alone. B5's route is read-only and reverts with it.

**Risks.**
- *The guard asks where it should not.* A form that changes its own values after a save would look edited. Each of the fourteen is read against the new rule, and a reload after a save retakes the clean state (FR-31.2).
- *A dropped answer was the one the screen needed.* One `latestOnly` wrapper per consumer, never one shared by two.
- *An alert that stays goes stale.* It is cleared by the next successful action and by an edit of the field it names.
- *The formats are not what people expect.* D-3 to D-5, with screenshots first.
- *A decimal field changes how the busiest grids type.* The grid's e2e tests and the walks pass unmodified, and the comma is tested on both platforms.
- *Somebody used an Export that is removed.* None of the eight ever exported.
- *The move of Movements disturbs the busiest inventory list.* Its route name and filters stay, and it has its own e2e.

## 6. Tests

- **Unit, composables**: FR-31.3's list. For the guard: leave after a save; edit after a save; a load slower than any timer; an edit during the load; a restore. For `latestOnly`: answers out of order; an error from a call that was replaced; an abort.
- **Unit, formatter**: a table per language for money, number and date, with the edge cases (zero, negative, thousands, a price with five decimals, the first and last day of a year).
- **Unit, checks over the source**: no formatting locale outside the formatter; no literal label in a `usePendingChanges` call; no browser dialog; no handler that only logs; the count of raw number inputs.
- **Integration**: the lookup route (exact, prefix, a draft number, several matches, none, another organization's number, a family the caller may not read) and its `explain`.
- **E2E**: the sequence of §1.1 on the warehouse form and the movement form; the delayed answer; a missing document; a refused list; the eleventh contact in a payment order; removing the second of three lines with a menu open on the third; Back on three of the seventeen lists; the three confirm dialogs; the name check on the walk.
- **Guards, unmodified**: `ux-budgets`, the list specs, the document form's payload tests, `unit/session-keys.test.ts`, `unit/web-catalogue-i18n.test.ts`, `tenant-isolation.flow`, `route-permission.flow`.

## 7. Acceptance criteria

1. §1.1's sequence on each of the eight forms ends with the "Unsaved changes" dialog.
2. With the first search answer held back, the line gets the article the field names.
3. An id that does not exist shows "not found" with Back, and no Save.
4. A refusal is still on the screen a minute later.
5. The eleventh supplier can be paid from a payment order.
6. No screen offers an Export that does nothing.
7. In a Bulgarian session, one amount and one date look the same on the list, in the form and in the total, and no English word of the walk's list is on a daily screen.
8. Back from a record returns to the same page and filter on all seventeen lists.
9. A new invoice shows five line rows at 1366x768.
10. A document opens from its number in the top bar.
11. The existing suites pass unmodified. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.
12. No test, fixture, screenshot, comment or PR carries a customer's name or figure.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

1. **A1.** On the warehouse form and the movement form: edit, save, edit, leave: the dialog appears. Save and leave: no dialog. Open a form and leave it untouched: no dialog.
2. **A2.** Type fast in a document line's search, then in a list's search with the network slowed in the browser's tools: the rows match what the field holds.
3. **A3.** Open an invoice address with a wrong id. Issue a document that will be refused (stock that is not there): the refusal stays and names the line.
4. **A4.** In a payment order, pick a contact that is not among the first ten.
5. **A5.** Open the three report links from their lists: the filters arrive, and Excel and PDF download.
6. **B1 and B2.** In Bulgarian, compare one invoice's amounts and dates on the list, in the form and on its print. Type a quantity with a comma and with a point. Delete a draft order: the app's dialog.
7. **B3.** On three of the seventeen lists: filter, go to page two, open a record, press Back.
8. **B4.** At 1366x768, count the visible rows on a new invoice, on Products and on Sales invoices. Hover the icon buttons.
9. **B5.** Paste an invoice number, an order number and a movement number into the top bar.
10. **Clean up.** Delete every record and document the test made, and report the count left (0) and how it was checked.

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | What does `markSaved()` do from now on? | It retakes the clean state and keeps guarding. A form that reloads after its save retakes it again when the reload resolves |
| D-2 | What becomes of the eight Export controls? | Stock levels, Movements and Valuation link to their report. The other five are not shown until an export of that list exists |
| D-3 | How is a date written? | `dd.MM.yyyy` in Bulgarian, German and Macedonian, without the „г." that Bulgarian formatting adds; `dd/MM/yyyy` in English |
| D-4 | How is money written? | Each language's own convention, the same on every screen: in Bulgarian, German and Macedonian the amount and then the currency, in English the currency first |
| D-5 | How many decimals does a unit price show? | Two, and more only when the stored price has more, up to five |
| D-6 | The room budgets at 1366x768 | Five line rows on a new invoice, nine articles on Products, eleven rows on Sales invoices. The owner sees a screenshot of each first |
| D-7 | The shortcut of the number field | Ctrl+K, after checking it against the keys of the document line table |
| D-8 | Date fields | The browser's own date field stays. It follows the operating system's format, not the app's language (§10) |

## 10. Not in this FR

- Widths below 1366 px, a keyboard-only walk and a screen-reader walk. They were not audited. FR-31.21 is the part of accessibility that was measured.
- An export of the Products list ([FR-28](FR-28-supplier-facts-product-search-order-tree.md) §10) and of the four small lists.
- Replacing the browser's date field with one of the app's own.
- A search over names: contacts, articles, people. FR-31.22 finds documents by number.
- The till's payment and fiscal flow, the document import dialog, the files app, the reports runner and the desktop shell. The audit did not walk them.
- A restyle. Part B changes formats and room, not the look.
- How fast lists and documents open: [FR-30](FR-30-speed-at-shop-volume.md).
- What the server says in a refusal: [FR-29](FR-29-atomic-bookings-records-runtime.md).6 covers the one the audit met.

## 11. Build log

- **A1** (#805): `markSaved()` retakes the clean state and keeps guarding; the clean state is taken when the load
  resolves (`markLoaded`), with no timer; an edit made during the load stays an edit. Unit tests for the guard and the
  composables of FR-31.3; `e2e/unsaved-after-save.spec.ts` on the eight forms.
- **A2** (#810): `ui-shared/composables/latest-only.ts#latestOnly` in the line search, `usePaginatedTable`, the
  movements list's product filter and `PriceCombobox`; the price lookup waits 250 ms after the quantity's last change
  and runs at once on leaving the field or saving. `e2e/late-search-answer.spec.ts`.
- **A3** (#812): `EntityFormShell`'s load-error state (not found, not allowed, could not be loaded; Back and Retry);
  a list's `loadError` with Retry; a refusal stays at the top of the form (`useFormFeedback`) and on the message line
  until closed; messages queue; every coded answer is translated. `e2e/failures-said.spec.ts`.
- **A3, the line** (FR-31.8's "a refusal about a line is marked there"): a refused issue marks the lines it is about.
  The stock check's shortfalls (the transfer dialog closed without confirming) name the article and the warehouse; a
  cost-layer refusal of `/send` (FR-29.6) names the article by name only. Each such line says "Not enough stock:
  N available, M needed" under its description, with a red edge. The mark goes with the refusal at the top (closed,
  or the next attempt), and from a line whose article, warehouse or quantity has changed since. Pure parts in
  `invoicing-ui/composables/document-issue.ts` (`shortagesOfCheck`, `shortagesOfRefusal`, `shortageMatches`), tested in
  `unit/failures-said.test.ts`; `e2e/failures-said.spec.ts` issues a two-line draft whose second line nothing can
  cover. *Decision:* only the document form's issue marks lines. The movement form's refusals are about the movement
  (a warehouse, the supplier), not a line, and a save refusal of the document form names no line.
- **A4** (FR-31.10): the five pickers of §1.4 find what is past the first ten.
  - Payment order, contact: `ContactAutocompleteWithCreate` on `useContactSearch`, the document forms' picker.
  - Payment order, bank account, and cash order, cash and counter account: every row (`size: 0`), as the accounting
    store's `fetchAccounts()` asks.
  - Payment order, unpaid invoices: the chosen contact's (any contact's until one is chosen), 50 at a time, searched
    by number on the server through a field above the table; the ones the order names stay listed.
  - Timesheet, employee: an autocomplete searched on the server, 20 at a time; the timesheet's own employee is fetched
    by id.
  - `e2e/payment-orders.spec.ts` makes eleven contacts, the one to pay first, and pays it with its own invoice (another
    contact's invoice is not offered); a cash order offers the last account of the seeded chart of 35.
  - *Decision:* the unpaid invoices are not narrowed by the order's direction: they never were, and an order may
    settle either side.
- **A5** (FR-31.11): an Export that is offered exports.
  - Stock levels, Movements and Valuation: Export is `ui-shared/components/ReportExportButton.vue`, a link to the
    list's report (`stock-levels`, `stock-movements`, `inventory-valuation`) with the list's filters under the report's
    parameter names (`report-export.ts#reportHref`): the warehouse everywhere, the below-minimum switch on Stock
    levels, the period, type, status and (one) article on Movements. It is shown only to a person who may open the
    report (`canOpenPage`), and on Valuation only with the costs.
  - The other five inventory lists offer no Export (D-2), nor do the eight accounting lists and the four payroll
    lists that had the same menu with no handler or a TODO, nor the payslip's PDF button (no route makes one).
    `ExportMenu.vue` is deleted.
  - `unit/no-dead-controls.test.ts` fails on a template handler whose function only logs or does nothing, on a console
    call as a handler, and on the menu coming back. `e2e/list-report-export.spec.ts`: the report arrives with the
    filters, and Excel downloads; the five lists offer nothing.
  - *Decision:* the accounting and payroll menus and the payslip PDF went too. They are outside §1.5's eight, but
    acceptance criterion 6 is "no screen offers an Export that does nothing", and they did nothing.
- **A6** (FR-31.12): lines keep their identity.
  - The eight grids of §1.6 key their rows by `ui-shared/composables/row-key.ts#rowKey(line)`: the document line table,
    the movement, count and price list forms, the product form's price rows, the journal entry form, the journal entry
    dialog of the journal entries list, and the till's cart.
  - *Decision:* the key belongs to the line OBJECT (a `WeakMap`), not to its data, where §2.7 put a `_key` field. It is
    never written on the line, so no payload, no unsaved-edits comparison and no Pending Changes copy can carry it, and
    nothing has to strip it (FR-31.23). A line keeps its key for as long as it is the same line; a line made anew (a
    load, a restore) is a new row, as it would be with a `_key` given on load.
  - `unit/row-key.test.ts` (the key through a removal and a proxy, nothing on the line, the eight grids use it).
    `e2e/line-identity.spec.ts` removes the second of three lines: the third line's row is the same element afterwards,
    keeps a quantity typed into it, and nothing loads its article or prices again. Run against the position keys, it
    fails.
- **B1** (FR-31.13 to .15): one format, and no English.
  - `ui-shared/format` (`src/format/format.ts`) is the one formatter: `intlLocale()` (all four languages),
    `formatMoney`, `formatNumber`, `formatDate` / `formatDateTime`, and `formatPrice` / `priceDecimals` (D-5),
    `formatQuantity`, `formatUnit`, `dayInZone`. Its language is the app's (`plugins/i18n#declareLanguage` sets it);
    each function takes another in `opts.lang`. `useCurrency.formatCurrency` is that `formatMoney`.
  - D-3: `dd.MM.yyyy` in bg, de and mk (no „г."), `dd/MM/yyyy` in en, 24-hour times; built from the date's parts, so no
    browser or ICU version changes it. A day stored at midnight UTC (a document's date) is that day wherever the browser
    is, as the lists that cut the ISO string showed it. D-4: ICU's own order per language (bg, de, mk: the amount, then
    the currency; en: the currency first), with the point for decimals of 2026-11-12 (`number-display.ts`). English
    numbers are `en-US` (`$5.00`, not `US$5.00`). D-5: `PriceCombobox` shows two decimals, more only when the price has
    more, up to five (it showed five always).
  - The 41 local language → locale maps, the calls without a locale, the `Intl` formatters of the views and the ISO
    dates the lists cut out of a timestamp (`?.split('T')[0]` in 29 templates) go through it. `unit/one-formatter.test.ts`
    holds the table per language and fails on a formatting locale named, a `toLocale*` call, an `Intl` formatter or a
    `numberFormat(` outside `ui-shared/src/format/` (and its `number-display.ts`): the allow-list is empty.
  - FR-31.15: the 41 Pending Changes labels in 20 files are their fields' keys (`unit/pending-labels.test.ts` fails on
    a literal; `PermissionSetsView`, which FR-27 P3-3 removes, is the one exception and goes with the file). The bulk
    price adjustment, the stock transfer dialog, the app switcher and the price trail's "Manual override" (stored as
    before, read as `pricing.manualOverride`) speak the session's language, and so does the journal analysis view.
    `e2e/bg-walk.spec.ts` reads the headings, labels, buttons, tabs and hints of ten daily screens in a Bulgarian
    browser and finds none of its English words.
  - *Decision:* the till's cash register journal and its document keep their `YYYY-MM-DD HH:mm` (§10 leaves the till's
    flow out), and the three e2e specs that read a price field's five decimals (customer-order-tree, invoicing-product-autocomplete, pos-redirects) now read its two.
- **B2** (FR-31.16, .17): decimal fields in the four daily grids, and the app's own confirm dialog.
  - `DecimalField` now takes a decimal comma as a point on every system (a typed comma is typed as a point, a pasted
    `12,5` is pasted as `12.5`: a number field dropped the comma, so „2,5" became 25), and `minDecimals`: at least that
    many at rest, more only when the figure has them. It stays a `type="number"` field, so the grids' e2e tests, which
    find their fields by that, pass unmodified.
  - In the document line table the quantity (3 decimals, `config/price-precision#QTY_DECIMALS`), the typed price
    (4, at least 2) and the discount (2); in the movement form the quantity and the unit cost; in the count form the
    counted quantity; in the till's cart the quantity. A loaded figure is shown to the field's decimals and never written
    back unless typed (`e2e/fields-and-dialogs.spec.ts` saves a 1.23456 / 0.04723 line untouched).
  - `ui-shared/composables/confirm.ts#askConfirm({ text, confirm, danger })` returns the answer;
    `components/ConfirmDialogHost.vue` (in `web/App.vue`) draws it, its button named for the action. The three
    `confirm()` calls (delete a supplier order, delete a customer order, take over a reservation) use it.
  - `unit/fields-and-dialogs.test.ts` fails on a browser `confirm`/`alert`/`prompt` in UI source, on more raw
    `type="number"` inputs than the ceiling (85 after this slice, 92 at the audit), and on a daily grid's quantity, price
    or discount that is not a `DecimalField`. `e2e/fields-and-dialogs.spec.ts`: a comma and a point, the wheel, the
    untouched save, and both order deletions through the app's dialog with no browser dialog.
  - *Decision:* quantities show as many decimals as they have (`5`, `2.5`), not a fixed three, so a column of whole
    pieces reads as it did and the grids' tests read `5` as before.
- **B4** (FR-31.21; FR-31.20 not built): icon buttons have names.
  - The 61 icon-only buttons that named themselves in no way (an `icon="mdi-…"` or a `<v-icon>` inside, with no
    `aria-label`, `title` or tooltip) now carry a translated `aria-label` and a `title`, which is the tooltip: delete,
    close, edit, refresh, download, view, back, expand, copy, the form sidebar's toggle and its notes and activity, the app
    switcher, the theme toggle and the menus of the shell. `unit/icon-button-names.test.ts` fails on a new one.
  - The exceptions are three views FR-27 P3-3 takes apart (`UsersView`, `InvitesView`, `PermissionSetsView`), not this
    FR's to touch; they go with the files.
  - *Not built: FR-31.20 (room at 1366x768).* D-6 asks the owner to see a screenshot of each layout before it ships
    (the new invoice's folded party block and sticky line header, Products' one row per article, Sales invoices' foldable
    KPI row, the top bar's "More"). With no owner answer on #796, the layouts stay as they are, and the slice says so
    rather than ship a look nobody approved. It is a change in the browser alone, buildable once D-6 is answered.
- **B5** (FR-31.22): jump to a document by its number.
  - `GET /api/org/:orgId/lookup/documents?number=…` (`portal-api/controllers/document-lookup.controller.ts`, the work in
    `services/biz/document-lookup.service.ts`, the shapes in `config/document-lookup.ts`). It matches the number exactly
    (as typed and in capitals, since every series is written in capitals), then, when nothing matches exactly, as the
    start of a number, at most 20 listed and `more` when there are others. Over invoices of every type, supplier orders,
    customer orders, reservations and movements; an issued invoice or order is also found by its `draftNumber`.
  - A family is searched only when the caller may open its page, by the page's capability: sales documents
    (`sales-docs.view`), quotes (`proforma.view`), bills (`bills.view`), the till's documents (`cash-sales.view`), the
    orders and reservations (`orders.view`; a supplier order also `orders.browse`), movements (`movements.view`). The
    route's rule is `self` in both tables (`route-permission.ts`, `config/access/routes.ts`); a document the caller may
    not open is never in the answer.
  - Every query reads through an index on the number: the unique `{ orgId, <number> }` keys,
    `Invoice { orgId, direction, invoiceNumber }`, and a new partial `{ orgId, draftNumber }` on invoices, supplier orders
    and customer orders (built by Mongoose's autoIndex on start; no migration). A spelling is an exact value or an
    anchored, escaped prefix, which an index reads as a range.
  - The top bar: `ui-shell/components/DocumentJump.vue`, a magnifier button that opens the field under it. Enter opens
    the one match (`ui-shell/document-route.ts#documentRoute`, by route name: a till document as the cash-register
    journal opens it), lists several with the kind, the date, the contact and the draft number it was found by, or says
    there is none. Ctrl+K (⌘K) opens it from any screen (D-7); no key of the document line table or of a form is K, and
    the physical key decides in a Cyrillic layout.
  - `integration/document-lookup.flow.test.ts`: exact (any case), prefix with the limit, a draft number, several, none,
    another org's number, a role that reads only sales documents and one that reads only movements; and the explain:
    the database's profiler over every lookup shows no collection scan, and the draft numbers through their index.
    `unit/document-jump.test.ts`: every match's route name is declared by its module, every text in four languages, the
    icons shipped, the shortcut.
  - *Decision:* the field sits behind a button rather than open in the bar. The bar has no room for it at 1366 px
    (FR-31.20 is not built), and the button is in the bar on every screen; Ctrl+K types straight into it.
  - *Decision:* the families are the page's capability, not the route's read rule. The movements route also answers a
    seller (`sales-docs.view`, for a contact's movements), but the movement page does not open for one: the lookup finds
    what the caller can open, never more.
