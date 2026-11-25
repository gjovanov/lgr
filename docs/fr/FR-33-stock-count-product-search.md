# FR-33 — The stock count finds and adds articles the way an invoice does

| | |
|---|---|
| **Status** | Specified 2026-11-24. Slice A (FR-33.1 to .3) built, §11. Slice B-server (FR-33.13 to .15, .17, the lookup of .11) built, §11. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | FR-28 (one product search: the hit row, Details, the dialog that is the Products list, "Show all N results", F4, what follows a pick), FR-30.17 (the count form at 25 000 levels: built in #848 but never on master, §1.3), FR-22.28 (the receipt form, for which the line grid's keyboard, `useGridNavigation`, moved to ui-shared), FR-22.55 (Enter adds the exact barcode or SKU match, at the till and in the back-office cash sale), FR-31 (lines keyed by identity, `DecimalField`, the unsaved-edits guard, refusals that stay, the latest question wins), FR-27 (the `inventory-counts.*` capabilities, `IMPLIES`, the server prices a count: FR-27.11.C.4), FR-04 (a count and its adjustment movement) |
| **Touches** | `web/src/modules/inventory` (`InventoryCountFormView.vue`, its API module), `ui-shared` (`ProductSearch`, `ProductPickerDialog`, `product-hit`, locales), `web/src/modules/invoicing` (`ProductLineDescription`'s Enter), `config` (`access/levels.ts`, one import-pure text matcher), `api/warehouse` (`inventory-count.controller.ts`, a product code lookup), `api/invoicing` (`pos.controller.ts`: its lookup moves out), `services` (`inventory-count-pricing.ts`, the code lookup), `tests`, `e2e` |
| **Tracking** | [gjovanov/lgr#933](https://github.com/gjovanov/lgr/issues/933) |
| **Code anchors** | origin/master `1cc60a46` (2026-11-24). Anchors, not gospel. |

## 0. The request (owner, 2026-11-24)

> create FR for improving inventarisation (create/edit) https://lgrai.app/inventory/inventory-counts/new to have the same consistent product search/election like invoices.

Read as: on the stock count's new and edit pages, an article is found, chosen and put on a line the way it is on an invoice. That means the same search in the line, the same result row, the same Details dialog for one article or several, the same keys, and the same next step after a pick. A count has rules an invoice does not have (§1.4), and they come with the search.

| Part of the request | Where | Requirements | Slice |
|---|---|---|---|
| The same search: type in the line, the result row, F4 and Details, "Show all N results" | §2.2 | FR-33.4, .11, .12 | B |
| The same selection: the Details dialog, several articles at once, what the count already holds marked | §2.3 | FR-33.5, .7 | B |
| The same behaviour: the cursor after a pick, a fresh line, the keyboard, add and remove a line | §2.2 | FR-33.6, .8, .9 | B |
| Create **and** edit | §2.1 | FR-33.10 | B |
| What a count must hold once articles can be added by hand | §2.4 | FR-33.13 to .17 | B |
| Usable in a warehouse of tens of thousands of levels | §1.3, §2.5 | FR-33.1 to .3 | A |

## 1. What is wrong today

### 1.1 The count form

`InventoryCountFormView.vue` has a header (warehouse, date, type: full, partial or cycle) and a plain table of lines: the article's name as text, System, Counted (a `DecimalField`) and Variance.

- **The only way to get lines is "Load products"** (`loadProducts`, lines 194-209). It reads every stock level of the warehouse (`GET /warehouse/stock-level?fields=count&size=0`, the lean "all" of FR-30.8) and makes each one a line with Counted equal to System. The button is shown on a new count only (`v-if="!isEdit"`, line 40).
- **No article can be added on its own.** There is no product field, no Details, no "+ Add line", no way to remove a line, no line number, no SKU, no unit, and no keyboard navigation across the grid.
- **So the form makes one kind of count: every level of the warehouse.** A partial or cycle count, which the Type field offers, cannot be made. An article the warehouse has no level for (goods found on the shelf) cannot be counted at all. A count in progress cannot be extended.
- The type changes nothing: it is a label.

### 1.2 What the invoice's lines do

FR-28 made one product search for every screen that picks an article. A count line has none of it:

| | Invoice line (`DocumentLineTable`) | Stock movement line (`MovementFormView`) | Count line today |
|---|---|---|---|
| Field | `ProductLineDescription`: a text field with its own list; free text allowed | `ProductSearch`: an autocomplete; the line must name an article | none, the name as text |
| Search | 2 characters, 300 ms, ten active articles (`product-hit.ts#searchProductHits`) | the same | none |
| Result row | the name; `SKU · unit · stock · price` (FR-28.24) | the same | none |
| Details | F4, `ProductDetailsButton`, "Show all N results": `ProductPickerDialog`, the Products list in a window, several at once, the articles already on the document marked (FR-28.25, .28) | the same | none |
| After a pick | the cursor on the quantity, a blank line when the last one was filled (FR-28.27) | the same | none |
| Enter in the field | takes the highlighted hit: the first, until ↓ moves on | picks nothing: it opens the list, and ↓ comes first | none |
| Keyboard | `useGridNavigation`: Tab, Enter and the arrows move between cells; past the last line a new line | the same | none |
| Lines | "+ Add line", × on each line, a line number | "+ Add line", × | neither |

The two fields stay two fields because they do two jobs (FR-28 §2.4). An invoice line is a description that may stay free text. A movement line must name an article, and so must a count line. **The count's field is therefore `ProductSearch`, the movement's.** The search, the result row, Details and the keys are the same as the invoice's.

### 1.3 FR-30.17 is not on master

FR-30 (#795) measured this form at 23 040 levels. The rows appeared after 190 s, the page held 438 104 DOM nodes, and one keystroke took 7.3 s to paint. FR-30.17 specified the fix: a virtual table, a search over the lines, and two filters.

**PR #848 built it, but it is not on master.**
- #848 reported 414 ms to the first rows, 706 nodes and 33 ms per keystroke.
- It was merged on 2026-11-17 at 22:15Z into its base branch, `feat/795-fr30-b-requests-payloads`. That branch's own PR, #827, had already been merged to master at 21:33Z the same evening.
- Its merge commit, `a34e3d30`, is therefore on that branch only, together with `e2e/tests/count-form-scale.spec.ts`. Production runs the plain table.
- FR-30's status line lists slices A, B, C, D, F and G as built, not E. Issue #795 is closed.

The form has changed since then:
- it moved to `packages/web/src/modules/inventory/views/` (FR-24, #421);
- it reads through a typed API module (#859);
- its quantity field became `DecimalField` (#836).

So #848 does not apply as it is.

An invoice-like grid with a search field in every row would make the slow form slower. FR-33 takes FR-30.17 in as its first slice, and the search is built on top of it.

### 1.4 What a count needs that an invoice does not

- **One line per article.**
  - The completion (`POST /:id/complete`, `inventory-count.controller.ts:180-268`) books one adjustment line for every count line whose variance is not zero. Each is measured against its own stored System figure.
  - Two lines of one article (System 10, Counted 8 on each) book −2 twice. The stock falls to 6 while the shelf holds 8.
  - The form cannot make such a count today: its lines come from stock levels, which are unique per article and warehouse. The routes accept one anyway: neither POST, PUT nor the completion checks.
  - An invoice keeps a repeated article as a line of its own (FR-28.28). A count must not.
- **System is the form's snapshot.**
  - The routes store the `systemQuantity` the body sends. The completion books `countedQuantity − systemQuantity` (`priceCountLines`).
  - "Load products" takes System from the level's `quantity`. An article added by hand needs the same figure, read the same way, at the moment it is added.
  - An article with no level in the warehouse has System 0.
- **Found goods would be booked at cost 0.**
  - The server prices a line from the level's `avgCost` in the count's warehouse (`services/src/biz/inventory-count-pricing.ts`, FR-27.11.C.4). With no level, the price is 0.
  - The adjustment then opens the level at an average cost of 0 (`adjustStock` creates the row with `avgCost: unitCost`). Every later sale of those goods would cost nothing.
  - The form cannot reach this today. FR-33 makes it reachable.
- **A count role's reach.**
  - The built-in roles that make counts also hold `products.lookup` and `stock-levels.lookup` (`config/src/access/template-caps.ts`).
  - `config/src/access/levels.ts#IMPLIES` does not derive them from `inventory-counts.create` or `.edit`, as it does for `movements.create:transfer` (line 138).
  - A custom role saved with the count capabilities alone would get a search that answers 403. The same is true of "Load products" today.
- **A scanner.**
  - The till and the back-office cash sale add a scanned code with no list (FR-22.55). `GET /trade/pos/catalog/lookup` answers the exact barcode, else the exact SKU, else the one article the search finds.
  - FR-28.24 asks the same of every product field ("a scanned code that matches one article is added with no list"). No document line has it yet: there, a scanner's Enter arrives before the 300 ms pause has asked anything.
  - The lookup (`lookupCatalogCode`, `pos.controller.ts:377-405`) is private to the till's routes.
  - In a stock count, a scanner is the natural tool.

### 1.5 Three defects of today's form, read in the code (not reproduced)

They are older than this FR. Adding articles by hand makes each of them easier to hit.

1. **The warehouse can change under the lines.**
   - The Warehouse select is disabled only on a completed count (line 26). An in-progress count keeps its lines, with the System figures of the first warehouse, when another warehouse is chosen.
   - PUT stores the new `warehouseId` with those lines, and the completion books the first warehouse's figures against the second.
2. **Complete does not book what the screen shows.**
   - "Complete count" (`completeCount`, lines 252-265) completes the count as it was last saved.
   - Quantities typed since then are not booked, and nothing says so.
3. **Enter can pick an article for an earlier text.**
   - In the invoice line's field, Enter picks the highlighted row of the list on screen (`ProductLineDescription.vue:322-329`).
   - While the answer to newly typed text is still on its way (the 300 ms pause, then the request), the list is the previous text's. A quick Enter puts that article on the line.
   - FR-31.4 made a late answer lose to a newer one. This is the earlier gap, before the newer answer exists.
   - The Details dialog already waits for the search to settle before Enter picks (`ProductPickerDialog.vue#settled`).

## 2. Design

### 2.1 The page

```
 Inventory Count  IC-2026-00012                                   [ Save ] [ Complete count ]
 Warehouse [ Main            v ]  (locked: the count has lines)   Date [ 24.11.2026 ]   Type [ Partial v ]

 Count lines                                                           [ Load products ]  [ + Add line ]
 [ Find in this count: name, SKU, code ]   ( All | Not counted yet | With a difference )      3 / 3
  #  | Article                                  | Unit | System | Counted   | Difference |
  1  | Hex bolt M8x40              PRD-0042     | pcs  |     4  | [     4 ] |         0  |  x
  2  | Hex bolt M8x50              PRD-0043     | pcs  |    31  | [    29 ] |        -2  |  x
  3  | Washer M8 DIN 125           PRD-0107     | pcs  |     0  | [    50 ] |       +50  |  x   <- not stocked here
     | [ Type or scan an article...                     ] [Details]                         <- the entry line
          Hex bolt M8x60
          PRD-0044 · pcs · Main: 12
          Hex bolt M8x70
          PRD-0045 · pcs · Main: 0
          Show all 37 results...
```

The new page and the edit page are one form, as today. Everything below applies to both, while the count is in progress. A completed count reads as it does today: no entry line, no ×, no Load, no Details.

### 2.2 One search, the count's field

- **The entry line** is the last row of the lines. It holds `ProductSearch` and the Details button, the movement's pair (§1.2):
  - two characters, 300 ms, ten active articles;
  - the FR-28.24 row with the stock of the count's warehouse ("Main: 12") and no price, because a count prices nothing;
  - "Show all N results" as the last row;
  - F4 and the button open Details with the typed text.
  - It is disabled, with a hint, until a warehouse is chosen: System depends on it.
- **A pick** puts the article on a line. The line shows the article as text (name, SKU), its unit, System (§2.4), and Counted, starting at System (D-5). The cursor goes to Counted with the figure selected, so typing replaces it. A new entry line follows.
  - The FR-28.27 rule applies: the cursor moves only if it is still where the pick left it.
  - The line counts as *not counted yet* until a quantity is typed.
- **A line's article does not change** once it is on the count (D-6). The × removes the line, and the right article is added. System belongs to the article it was read for. A search field in every row is also what made a large count unusable (§1.3).
- **An article already on the count** never makes a second line. Its line is brought into view and highlighted (the line filter is cleared if it hid it), and the cursor goes to its Counted, with "Already on the count: line 2". This holds for a pick from the search, from Details and from a scan.
- **Enter takes the first hit**, or the one ↓ moved to, as on an invoice line. It takes only an answer to what the field holds: while that answer is on its way, Enter waits for it. `ProductSearch` answers Enter this way on its two other screens too, the stock movement and the price list (D-9). The invoice line's field gains the waiting (§1.5.3), so every product field answers Enter alike.
- **A scanner** (SHOULD). Enter on a code that names exactly one article adds it, or shows its line, with no list. The rule is the till's: exact barcode, else exact SKU, else the one article the search finds. A code that names none, or several, leaves the list open on it. Enters are taken in turn, as at the till.
  - The rule moves from `pos.controller.ts` into `services`. The till and a new `GET /warehouse/product/lookup` both call it, so a count role needs no till rights.
- **The keyboard** is `useGridNavigation`, as on invoices and movements:
  - Tab and Shift+Tab move across the cells.
  - Enter and Shift+Enter move down and up the Counted column, which is how a printed list is counted.
  - Past the last line, the cursor goes to the entry line.
- **"+ Add line"** puts the cursor in the entry line. There is always exactly one entry line.
- **The line number** is the line's place in the count. It does not change when the lines are filtered, so "line 2" can be found.

### 2.3 Details: one article, or a whole shelf

The Details dialog is `ProductPickerDialog` as FR-28 built it, with these props:
- `multiple`;
- `stockWarehouseId` = the count's warehouse, which scopes the figures and never the rows;
- no `priceField`;
- `existingProductIds` = the count's articles, marked with the check FR-28.28 shows;
- the typed text carried in.

Its filters are the Products list's, among them category, tags, supplier (for a role that reads bills), a stock range, out of stock, below minimum and status. Page sizes go up to All (at most 1 000 rows, FR-30.8), and the header box ticks the page. **A cycle count of a category, or of the articles below their minimum, is then a few clicks.**

"Add N articles" adds each ticked article that is not on the count yet, in the order ticked, and says how many were already there. System for all of them comes from **one** stock request (`stock-level/by-products` for the count's warehouse), never one request per article.

A deactivated article that still has stock is found in Details with Status set to All. The search lists active articles only (FR-28).

### 2.4 What a count line is

- **One article, one line**, held by the form (§2.2) and refused by the server: POST, PUT and the completion answer 422 `count_article_repeated` and name the articles.
  - The count that a manual adjustment makes for itself (FR-04, `movement.controller.ts:596-668`) records a movement already booked. It is created completed, never edited or completed through these routes, and is left as it is.
- **System** is the warehouse's on-hand `quantity` of the article when the line is added, as "Load products" reads it. It is 0 with the hint *not stocked here* when the warehouse has no level. It is not read again later: the snapshot rule of today stands (§10).
- **Found goods** (no level, or a level without an average cost) are priced by the server from the cost of D-4, on save and again at the completion. The body's cost is still ignored (FR-27.11.C.4).
- **The warehouse is locked while the count has lines.** The select says why. Removing every line unlocks it. PUT refuses a change of `warehouseId` on a count with lines: 422 `count_warehouse_locked`.
- **Complete books what the screen shows.** With unsaved edits it saves first, then completes, as one action. A refused save completes nothing and says why.
- **"Load products"** keeps its name, and is offered on a new count and on an in-progress one, for every type (D-1). On a count that already has lines, it adds the levels not yet on it, and the lines already there keep what was typed.

### 2.5 At shop volume

FR-30.17 as #848 built it, at the new path:
- a plain table up to 200 lines, a virtual one above, keyed by the article;
- the line filter, *Not counted yet* and *With a difference*, and the "shown / total" figure;
- the Counted column keyed apart from its value, so that a keystroke does not make the table read every row again.

Two things are added:
- **The entry line stays in view** under the rows when a long count scrolls. It is drawn outside the virtual rows, so it is never virtualised away.
- **The line filter matches the way the product search does**: every word, in any case, with Latin and Cyrillic look-alikes read as one letter (`search.utils.ts`, `HOMOGLYPH_PAIRS`).
  - The pairs move to one import-pure matcher in `config`. The server's filter builder and the form both use it.
  - The filter reads name, SKU and barcode. The lean answer of `fields=count` gains the barcode.

### 2.6 What stays

- **The count's payload.** The body keys are `date, itemCount, lines, notes, type, varianceCount, warehouseId`, and a line's are `countedQuantity, productId, systemQuantity, variance`. `e2e/tests/inventory-count.spec.ts:64-65` asserts both.
  - The entry line is never sent.
- **The answers of the count routes.**
- **The completion's arithmetic**, apart from the price of found goods (D-4).
- **The till's lookup**, which answers as it does today.
- **The stock movement and price-list lines**, apart from Enter (FR-33.12, D-9).
- **Route names**: `inventory.inventory-counts`, `inventory.inventory-counts.new` and `inventory.inventory-counts.edit`.
- **FR-28's specs, and the walks P0 to P9.**

## 3. Requirements

### 3.1 The lines at shop volume (slice A)

**FR-33.1 — The count's lines at 25 000 (MUST).** FR-30.17's budgets, on FR-30's fixture:
- the first rows within 3 s;
- at most 10 000 DOM nodes;
- a keystroke in Counted paints within 100 ms.

The lines are a plain table up to 200 and a virtual table above, keyed by the article. What is saved is what the plain table saved. #848's code (`a34e3d30`) is the starting point, moved to `packages/web/src/modules/inventory/views/InventoryCountFormView.vue` and its typed API, with `DecimalField` kept.

**FR-33.2 — Finding a line (MUST).**
- A filter over the count's lines narrows by name, SKU or barcode. It matches every word, in any case, with Latin and Cyrillic look-alikes as one letter.
- *Not counted yet* and *With a difference* filter the rows. "shown / total" says how many are shown.
- A quantity typed into a row stays with its article when the rows are filtered or scrolled.
- One import-pure matcher in `config` holds the look-alike pairs. The server's product filter and the form both use it, and a unit test holds the two to the same answers on a fixed word list.

**FR-33.3 — The record of FR-30 (MUST).** When slice A ships, FR-30's §11 records slice E as built by it. This document's pull request already says so in FR-30's status line, and #795 carries a comment that points here.

### 3.2 Finding and adding an article (slice B, UI)

**FR-33.4 — The line's search (MUST).**
- The entry line holds `ProductSearch` and `ProductDetailsButton`: two characters, 300 ms, ten active articles.
- A hit is the FR-28.24 row with the count warehouse's stock and no price.
- "Show all N results" and F4 open Details with the typed text. ↓ and ↑ move through the hits, Enter takes one (FR-33.12), and Escape closes the list.
- The field is disabled until a warehouse is chosen, with a hint.

**FR-33.5 — Details (MUST).**
- `ProductPickerDialog` with `multiple`, `stockWarehouseId` set to the count's warehouse, no `priceField`, the typed text, and the count's articles marked.
- "Add N articles" adds each ticked article that is not on the count yet, in the order ticked, and says how many were already there.
- Adding N articles makes one stock request, not N (a test counts them).

**FR-33.6 — What follows a pick (MUST).**
- The new line shows the article as text (name, SKU), its unit, System, and Counted equal to System (D-5).
- The cursor goes to Counted with the figure selected, and a new entry line follows. This is FR-28.27's rule: only while the cursor is where the pick left it.
- System is the warehouse's on-hand quantity now. It is 0 with the hint *not stocked here* when there is no level.
- The line is *not counted yet* until a quantity is typed.

**FR-33.7 — An article already on the count (MUST).**
- No second line, from the search, from Details or from a scan.
- Its line is brought into view, even past rows not yet drawn and through a filter that hid it, and highlighted.
- The cursor goes to its Counted, and a message names the line.

**FR-33.8 — The keyboard (MUST).**
- `useGridNavigation`, as on invoices and movements: Tab and Shift+Tab, Enter and Shift+Enter down and up the column, the arrows.
- Past the last line, the cursor goes to the entry line.
- Enter walks down the Counted column of a 25 000-line count, past the rows the virtual table has not drawn yet.

**FR-33.9 — Lines (MUST).**
- "+ Add line" puts the cursor in the entry line.
- × removes a line while the count is in progress.
- The line number is the line's place in the count and holds when the lines are filtered.
- A Unit column (the lean answer already carries `productUnit`).
- A line's article does not change once it is on the count (D-6).
- A completed count shows no entry line, ×, Load or Details.

**FR-33.10 — Create and edit alike (MUST).** Every part of §3.2 works on a new count and on the edit page of an in-progress count. "Load products" is offered on both. On a count with lines it adds only the levels not yet on it, and the lines already there keep what was typed (D-1).

**FR-33.11 — A scanner (SHOULD).**
- In the count's field, Enter on a code that names exactly one article adds it, or shows its line (FR-33.7), with no list. The rule is FR-22.55's: exact barcode, else exact SKU, else the one article the search finds.
- A code that names none or several leaves the list open on it. Enters are taken in turn.
- The rule is one function in `services`, called by the till's `/trade/pos/catalog/lookup` (its answers unchanged) and by `GET /warehouse/product/lookup?code=`, which answers under the read rule of `GET /warehouse/product`.

**FR-33.12 — Enter takes the first hit of what the field holds (MUST).**
- In `ProductSearch`, Enter takes the first hit, or the one ↓ moved to, as the invoice line's field does. Today it picks nothing and only opens the list. This holds wherever the field is used: the count, the stock movement and the price list (D-9).
- Tab still leaves the field without a pick. Vuetify's `auto-select-first` would make Tab pick too, so it is not the way to build this.
- In `ProductSearch` and in `ProductLineDescription`, Enter never puts on a line a hit that answers an earlier text. While the answer to what the field holds is on its way, Enter waits for it, then takes its first row. With FR-33.11, it takes the code's one article.
- A test types a second word and presses Enter within the pause, with the first answer still on screen, on an invoice line and on a count line.

### 3.3 What a count must hold (slice B, server, shipped before the UI)

**FR-33.13 — One line per article (MUST).**
- POST, PUT and `/complete` refuse a count whose lines name an article twice: 422 `count_article_repeated`, naming the articles. `/complete` refuses before it books anything.
- The count an adjustment makes for itself (FR-04) is not refused, edited or completed through these routes.
- §4: a read-only count on production first.

**FR-33.14 — The warehouse of a count with lines (MUST).**
- The form locks the Warehouse select while the count has lines, and says why. Removing every line unlocks it.
- PUT refuses a change of `warehouseId` on a count that has lines: 422 `count_warehouse_locked`.

**FR-33.15 — Found goods (MUST).**
- A line for an article with no level in the count's warehouse, or a level without an average cost, is allowed and shows System 0.
- `priceCountLines` prices it at the cost of D-4 on save and at completion, never from the body, so its adjustment does not open the level at an average cost of 0.

**FR-33.16 — Complete books what the screen shows (MUST).**
- With unsaved edits, Complete saves them and then completes, as one action, with one spinner.
- A refused save completes nothing, and the refusal stays at the top of the form (FR-31.8).

**FR-33.17 — Access (MUST).**
- `IMPLIES` gives `inventory-counts.create` and `inventory-counts.edit` the capabilities `products.lookup`, `stock-levels.lookup`, `warehouses.lookup` and `categories.lookup`.
- A role saved with the count capabilities alone can search, open Details, use "Load products" and add.
- The count form shows no cost: the hit carries no price, and the dialog's cost columns follow `products.costs`, as on the Products list.

### 3.4 Across this FR

**FR-33.18 — Contracts that do not move (MUST).**
- The payload and answers of §2.6.
- `inventory-count.spec` passes. Its row count reads the lines that hold an article, because the entry line is a row too.
- FR-28's `product-search.spec` passes unmodified. The walks P0 to P9 stay inside their budgets.
- The till's lookup answers as before.

**FR-33.19 — Guards, languages, data, Windows (MUST).**
- The tenant, access and replication guards pass unmodified. The reference guard of S-35 already refuses another organization's article on a line, so nothing new is needed for it.
- Every new text exists in `en`, `bg`, `de` and `mk`.
- No test, fixture, issue or pull request carries a customer's name or figure.
- No new test uses `.rejects` or `.resolves`.

**FR-33.20 — A walk (SHOULD).** A new walk, P10: a new partial count of four articles, two found by the search, two ticked in Details, with three quantities typed and the count saved.
- Today it cannot be done.
- Target: at most 10 clicks, 6 typed fields and 1 dialog.

## 4. Migration

| What | Change | Procedure |
|---|---|---|
| Counts with a repeated article | refused from now on | Before the deploy, a read-only count on production: in-progress counts whose lines name an article twice (none expected; the form cannot make one). Any found are named to the owner, because their next save would be refused. Completed counts are not touched |
| Counts whose warehouse changed under their lines | none can be told apart afterwards | Nothing to migrate. The lock applies from the deploy |
| Roles | `IMPLIES` grows | A role takes the implied capabilities when it is saved. Before the deploy, a read-only count of the custom roles that hold `inventory-counts.create` or `.edit` without `products.lookup`. If there are any, a migration adds the four capabilities to them (on-prem masters run it at their next start) |
| The lean stock levels | `productBarcode` added | Additive. Nothing stored |
| The code lookup | moved | No data. The till's answers are compared before and after (a test) |
| The count's lines | unchanged | Nothing stored changes shape |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| A | FR-33.1 to .3 | a large count opens and can be filled in; a filter and two toggles over the lines | FR-30.17's three budgets on the fixture; `inventory-count.spec` unmodified |
| B-server | FR-33.13 to .15, .17, the lookup of .11 | a repeated article and a warehouse change are refused; found goods carry a cost | the flow tests of §6 |
| B-UI | FR-33.4 to .12, .16, .18 to .20 | the search, Details, the keys and the scanner on the count | the e2e of §6; the walks; P10 |

**Order.** A first: it stands alone and returns work that was already done. B-server next, so that the UI never meets a server that would accept a repeated article. B-UI last. FR-33.12 touches the invoice line's field, and is built and tested in B-UI with FR-28's specs.

**Rollback.** Each slice is one revert. B-server's refusals are on routes the form is the only writer of. The lookup keeps the till's answers.

**Risks.**
- *Keyboard navigation over a virtual table.* `useGridNavigation` walks the rows in the page, and a virtual table draws only some of them. FR-33.8's test walks past the drawn rows. If the walk cannot be made reliable, the count keeps Enter down the column only, and §11 says so.
- *An Enter that now picks, or waits.* FR-33.12 changes the invoice line's field, and `ProductSearch` on the movement and price-list screens. It waits only inside the pause. No spec presses Enter in `ProductSearch` today, and FR-28's specs and the walks hold the rest.
- *A cost for found goods that is wrong for the business.* D-4 is the owner's, and it is one function.

## 6. Tests

- **Unit.**
  - The matcher: the look-alike pairs, the words, the case, and its equivalence with the server's filter on a fixed word list.
  - The line rules: a repeated article from the search, Details and a scan; System for N articles from one answer; Counted starting at System; the entry line never in the payload.
  - `IMPLIES` for the two count capabilities.
- **Flow** (extending `count-completion.flow` and `count-movement-marriage.flow`; the role case beside the `access-*.flow` tests).
  - 422 `count_article_repeated` on POST, PUT and `/complete`, with nothing booked.
  - 422 `count_warehouse_locked` on PUT, and an empty count still changes its warehouse.
  - Found goods priced at D-4, and the level opened at that cost by the completion.
  - The adjustment's own count is still made for a movement with a repeated article.
  - A role with the count capabilities alone reads products, stock levels, warehouses and categories.
  - `GET /warehouse/product/lookup` and the till's lookup answer alike on barcode, SKU, search and ambiguity.
- **E2E** (`inventory-count.spec`; `count-form-scale.spec`, recovered from #848; a new `count-search.spec`).
  - The search on a new and on an edit page: the hit row, the pick, the cursor in Counted, the next entry line.
  - F4 and "Show all": three ticked articles become three lines with one stock request.
  - A repeated article shows its line.
  - A found article shows System 0 and the hint.
  - The warehouse is locked, and unlocked by removing the lines.
  - Complete with unsaved edits books them.
  - The keyboard over 25 000 lines, and FR-30.17's budgets.
  - The payload keys.
  - Enter within the pause on an invoice line and on a count line, and Enter taking the first hit on a movement line.
- **Guards, unmodified**: `product-search.spec`, `ux-budgets`, `tenant-isolation.flow`, the till's lookup specs.

## 7. Acceptance criteria

1. On the new and the edit page of a count, an article is found, picked and counted as on an invoice: the same hit row, Details, F4, "Show all", keys, and next step after a pick.
2. A partial count of articles chosen one by one, and a cycle count of a category through Details, can each be made, saved, reopened, extended and completed.
3. No count can hold an article twice, through the form or the API, and no completion books one twice.
4. A count's warehouse cannot change under its lines, and Complete books what the screen shows.
5. Found goods are booked at the cost of D-4, never silently at 0.
6. A count of 25 000 levels meets FR-30.17's three budgets on the fixture.
7. A role made with the count capabilities alone can do all of the above.
8. The existing suites pass unmodified, apart from the one row count of FR-33.18. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.
9. No test, fixture, comment or pull request carries a customer's name or figure.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

The demo organization is small, so production proves the behaviour and the fixture proves the speed. **A count is never completed on production**: a completion books an adjustment movement.

1. **Slice A.** Make a count in a demo warehouse, load its stock, filter by a Cyrillic word typed with a Latin look-alike, type three quantities, switch to *With a difference*, save, and open it again.
2. **Slice B-server.** Through the API, as a demo admin: a count with a repeated article is refused on POST and on PUT, and a warehouse change on a count with lines is refused. Delete what was made.
3. **Slice B-UI.** On a new partial count:
   - add two articles by the search and three through Details;
   - pick one of them again and see its line shown;
   - add an article the warehouse has no level for;
   - type quantities with Enter down the column;
   - save, reopen, add one more on the edit page, and save.
   - Measure the hit row and the dialog at 1366 and 1920 px, in `en` and `bg`.
4. **Clean up.** Delete every count the test made, and report the number left (0).

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | Where "Load products" is offered | On a new and on an in-progress count, for every type. On a count with lines it adds only what is missing |
| D-2 | A second pick or scan of an article already on the count | Shows its line, with the cursor in Counted. The counter types the total. (The till's way, one more unit per scan, is the alternative) |
| D-3 | Create an article from the count's line („+ Нов продукт", as on bills and receipts) | Not offered. A count checks the stock of articles the catalogue knows, and a hurried card risks a look-alike twin |
| D-4 | The cost of found goods (no level, or no average cost, in the count's warehouse) | The article's purchase price; 0 only when it has none. Alternatives: today's 0, or a refusal to complete until a cost is known |
| D-5 | Counted on a line added by hand | System, selected, so typing replaces it and a line left untouched books nothing |
| D-6 | Changing a line's article | Not offered: × and add again. An invoice line lets the article be picked again. The count's System belongs to the article it was read for, and a field per row is what made a large count unusable |
| D-7 | Where the entry line sits | The last row. On a long count it stays in view under the rows |
| D-8 | The Type field | Stays a label. "Full" does not load the stock by itself |
| D-9 | Enter in `ProductSearch` on its two other screens, the stock movement and the price list | As on the count: Enter takes the first hit. It is one field, and FR-28 made one search. (The alternative keeps their ↓ then Enter, and gives the count a field of its own) |

## 10. Not in this FR

- **A blind count**, where the counter does not see System. Today's form shows it, and so does the hit row.
- **Reading System again at completion** for stock that moved while the count was open. Today's snapshot stands.
- **Count lines held by the server** (FR-30.18), unless FR-33.1's budgets cannot be met in the browser.
- **Several people counting one count at the same time.** The last save wins today, and still will.
- **Bins and locations** inside a warehouse, and printed count sheets.
- **The scanner on the invoice lines.** FR-28.24 asks for it, and FR-33.11's lookup makes it a small follow-up.
- **Widths below 1366 px.**

## 11. Build log

### Slice A (FR-33.1 to .3), 2026-11-25

**What was built.**
- **FR-30.17 at the moved path (FR-33.1).** #848's change (`a34e3d30`), ported by hand to `web/src/modules/inventory/views/InventoryCountFormView.vue`: its typed API (`listStockLevels`, `getInventoryCount`) and `DecimalField` kept. The lines are a plain `v-data-table` up to 200 and a `v-data-table-virtual` above, both keyed by the article (`item-value="productId"`). The Counted column is keyed `qty`, so a keystroke does not make the table read every row again. What Save sends is unchanged.
- **The line filter (FR-33.2).** Name, SKU or barcode, every word, in any case, Latin and Cyrillic look-alikes as one letter. *Not counted yet* and *With a difference*, and "shown / total".
  - The look-alike pairs moved from `services/biz/search.utils.ts` to `config/search-text.ts` (import-pure): `HOMOGLYPH_PAIRS`, `searchKeywords`, `homoglyphPattern` (the server's letter classes) and `searchTextMatcher` (the form's fold). The server's product filter and the form read the same pairs.
  - The lean answer of `fields=count` carries `productBarcode`, and so does `GET /inventory-count/:id`'s line, so an edit page filters by barcode too. Both are added keys; nothing an answer had changed.
- **FR-30's record (FR-33.3).** FR-30's status line lists slice E as built, and its §11 has slice E.

**Not in this slice.** The entry line that stays in view under the rows (§2.5) is B-UI's: slice A adds no row to the table, so `inventory-count.spec` runs unmodified.

**Tests.** `unit/search-text.test.ts` (the pairs both ways, the words, the case, and the form's matcher against the server's two product filters, the five-field one and the joined field, on a fixed word list); `e2e/count-form-scale.spec.ts` (#848's spec: the three budgets, the filter by name and SKU, a typed quantity through the filters, both toggles' counts, the saved payload; and now a name typed with a Latin look-alike and a barcode); `unit/row-key.test.ts` (the count's rows keyed by the article); `integration/list-projection.flow.test.ts` (the barcode on the lean answer). `inventory-count.spec` unmodified.

### Slice B-server (FR-33.13 to .15, .17, the lookup of .11), 2026-11-25

**What was built.**
- **One line per article (FR-33.13).** `services/biz/inventory-count-lines.ts#articleRepeatedRefusal`, called by `POST /warehouse/inventory-count`, by `PUT /:id` when the body carries lines, and by `POST /:id/complete` on the count as it stands under the completion's hold, before it prices or books anything. 422 `{ code: 'count_article_repeated', message, articles, productIds, repeated: [{ productId, name, sku, lines }] }`: `articles` is the names and SKUs as one text (the catalogue's `{articles}`), `lines` the 1-based line numbers. A refused POST draws no count number. The count a manual adjustment makes for itself (FR-04) is written through the repository by `movement.controller`, created completed, and meets neither rule.
- **A count with lines keeps its warehouse (FR-33.14, server half).** `warehouseLockedRefusal`: 422 `{ code: 'count_warehouse_locked', message, lines }` when a PUT names another `warehouseId` on a stored count that has lines and the count as it would be saved still has some. A count with no lines changes its warehouse, with or without first lines in the same save; a PUT that names another warehouse with `lines: []` empties and moves it in one save. ⚠ For B-UI: the form that removes every line, picks another warehouse and adds new lines before one Save sends a PUT the server refuses (the stored count still has the old lines). It saves the emptied count first, or the select stays locked until the empty count is saved.
- **Found goods (FR-33.15, D-4).** `priceCountLines` prices an article with no level in the count's warehouse, or a level whose `avgCost` is not above 0, at the article's `purchasePrice` (0 when it has none), on save and again at the completion. One product read, for those lines only. The completion's adjustment carries that unit cost, so `adjustStock` opens the level at it.
- **The code lookup in `services` (FR-33.11, server half).** `services/biz/product-code-lookup.ts`: `lookupProductCode` (exact barcode, else exact SKU, as typed then in any case, else the one active article the search finds; never a guess) and the terminals' `catalogFilter`, both moved out of `pos.controller.ts` unchanged. The till's `GET /trade/pos/catalog/lookup` calls it and answers as before. `GET /warehouse/product/lookup?code=` calls it too and answers `{ product, matchedBy }` (the article as `GET /warehouse/product/:id` answers it, through `redactProduct`), or `{ product: null, matchedBy: null }`. Its read rule is the `warehouse/product` prefix's, so `products.lookup` reads it.
- **Access (FR-33.17, server half).** `IMPLIES` gives `inventory-counts.create` and `inventory-counts.edit` the capabilities `products.lookup`, `stock-levels.lookup`, `warehouses.lookup` and `categories.lookup`. The built-in roles that count (Manager, Warehouse Manager) already hold all four, so no built-in role's access changes. A role takes them when it is next saved (`withImplied`); §4's read-only count of custom roles decides whether a migration is needed, and none is written here.
- **Languages.** `warehouse.refusals.count_article_repeated` and `.count_warehouse_locked` in en, bg, de and mk, and both codes in `ui-shared/composables/stock-refusals.ts#STOCK_REFUSAL_CODES`, for the B-UI form to show.

**Not in this slice.** B-UI (FR-33.4 to .12, .16, .18 to .20): the entry line, Details, the keyboard, the scanner in the form, the lock in the form, and Complete saving first. §4's two read-only counts on production come before this slice's deploy: in-progress counts that name an article twice (their next save would be refused), and custom roles holding `inventory-counts.create` or `.edit` without `products.lookup`.

**Tests.** `integration/count-lines.flow.test.ts`: 422 `count_article_repeated` on POST (nothing saved, no number drawn), PUT (the count unchanged) and `/complete` (nothing booked, the hold given back); the adjustment's own count still made for a movement with a repeated article; 422 `count_warehouse_locked` on PUT, and an empty count, and a PUT that empties the lines, still changing the warehouse; found goods at the purchase price on save and at completion, the level opened at that cost, an article with no purchase price at 0, a stocked article still at its average cost, and an article stocked in another warehouse only priced as found goods; the warehouse lookup and the till's answering alike on barcode, SKU, case, search, ambiguity and nothing; `withImplied` for the two count capabilities; a role saved through `POST /roles` with the count capabilities alone reading products, the lookup, stock levels, warehouses and categories, with no cost or price on the hit, and making a count. `unit/stock-refusals.test.ts` reads the new service for the two codes. `integration/foreign-references.flow.test.ts`: its count case moves the count to another org's warehouse with `lines: []`, so that the reference guard, not the lock, is what refuses it. `pos-catalog-lookup.flow.test.ts` unmodified.

### FR-33.12 (Enter takes the first hit of what the field holds), 2026-11-25

**What was built.**
- **One search behind both product fields**, `ui-shared/composables/field-search.ts#useFieldSearch`: the 300 ms pause, the request through `latestOnly` (FR-31.4), and the text the list answers. `ProductSearch` and `ProductLineDescription` both search through it, as they did by hand before.
  - **A late answer to an earlier text is dropped.** The list takes an answer only while the field still holds the text it was asked for. A slow answer to the first word that lands in the pause after the second was not stopped by FR-31.4 (the second word's request had not gone yet).
  - **Enter takes only an answer to what the field holds** (`enter`). While that answer is on its way, Enter waits for it, then takes its first row. A changed text, a failed search or 3 s (`ENTER_WAIT_MS`) ends the wait with nothing taken. Enter waits only while an answer is on its way. When none is coming, it takes nothing at once.
- **`ProductSearch`** (the stock movement and the price list today, the count next, D-9): Enter in the field takes the first hit. Before, it only opened the list. ↓ then Enter still takes the row ↓ moved to: Vuetify's list has the focus then. With no hit, Enter opens the list as before. Tab still leaves without a pick (no `auto-select-first`). A key the movement grid has already taken (its list closed) stays the grid's. Props, emits and slots are unchanged.
- **`ProductLineDescription`** (the invoice line): Enter on rows that answer an earlier text waits for the answer to the typed text and takes its first row (§1.5.3). While that answer is on its way, the line grid yields its keys to the field (`productSearchMenuOpen`), as it does while the list is open. Before, an Enter typed before the first answer moved to the next row.

**Tests.** `unit/field-search.test.ts`: the dropped late answer, Enter at once on an answered text, Enter waiting in the pause and released once the list holds the new rows, a text changed or emptied while waiting, a failed search, the wait's limit, and `cancel()`. `e2e/late-search-answer.spec.ts` has two new cases. On an invoice line, the first word's list is on screen and a second word is typed with Enter pressed at once, the second answer held back 1.5 s. On a movement line, Enter takes the first hit, and the same two-word case follows. The count line's case is B-UI's. FR-28's specs are unmodified.

### Slice B-UI (FR-33.4 to .10, .16, and .18 / .19 for the form), 2026-11-25

**What was built.**
- **The entry line (FR-33.4).** `inventory/components/CountEntryLine.vue`: the last row of the lines (D-7), drawn in the table's `body.append` slot, so it is outside the virtual rows, and sticky at the foot of the table, so a long count's entry line stays in view. It holds `ProductSearch` and `ProductDetailsButton` through their current props and emits: `:price-field="null"` (no price in the hit), `stock-warehouse-id` = the count's warehouse, no `allow-create` (D-3). F4 and "Show all N results" open Details with the typed text. Disabled, with a hint, until a warehouse is chosen. `ProductSearch`'s Enter and debounce are not touched (FR-33.12 is its own pull request).
- **Details (FR-33.5).** `ProductPickerDialog` with `multiple`, `stockWarehouseId`, no `priceField`, the typed text and `existingProductIds` = the count's articles. "Add N articles" adds the new ones in the order ticked and says how many were already there.
- **What a pick does (FR-33.6, .7).** `inventory/composables/useCountArticles.ts` with the rules in `count-lines.ts`: System for every picked article from ONE `GET /warehouse/stock-level/by-products` for the count's warehouse (the ids go in turns of 200 past that, for Details at "All"; never one request per article); 0 with *not stocked here* when there is no level; Counted = System (D-5). A stock request that fails adds nothing: no line with a made-up System. The cursor goes to Counted with the figure selected, only while it is where the pick left it (FR-28.27), and a fresh entry line follows. An article already on the count (search or Details) makes no second line: its line is brought into view (the filter cleared if it hid it, the virtual table scrolled to it), highlighted, the cursor in its Counted, and the entry line says "Already on the count: line N" (D-2).
- **The keyboard (FR-33.8).** `inventory/composables/count-grid-keys.ts`: `useGridNavigation` as it is for the plain table (up to 200 lines, every row in the page, the entry line the last row). Over the virtual table, Enter / Tab (Shift: back) in a Counted field go by the line's place among the lines shown, scroll the table to a row it has not drawn (`scrollToIndex`) and wait for it, so the walk does not depend on what is drawn. §5's fallback was not needed. Past the last line the cursor goes to the entry line; Shift+Enter / Shift+Tab there go back to the last line. The arrows are `useGridNavigation`'s (they skip a number field, as on invoices).
- **Lines (FR-33.9).** A line number (the place in the count, held through a filter), a Unit column, × on each line, "+ Add line" (the cursor in the entry line). A line's article does not change (D-6). A completed count shows no entry line, ×, Load or Details. A saved count's lines carry no unit and say nothing of a missing level, so the edit page reads both once, in the background: the warehouse's lean levels (the read "Load products" makes) and, for the articles with no level, the catalogue (`listProducts({ ids })`). Kept outside the form, so they are not an edit. A one-key addition of `productUnit` to `GET /inventory-count/:id`'s lines would let the edit page skip that read (not done here: the routes are slice B-server's).
- **Create and edit alike (FR-33.10, D-1).** "Load products" on a new and an in-progress count; on a count with lines it adds only the missing levels and the lines there keep what was typed.
- **The warehouse lock (FR-33.14, the form's half).** The select is disabled while the count has lines, with a hint. On an edit page it stays locked while the SAVED count has lines (B-server's PUT refuses a change of warehouse on a stored count with lines, even with every line removed on screen): save the emptied count, and the warehouse is free.
- **Complete books what the screen shows (FR-33.16).** With unsaved edits, Complete saves them quietly and then completes, under one spinner; a refused save completes nothing and the refusal stays at the top of the form.
- **Contracts (FR-33.18, .19).** The payload is built by `countPayload`, the same keys as before; the entry line is not a line. New texts under `warehouse.countLine.*` in en, bg, de and mk. The server's refusals (`count_article_repeated`, `count_warehouse_locked`, B-server's backstop) stay at the top of the form in the user's language, through `stockRefusalMessage` and `warehouse.refusals.*`, on Save and on Complete.

**Tests.** `unit/count-lines.test.ts` (a repeated article from the search and from Details; System for N articles from one answer, 0 with no level; Counted = System; D-1; the line number; the payload's keys; three ticked articles = one stock request, 450 = three; a failed stock request adds nothing; the virtual walk past undrawn rows to the entry line). `e2e/count-search.spec.ts` (the hit row with the warehouse's stock and no price; a pick, the cursor in Counted, a fresh entry line; a repeated article shows its line; found goods with System 0 and the hint; Enter down the column to the entry line and back; the lock and the unlock; "Show all" and F4, three ticked = three lines with one stock request, the count's articles marked; the edit page with a pick, D-1 and the payload; Complete with an unsaved edit saves first; Enter walking 60 rows down a 25 000-line count). `inventory-count.spec`: its row count reads the lines that hold an article (`tr[data-testid="count-line"]`), the one change FR-33.18 allows.

**Not in this slice.** The scanner (FR-33.11, on B-server's lookup) and the walk P10 (FR-33.20). Enter taking the first hit (FR-33.12, #951) reaches the count's entry line through `ProductSearch` itself.
