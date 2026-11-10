# FR-28 — Buying from the product list: suppliers per product, one product search, calmer document headers, orders as a tree

| | |
|---|---|
| **Status** | Built 2026-11-10: slices 1 to 6 (§11), each field-tested on production in the demo organization; slice 7 (recorded suppliers, receipts that name a supplier, the docs) follows in its own PR. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | FR-22 (the Reserved and On-order figures, the row menu, the reservation screens, the click-budget walks P1 to P7), FR-05 (grid state in the URL, the column picker), FR-27 (the access catalogue, `products.costs` as a field group), FR-24 (one app, one SPA), FR-21 / FR-03 (the cash-register terminal), FR-01 (the six document types in one form), the Orders model in `CLAUDE.md` (ORDO, ORDI, RES) |
| **Touches** | `inventory-ui` (Products), `invoicing-ui` (document form, order forms, reservations), `ui-shared` (the product search, the list engine, the tree), `warehouse-api` and `invoicing-api` (list filters, supplier links, orders from products), `db` (`ProductSupplier`), `migrations` |
| **Tracking** | [gjovanov/lgr#622](https://github.com/gjovanov/lgr/issues/622) |
| **Code anchors** | origin/master `e230d855` (2026-11-10). Anchors, not gospel. |

## 0. The request (owner, 2026-11-10)

Nine asks, in the owner's order. Routes stand in for the URLs of the message. Document ids and organization names are left out, because the repository is public.

**Products** (`/inventory/products`)

- **R1** Search products by minimum quantity and by supplier. Keep track of which products were procured through which suppliers, and let the product search use it.
- **R2** Select products, filtered or not, and create a supplier order (external) or a customer order (internal) from the selection, on that page.

**One product search**

- **R3** The product search must be the same on seven screens: `/inventory/movements/new`, `/invoicing/invoices/new`, `/invoicing/bills/new`, `/invoicing/proforma/new`, `/invoicing/cash-sales/new`, `/invoicing/internal-orders/new` and `/invoicing/orders/new`. Each offers both the autocomplete ("Type to search products...") and a detailed search in a dialog. The dialog has the same filters, paginated table, columns and column selection as `/inventory/products`, and looks and works the same.

**Document headers** (new and edit)

- **R4** Bills: scrap the title text (the organization's name and "New Purchase Invoice"). Put the Supplier select on the same row as the document number, one row of three equal-width columns. Put Print Note above Reason and Tags, at the same width.
- **R5** Sales invoices: the same, with the Client select. Move the companion-documents note under the Subtotal/Total panel.
- **R6** Proforma invoices: as invoices.

**Orders**

- **R7** Warehouse and client reservations on a supplier order are hard to work with. Show them as a nested, collapsible table in the manner of Vuetify's group-summary slot: product line, then warehouse reservation, then client reservation, with a summary on each parent for its children and a **+** on both levels to add a warehouse or a client reservation. Perhaps the same grouping to more than two levels.
- **R8** The Suppliers and Reservations panels of a supplier order become collapsible.
- **R9** The same, consistent approach for customer orders and for a reservation's own page.

**In short.** One area, buying and ordering, in five changes:

1. A product knows which suppliers it came from, and the Products list filters by supplier and by quantity (R1).
2. Products picked in that list become a supplier order or a customer order in one step (R2).
3. Every place that picks a product offers the same autocomplete and the same dialog, and the dialog is the Products list (R3).
4. The three document headers spend their first rows on facts, not on a title (R4 to R6).
5. A supplier order, a customer order and a reservation show what is allocated and reserved as a collapsible tree with totals on each parent (R7 to R9).

**Where to look.** The five parts are independent. Slices 1, 5 and 6 touch no product code, so a second developer can take them beside slices 2 to 4 (§5).

| Ask | Part | Current state | Design | Requirements | Slice |
|---|---|---|---|---|---|
| R1 | Suppliers per product, supplier and quantity filters | §1.1 | §2.2, §2.3 | §3.1 | 2, 7 |
| R2 | An order from a selection | §1.1 | §2.3 | §3.2 | 4 |
| R3 | One product search | §1.2 | §2.4 | §3.3 | 3 |
| R4 to R6 | Document headers | §1.3 | §2.5 | §3.4 | 1 |
| R7 to R9 | Orders as a tree | §1.4 | §2.6 | §3.5 | 1, 5, 6 |

Decisions the owner can change are in §9. The three that most change the work: D-1 (what "min quantity" means), D-3 (the third column of the header row) and D-7 (Vuetify's grouped table or our own tree).

## 1. What is wrong today

### 1.1 The Products list cannot answer the two buying questions, or start an order

- **Which suppliers does this article come from?** Nothing records it. `Product` has `minStockLevel` and `maxStockLevel` and no supplier field. The fact exists only inside documents: an incoming invoice has `contactId` and product lines, a supplier order has `supplierGroups[].supplierId`, and `getInternalOrderSuggestions` guesses a `supplierHint` from the latest supplier order that carried the article. No screen shows it, and none can search by it.
- **Which articles are short?** The list has no minimum or low-stock filter. `ProductDao.findLowStock` has no caller. The Stock-levels page has a `lowStockOnly` switch that `stock-level.controller.ts` never reads. The one working definition is the Reports `stock-levels` report (`belowMin`: `minStockLevel > 0` and `quantity < minStockLevel`, with an unset minimum meaning "no threshold", not zero).
- **A warehouse filter hides what is out of stock.** With a warehouse chosen, `product.controller.ts:26-30` also restricts the list to articles with `quantity > 0` there, so "what have we run out of in this warehouse" cannot be listed.
- **There is nothing to select.** `ListScaffold` binds its table without `show-select` or a selection model (`ListScaffold.vue:68-80`); `show-select` exists only in `PaymentOrdersView` and `DocImportDialog`. The one hand-off from a product to a document is the row menu's „Продай", which carries a single article in `?productId=` (`useDocumentForm.ts:1834`). A supplier order for twenty short articles is twenty passes through the order form's own search.
- **There is no reorder machinery to build on.** `CLAUDE.md` lists a `purchase-api` package with "reorder rules" and "blanket orders". No such package, model or route exists. The only reorder fields are `Product.minStockLevel` and `maxStockLevel`. (`POST /warehouse/product` accepts `reorderLevel` and `reorderQuantity`, which the schema silently drops.)

### 1.2 Seven screens, two search widgets, and a dialog that is not the Products list

The Products list (`inventory-ui/src/views/ProductsView.vue`) is the one place a product is searched with everything: `ListScaffold` around a server table, six filters kept in the URL (search, warehouse, category, type, tags, status), columns the user can hide and reorder (15 shown by default, more behind the cog; kept in `lgr:grid-cols:<userId>:<orgId>:inventory.products`), page sizes 10 to 100 and All, a stock cell per warehouse, and the Reserved and On-order figures of FR-22.45. Everything else that picks a product is a smaller, different thing.

| Screen | Autocomplete | Dialog | What a pick does |
|---|---|---|---|
| `/inventory/movements/new` | `ProductSearch` (`v-autocomplete`, 2 characters, 10 hits, row `SKU — unit`) | yes, a ⌕ button beside it | cost is `purchasePrice`; stock chip of the warehouse; quantity focused |
| `/invoicing/invoices/new` (credit and debit notes too) | `ProductLineDescription` (a text field with an overlay, free text allowed, row `SKU — price`) | yes | `sellingPrice`, then `GET /pricing/resolve` overrides it; unit and tax from the product |
| `/invoicing/bills/new` | the same widget, `priceField=purchasePrice` | yes | no price resolution; may create a product on the spot |
| `/invoicing/proforma/new` | as invoices | yes | also resets the discount |
| `/invoicing/cash-sales/new` | **none**: this is the till, a card grid with a search box and Category, Type and Tags filters (`RegisterTerminal.vue`, `GET /trade/pos/catalog`) | **none** | a card adds one unit at the catalog's price; the same article again adds one more |
| `/invoicing/internal-orders/new` | `ProductLineDescription`, `sellingPrice` | yes | `expectedUnitPrice` from `sellingPrice`; quantity 0 becomes 1; next line added |
| `/invoicing/orders/new` | `ProductLineDescription`, `purchasePrice` | yes | `expectedUnitPrice` from `purchasePrice`; no next line, no focus |

`/invoicing/cash-sales/new` is the till (`PosTerminalView.vue`, heading "CS Terminal"). The back-office cash sale at `/cash-sales/draft` and `/cash-sales/:id/edit` is `CashSaleFormView` on the same `RegisterTerminal`, without the Type and Tags filters.

What differs, and each difference is a place where the same article is found one way here and another way there:

1. **Two inline widgets.** `ProductSearch` shows `SKU — unit`, needs a pick, and has no way into the dialog of its own. `ProductLineDescription` shows `SKU — price`, accepts free text, shows a chip after a pick, and is the line's description cell. No result row shows stock, on any screen.
2. **The dialog is not the list.** `ProductPickerDialog` filters by search, category and type only, and shows 7 columns (no stock, no Reserved or On order, no tags, no column picker). It lists deactivated articles, because it sends no `isActive`. It sorts by `createdAt` descending where the inline search sorts by name. Its page sizes stop at 100, with no All. Its category list comes from `GET /warehouse/product?size=0`: **the whole catalogue is downloaded on first open to read the category names out of it.**
3. **"Available" means three things.** The movement form's chip shows `availableQuantity`, the list's stock cells and the till's cards show `quantity`.
4. **What follows a pick differs**: the next line is added on some forms and not on others, the quantity field is focused on some, the quantity starts at 1, 0 or the whole stock on hand. Only the till merges a second pick of the same article into the first line.
5. **Search is not one function.** The product endpoints go through `buildProductSearchFilter` (name, SKU, barcode, description and category, with Latin and Cyrillic look-alikes read as one letter). `GET /warehouse/stock-level?search=` uses a plain regex on name, SKU and barcode.
6. **"Active" is not one rule.** The till catalog filters `isActive: true`, the list takes `$ne: false`, the dialog asks for nothing.
7. **Four more pickers** use the same endpoint with their own widgets: the price-list form (`ProductSearch` and the dialog), the document-import dialog (the dialog), the reservation-create dialog (a third autocomplete, 10 hits) and the reports parameter field (a fourth, 20 hits, `SKU — name`).
8. **No spec exercises `ProductPickerDialog`.** Nothing in `packages/e2e/tests` opens it, so nothing would notice if it broke.

### 1.3 The document header spends its first rows on a title

On a bill, a sales invoice or a proforma (`DocumentForm.vue`, one component for all of them, new and edit), top to bottom:

1. A "Document Type" toggle (new) or chip (edit), above the shell, on invoices and bills only.
2. The shell's header bar: back, an `<h1>` with the title ("New Purchase Invoice", "Edit Invoice") and, on edit, the number as its subtitle. Then the sticky action bar, with the status pipeline on edit.
3. **The banner** (`.doc-banner`, `DocumentForm.vue:14-134`): one flex row (`d-flex … flex-wrap`, no grid) of three children of unequal width.
   - the organization's name and the title again (a `div`, not a heading), with an avatar;
   - `.doc-banner-party`, the Supplier or Client select with its search, create-contact and ledger buttons (`flex: 1 1 260px`, at most 460 px);
   - `.doc-banner-meta` (`flex: 1 1 380px`, 280 to 460 px), right-aligned: the number as plain text (`.text-h6`), the status chip on edit, the **Print note** (a four-row textarea, every type) and the **Companion documents note** (two rows, outgoing documents only).
   The two textareas stacked in the right-hand child set the height of the whole row.
4. On edit, an action row: the "sent by email" chip, Email, Print (split button), the stock receipt.
5. `DocumentUpperSection`: **three equal columns** (`md=4`): the party's block, the organization's own block (its name again, in `text-h6`, then tax and VAT numbers and the address), and the meta fields (supplier invoice number, related invoice, issue and due dates, payment method, currency, rate, place of deal).
6. The lines. Then one row: the notes textarea, Terms and Tags on the left (`md=6`), the totals card on the right (`md=6`). That textarea is labelled **Reason** on bills and on credit and debit notes (`invoicing.reason`) and **Notes** on invoices and proformas (`invoicing.notes`).

So a bill shows the organization's name three times (the top bar's organization menu, the banner, its own block) and its title twice (the `<h1>`, the banner). The same banner is copied into five files: `DocumentForm`, `CashSaleTerminal`, `OrderFormView`, `InternalOrderFormView` and `ReservationDetailView`.

The banner sits outside the form's `<v-form>`, so the party select's `required` rule takes no part in `formRef.validate()` (`useDocumentForm.ts:1361-1365`). A layout change must leave what validates exactly as it is.

### 1.4 The order screens spread one fact over three places

**Supplier order (`OrderFormView.vue`).** One card per supplier group, not collapsible. In a line's row, the Allocations cell holds one chip per warehouse (`Main: 70 · lock 40`), a `+N` chip for what is not allocated, a chevron, and a "Client reservations" button with a count. Each of the two buttons opens a sheet under the line:

- the **allocation editor**: per warehouse a select, a quantity, a Received chip, a Free chip, a remove button, and "Add Warehouse";
- the **reservations grid**: a nested table (Customer, Reservation, Customer order, Qty, Invoiced, Dispatched, Status, actions) with a group row per allocation that carries the only **Reserve for client** button.

A warehouse allocation therefore appears three times per line (chip, editor row, group row). A second card, **Reservations**, lists all of the order's reservations again, flat. Nothing has a **+** on the line or on a reservation. There is no figure for a group, no allocated total and no invoiced figure per line or allocation. The Totals card's *Reserved* ignores staged changes while the allocation's *Free* counts them (`totalReserved` against `allocReserved`).

Reservations are **staged**: the reserve dialog calls no endpoint, Save sends `reservationChanges { create, update, cancel }` with the order, and a new reservation may hang on an allocation that does not exist yet. The dialog does not ask which customer-order line the reservation is for.

**Customer order (`InternalOrderFormView.vue`).** A lines table whose Coverage cell shows `Reserved Qty: 4/10` and a Delivered chip; the line's reservations in an always-open sub-row of inline text (number, source chip with the ORDO number or "Stock", warehouse, quantity, invoiced and dispatched, status, edit, release, repeat); a **Reservations** toolbox card (Reserve from stock, Cover shortages, Generate supplier order) over a flat table of all reservations again; two dialogs behind those buttons. Reservation changes here are **immediate**: each is a call, with its own dialog. `LineFigures.invoiced` is computed and never shown.

**Reservation page (`ReservationDetailView.vue`).** Five cards (who and what, the source, the customer order it serves, invoices, history and links). Its links back go to the order **documents** only; nothing opens the line or the allocation.

The tools already in the repo for a tree: Vuetify is 3.13.7, which has nested `group-by`, a `group-header` slot and, since 3.9.4, a `group-summary` slot. Nothing in the repo uses any of them yet. `show-expand` is used in four views.

## 2. Design

### 2.1 Terms

- **Supplier fact.** For one article and one supplier, what the documents say: the date and unit price of the last purchase, the quantity bought, the number of documents, and the document last used. It is read from the documents (§2.2). Nothing stores it.
- **Recorded supplier.** What a person writes about an article and a supplier: preferred, the supplier's own code, the lead time. It is stored (§2.2, SHOULD).
- **Selection.** The articles ticked on the Products list, kept across pages and filters (§2.3).
- **Product search.** One autocomplete and one dialog, the same everywhere (§2.4). The dialog is the Products list in a window.
- **Tree.** The allocations and reservations of an order as nested, collapsible rows with totals on each parent (§2.6).

### 2.2 Supplier facts: read from the documents

**What counts as "procured through supplier S".**

1. A **bill**: an `Invoice` with `direction: 'incoming'` and `type: 'invoice'`, `contactId = S`, in a received status (`received`, `partially_paid`, `paid`, `overdue`: `services/biz/reservation.service.ts:39`), for each line with a `productId`. Date: `issueDate`. Price: the line's `unitPrice`, in the bill's `currency`.
2. A **receipt no bill covers**: a `StockMovement` with `type: 'receipt'`, `status: 'completed'`, `contactId = S`, not `recordOnly`, not reversed, with no `invoiceId` and not listed in any bill's `stockSource.movementIds`. A receipt that a bill covers is that bill's purchase, not a second one. Date: the movement's `date`. Price: the line's `unitCost`.

Not evidence: drafts, voided and cancelled bills, incoming credit and debit notes (a return is not procurement), and supplier orders (intent: they keep their own On-order figure and the `supplierHint`).

**Why read, not store.** Purchases reach the database through at least eight writers: the three places a bill becomes `received` (`POST /invoices/:id/receive`, the incoming branch of `/send`, `convertDraftInvoice` and its five callers), `confirmMovement` for receipts, the receipt-to-bill link and its undo (raw `updateOne`), `PUT` of an issued bill (no status guard, no re-post), and void (a compensating dispatch; the receipt stays `completed`). `invoice.posted` fires only from `/send`. A stored figure would need a feeder at each writer and a reconciler behind them, and documents are editable in every status, so a stored last price would go on showing a corrected bill's old price with nothing marking it: the trap `CLAUDE.md` already records for the journal entry of an edited invoice. What a read costs is bounded by the budget of FR-28.2, which a test enforces, and an aggregation behind the right indexes is cheap at the size the list already reads. The service's interface (FR-28.1) lets a stored view replace its body later if an organization outgrows that budget; a test that runs both over one fixture then proves them equal.

**Seen by whom.** Supplier facts are incoming-document data: who we buy from, when, at what price. FR-26 keeps counter staff away from incoming documents, and FR-27.6 makes that a filter in the data layer. So the facts are served only to a caller who may see bills (`bills.view`), and the price only to one who may see costs (FR-27's `products.costs` field group once it ships; until then, whoever sees `purchasePrice` today). For anyone else the server omits the keys, and a `supplierId` filter is refused with 403.

**Recorded information (SHOULD).** `ProductSupplier { orgId, productId, supplierId, preferred, supplierSku?, leadTimeDays?, note? }`, unique on `{orgId, productId, supplierId}`, replication class **R** (`replicate(schema, { class: 'R' })`; `unit/replication-meta.test.ts` fails the build without it). Written by a person on the Suppliers tab, never by a document. `preferred` wins the default supplier on an order; `supplierSku` is searchable. It sits beside `SupplierProductAlias`, which stays what it is: a dictionary of the wording a supplier's bills use for an article, written by the import.

**The default supplier of an article** (used by the order dialog, and by `getInternalOrderSuggestions` in place of the `supplierHint` it returns, which the customer-order form's Generate dialog prefills from): the recorded preferred supplier, else the supplier of the most recent purchase, else the supplier of the newest supplier order with a line for the article (today's `supplierHint`), else none.

**Receipts that name no supplier.** The receipt form and bill-born receipts write `contactId`. The daily PlusMinus receipt import does not: `partner` is free text and goes into `notes` only (`map-plusminus-stokrazp.ts`, `scripts/receive-stock-api.ts`), as do `receive-stock.ts` and `receive-new-products.ts`. For an organization whose purchases arrive that way, the facts are only as complete as the bills. FR-28.12 lets the import resolve the partner to an existing supplier by exact normalized name, create nothing, and report the names it could not resolve.

### 2.3 The Products list: filters, selection, an order in one step

```
Products                                                                     [Create] [Export]
[ Search...        ] [ Warehouse v ] [ Category v ] [ Type v ] [ Tags v ] [ Status: Active v ]
[ Supplier v (any) ] [ Stock from __ to __ ] ( Below minimum ) ( Out of stock ) [ ] No supplier
-------------------------------------------------------------------------------------------------
 12 selected (3 are outside this filter)   [ Create supplier order ] [ Create customer order ]  Clear
-------------------------------------------------------------------------------------------------
 [x] | SKU      | Name            | Stock    | Reserved | On order | Min | Suppliers   | ...  | :
 [x] | PRD-0042 | Hex bolt M8x40  | Main: 4  |    0     |    0     | 20  | Alfa, +1    |      | :
 [ ] | PRD-0043 | Hex bolt M8x50  | Main: 31 |    2     |   40     | 20  | Alfa        |      | :
```

**Filters.** Six exist (search, warehouse, category, type, tags, status). Three groups are added, all server-side, all kept in the URL (FR-05's `useListQueryState`), all combined with AND:

| Filter | Param | Meaning |
|---|---|---|
| Supplier (several) | `supplierId=a,b` | an article with a supplier fact for any of them (a recorded link counts too) |
| No supplier | `noSupplier=true` | an article with neither |
| Stock from / to | `stockMin`, `stockMax` | inclusive, on the list's own stock figure |
| Below minimum | `belowMin=true` | `trackInventory`, `minStockLevel > 0` and the figure `< minStockLevel` |
| Out of stock | `stockMax=0` | a chip that sets the range |
| Count open orders | `basis=projected` | the figure becomes on hand − reserved + on order (SHOULD) |

The **stock figure** is the one the Stock column and its sort use: the sum of `quantity` over the warehouses, or the chosen warehouse's `quantity`, with an article that has no stock row counting as **0** (`product-stock-sort.ts` already computes it; the filters reuse that function). Two rules are inherited, not invented. `belowMin` is the Reports `stock-levels` rule, with one difference: that report drops articles with no stock row, and a never-stocked article with a minimum is exactly what a reorder list is for. An unset minimum means "no threshold", never zero. A service (`trackInventory: false`) never matches a quantity filter.

**The warehouse filter.** Today it also hides every article with no stock in that warehouse (`product.controller.ts:26-30`). That stays the default. When any quantity filter is set, the quantity filter decides instead, so "below minimum in warehouse X" lists the articles X has run out of.

**Columns** (the cog, per user, FR-05): *Suppliers* (on by default: two names and "+N", a tooltip with every supplier and its last purchase), *Last purchase*, *Last cost* (a cost figure: §2.2), *Minimum* and *To order* (off). The row of an article with no supplier fact shows a dash, never a blank that reads as "loading". Suppliers load like the stock cells do, in one call per page (`GET /warehouse/product-supplier/by-products?productIds=`), so the list's own response does not change.

**Selection.** A checkbox column. The header checkbox ticks the page; when the whole page is ticked and the filter matches more, a banner offers "Select all N that match the filter". The selection survives paging, sorting, column changes and filter changes. A chip says how many ticked articles the current filter hides, and Clear empties it. Actions work on at most **500** articles; above that they say so and ask for a narrower filter. `ListScaffold` gains `selectable`, `v-model:selected` (ids) and a `bulk-bar` slot, so another list can use it later.

**Create supplier order.** The dialog lists the selected articles, one row each, from one server call (`POST /invoicing/orders/from-products/preview`), which also resolves "all that match the filter":

```
Create supplier order                                                                     [x]
12 articles. One draft supplier order, one group per supplier.

 Article          Unit  On hand  Reserved  On order  Min  Quantity   Supplier      Price   Warehouse
 Hex bolt M8x40   pcs      4        0         0      20   [ 16 ]    [ Alfa     v] [ 0.12 ] [ Main v]
 Washer M8        pcs     12        2         0      30   [ 20 ]    [ Beta     v] [ 0.02 ] [ Main v]
 Anchor 10x80     pcs      0        0         0       5   [  5 ]    [ choose.. v] [      ] [ Main v]  <- needs a supplier

 Set the supplier of all rows: [ choose.. v ]       [ ] Add to the open draft DRF-ORDO-2026-00007
                                                    [ Cancel ]  [ Create supplier order (11 of 12 ready) ]
```

- *Quantity*: `max(1, target − position)`, with `position` = on hand − reserved + on order, scoped as the list is, and `target` = `maxStockLevel` when it is above zero, else `minStockLevel`. An article with no minimum or maximum, and a service, starts at 1. Editable.
- *Supplier*: a select of the article's suppliers in default order (§2.2), plus any supplier contact. A row with no supplier blocks Create until it has one; the order model requires a supplier per group.
- *Price*: the supplier's last unit price when the caller may see costs, else the article's `purchasePrice`, else empty (`expectedUnitPrice` is optional).
- *Warehouse*: the list's warehouse filter, else the organization's default warehouse. Each line gets one allocation for its whole quantity, as `generateExternalOrder` does.
- The result is **one** draft ORDO with one supplier group per supplier. The user lands on it (FR-22.35: no number lives only in a snackbar). When a draft ORDO already has a group for a supplier in the dialog, a checkbox offers to add to it (FR-22.42).

**Create customer order.** The same shape: a client (required), a requested delivery date (required), a priority and a preferred warehouse (optional), and a quantity per row (default 1). The result is one draft ORDI, and the user lands on it, where Reserve from stock and Cover shortages work as they do today.

Both endpoints create drafts only: nothing is sent, confirmed or reserved.

### 2.4 One product search

Two parts, the same on every screen: an **autocomplete** in the field, and **Details**, a dialog that is the Products list in a window.

```
 Product      [ Type to search products...                              ] [ Details ]
                 Hex bolt M8x40
                 PRD-0042 · pcs · Main: 4 (2 reserved) · 0.12
                 Hex bolt M8x50
                 PRD-0043 · pcs · Main: 31 · 0.14
                 Show all 37 results...                 <- opens Details with the text
```

```
 Find a product                                                                           [x]
 [ Search...  ] [ Warehouse v ] [ Category v ] [ Type v ] [ Tags v ] [ Supplier v ] [ Status v ]
 [ Stock from __ to __ ] ( Below minimum ) ( Out of stock )                       cog: columns
 [x] | SKU      | Name            | Category | Stock    | Reserved | On order | Unit | Price
 [x] | PRD-0042 | Hex bolt M8x40  | Bolts    | Main: 4  |    0     |    0     | pcs  | 0.12
 Rows per page 25 v   1-25 of 213   < >                      [ Cancel ]  [ Add 3 articles ]
```

**The autocomplete.** One result list for both widgets that exist today (`ProductSearch`, a `v-autocomplete`, and `ProductLineDescription`, a text field with an overlay). They stay two **fields**, because they do two jobs: a movement line must name an article, while a document line is a description that may stay free text, with a chip once an article is picked. They stop being two **searches**. A result row is the same everywhere: the name, then `SKU · unit · stock · price`.

- *Stock* is the figure of the warehouse the screen works in (a movement's From or To, a document's warehouse), else the sum; it is on hand, with the reserved quantity in brackets when there is one. Today the search shows no stock at all, and the three places that do show it disagree about "available".
- *Price* is the one the line will start with: the selling price on sales documents and customer orders, the purchase price on bills, receipts and supplier orders (a cost figure: §2.2).
- Two characters, 300 ms and ten hits stay. The barcode path stays: a scanned code that matches one article is added with no list (`/trade/pos/catalog/lookup`).
- Free text stays possible on document lines.
- `Details` sits at the end of the field on every screen, with a tooltip and the shortcut **F4**. The last hit offers "Show all N results".

**The dialog is the Products list.** One list engine in `ui-shared` replaces what `ProductsView` and `ProductPickerDialog` each build for themselves: `useProductList` (filters, request, paging, the stock side call), `ProductFilterBar` and `useProductColumns`. `ProductsView` keeps what is its own (the URL, the row menu, selection and the bulk bar). The dialog takes everything else, so the two cannot drift:

- the same filters, supplier and quantity ones included, with Status defaulting to Active (the dialog lists deactivated articles today, because it sends no `isActive`);
- the same columns, **and the same per-user choice**: the dialog opens the list's `inventory.products` column preference, so the user sets it once (`lgr:grid-cols:<userId>:<orgId>:inventory.products`);
- the same page sizes, All included; categories from `GET /warehouse/product-category`, so the whole-catalogue download on first open goes away;
- it opens sorted by name, as the inline search does; a column header sorts as it does on the list.

It takes three props from the screen: `multiple` (a tick column and "Add N articles", on every screen that has lines), `stockWarehouseId` (the warehouse whose stock the cells show; it **scopes the figures and never restricts the rows**, because a receipt adds articles with no stock) and `priceField`. Enter or a double click on a row picks it. Escape closes.

**What a pick does stays with the screen.** Price resolution on an invoice, `purchasePrice` on a movement, `expectedUnitPrice` on an order, the product-update switch on a bill: none of it moves. The search changes how an article is **found**. One thing is made the same: after a pick the line's quantity field is focused and a blank line is added when the last one was filled (the movement and customer-order forms do both today, the invoice form adds the line but does not focus the quantity, and the supplier-order form does neither).

**The till.** `/invoicing/cash-sales/new` is `PosTerminalView` on `RegisterTerminal`, a card grid whose search box filters the grid live, with Category, Type and Tags beside it. The grid is the autocomplete result, so the till keeps it, scanning included, and gains **Details**. Its dialog reads the till catalog (`GET /trade/pos/catalog`: active articles only, the session warehouse's `stockAvailable`, behind `cashRegisterRefusal`) through a `source` adapter, shows the columns that catalog returns, and a pick adds one unit as a card click does. The back-office cash sale (`/cash-sales/draft`, `/cash-sales/:id/edit`) is the same terminal and gets the same button.

**Other pickers** that already call the same endpoint adopt the same search in the same slice where it is free (the price-list form, the document-import dialog) and replace their own autocomplete where it is not (the reservation-create dialog, the reports parameter field: SHOULD).

### 2.5 Document headers

How the owner's ask is read, drawn for a bill (new). Today:

```
 Document Type  [ Purchase invoice | Credit note | Debit note ]
 <- New Purchase Invoice
 [ Save ] [ Issue ] ...
 +---------------------------------------------------------------------------------------+
 | (o) <Organization>      [ Supplier v ] [?][+][L]                 DRF-BILL-2026-00025 |
 |     New Purchase Invoice                                         [Draft]             |
 |                                                                  [ Print note ...  ] |
 |                                                                  [ (four rows)     ] |
 +---------------------------------------------------------------------------------------+
 | Supplier block            | Organization block          | Supplier invoice no., dates, ... |
 | Lines ...
 | Reason  [ ... ]           | Totals
 | Tags    [ ... ]           |
```

After:

```
 Document Type  [ Purchase invoice | Credit note | Debit note ]            (unchanged)
 <- New Purchase Invoice                                                    (the h1 stays)
 [ Save ] [ Issue ] ...
 +-----------------------------+-----------------------------+-----------------------------+
 | Supplier [ Alfa Ltd      v ]| DRF-BILL-2026-00025         | Issue date [ 2026-11-10   ] |
 |          [?][+][L]          | [Draft]                     |                             |
 +-----------------------------+-----------------------------+-----------------------------+
 | Supplier block              | Organization block          | Supplier invoice no.,       |
 |                             |                             | due date, payment, ...      |
 | Lines ...
 +--------------------------------------------+   +--------------------------------------+
 | Print note  [ ...                        ] |   | Subtotal ... Total                   |
 | Reason      [ ...                        ] |   | Companion documents note [ ... ]     |
 | Tags        [ ...                        ] |   +--------------------------------------+
 +--------------------------------------------+
```

- `[?][+][L]` are the select's search, new-contact and ledger buttons. They move with it.
- The banner's organization name and title go. The `<h1>` in the form header bar is the title, and about twenty specs find the form by it, so it stays. The organization's name is in the top bar's organization menu and in its own block below.
- The party select and the number are **one row of three equal columns** (`md=4`, the same grid as the row under it, so the columns line up). The third column is the **issue date**, moved up from the meta column; the due or valid-until date takes the meta column's whole first row. The request names two of the three columns; D-3 asks about the third.
- **Print note** moves to the top of the notes column, above Reason (labelled Notes on invoices and proformas), the width of that column. **Companion documents note** moves under the Subtotal/Total card, on the forms that have it (outgoing documents with companions).
- Only places move. Fields, limits (300 characters for the print note), saved properties and the PDF are as they are.
- One `DocumentBanner` replaces the five copies of the banner. The bill, invoice and proforma forms and the credit and debit notes that share their component are the ones the owner named. The cash-sale terminal, the two order forms and the reservation page drop the same org-and-title block (D-14).

### 2.6 Orders as a tree

One table per supplier group, three kinds of row, **one set of columns**. Open, with the add state shown under the second warehouse:

```
 [v] Supplier [ Alfa Ltd v ]  Ref [____]    2 lines · 300 ordered · 85 reserved            [Export v] [x]
 Article / Warehouse / Client        Qty    Unit  Price  Reserved  Free  Received  Invoiced   Status
 [v] Hex bolt M8x40               [ 100 ]   pcs  [0.12]     60       0       0        10                    [+ Warehouse] [x]
   [v] Main                       [  70 ]                   40      30       0        10                    [+ Client] [x]
         Client A  RES-0012  ORDI-0003  [ 25 ]                                         10     active         [switch] [x]
         Client B  RES-0013             [ 15 ]                                          0     active         [switch] [x]
   [v] Second                     [  30 ]                   20      10       0         0                    [+ Client] [x]
         Client C  RES-0014             [ 20 ]                                          0     active         [switch] [x]
         [ Client ........ v ] [ 10 ]  Enter adds, Escape cancels
 [>] Washer M8                    [ 200 ]   pcs  [0.02]     25      50       0         0   50 unallocated   [+ Warehouse] [x]
     Totals of this supplier         300                    85                0        10
 [+ Line]
```

| Column | Line | Warehouse (allocation) | Client reservation |
|---|---|---|---|
| Item | the article, through the product search of §2.4 | the warehouse | the client, then the reservation number and its customer order, as links |
| Qty | ordered | allocated to this warehouse | reserved for this client |
| Unit, Price | editable | | |
| Reserved | the sum below | the sum below | |
| Free | not yet allocated (ordered − allocated) | not yet reserved (allocated − reserved) | |
| Received | on the line | into this warehouse | |
| Invoiced, Dispatched | the sums below | the sums below | its own |
| Status | flags: over-allocated, unsaved changes, unallocated | flags | the status chip, or "new", "cancelled on save" |
| Actions | **+ Warehouse**, remove | **+ Client**, remove | change client, cancel or undo, repeat |

**Totals on the parent** is the idea behind Vuetify's group-summary: a parent shows what its children add up to, in the same columns, so closing a level loses nothing. A collapsed line still says how much is ordered, reserved and free, and a flag says when something below needs attention. A totals row follows each supplier's rows.

**One set of figures.** Every figure comes from one set of functions over the form's state: the lines and allocations as edited, the server's reservations, and the staged changes. A staged row counts at once, a reservation cancelled on save counts as what is already invoiced or dispatched (as `allocReserved` does), and the Totals card reads the same functions. That ends today's disagreement between *Reserved* in the Totals card and *Free* on an allocation.

**The + actions are rows, not dialogs.**
- **+ Warehouse** inserts a row under the line: a warehouse select and a quantity, defaulting to what is not yet allocated.
- **+ Client** inserts a row under the warehouse: a client select and a quantity, defaulting to what is free there.
- Enter adds it as a staged row marked "new" and the figures move. Escape drops it. The same checks as today apply and show on the row: quantity above zero, allocations not above the line, a reservation not above what is free.
- The reserve dialog stays for "change client", and for the Reservations page. Nothing is sent until Save: this screen stages its reservations and keeps doing so (`reservationChanges`), which is also why a client can be reserved on a warehouse row that is not saved yet.

**Nothing the screen does today is lost**: the quantity of a reservation edited in its row (down to what is consumed), change client, cancel with undo ("cancelled on save"), reserve again, the over-allocation warning, the "new" and "unsaved changes" markers, links to the reservation and to its customer order, received per allocation, invoiced and dispatched.

**Open and closed.** A line that holds live reservations opens by itself, as it does today (`OrderFormView.vue:1219`). A row with a flag (over-allocated, unsaved, unallocated, late) opens and puts the flag on its parent when closed, so nothing hides. Expand all and Collapse all sit on each supplier's header. The state survives the reload after Save, as `wasOpen` does today. An empty parent shows one muted row with its **+**: "No warehouse yet", "No client reservations".

**Panels.** The supplier group cards, the flat Reservations card and the Invoices card become collapsible, each with a one-line summary when closed ("2 lines · 300 ordered · 85 reserved", "9 reservations · 7 clients", "2 invoices"). Their state is kept per user, screen and organization. The Reservations card repeats what the tree now shows, so it starts closed once the tree exists (D-6).

**The customer order** is a tree of two levels: a line, then its reservations. The line row carries the quantity needed, unit and price, *Reserved*, *Free* (what is short), *Invoiced* (computed today, never shown) and *Delivered*, the coverage chip, and a **+ Reserve** menu: from stock, from a supplier order, generate a supplier order. Each entry opens today's dialog already filtered to the line. A reservation row is what the sub-row shows now, in the same columns: number, source chip (the ORDO or Stock) with its warehouse, quantity, invoiced and dispatched, status, edit, release, repeat. This screen acts at once, and keeps doing so. The toolbox card (Reserve from stock, Cover shortages, Generate supplier order) stays, as the order-wide buttons, in a collapsible panel; the flat table below it starts closed.

**The reservation page** gets the same panels and a **tree of its own supply**: the supplier order's line, the warehouse, and every reservation on it with this one highlighted; for a reservation on stock, the warehouse and the reservations on its stock. It answers "who reserved how much" on the page (FR-22.40) and replaces five fixed cards with collapsible ones. Its links to the supplier order and the customer order open the **line** (`?line=<id>` and `&allocation=<id>`: the form scrolls to it and highlights it), where today they open the document.

**What builds it.** The node model (kind, depth, label, quantity, the figures above, status, flags, actions, children) and the functions that fill it are plain code, with unit tests, shared by the three screens. What draws it is one component. Vuetify's `v-data-table` `group-by` is the obvious candidate, and the owner points at it, so a spike decides (S-1). What the installed 3.13.7 does, read from its source:

- `groupBy` takes several keys and nests. A group exists only if at least one row carries its value, so a line with no warehouse and a warehouse with no client need a placeholder row to exist at all.
- All groups start **closed**, and open or closed is internal: it is not a prop or a model, only `isGroupOpen` and `toggleGroup` in the slots. Opening what should be open by default, Expand all, and keeping state across a reload each need a workaround.
- `group-header` replaces the whole row, so a header can render any cell under any column, and indents itself. `group-summary` draws one extra row after an open group's children, and only when the slot is given.
- Groups appear in first-seen order unless a key sets `order`, so leaving it unset keeps the lines' order. `pageBy` counts group rows as rows, so the table turns pagination off.
- The three levels edit different things (a product search, a warehouse select, a client select), and the form already builds its nesting by hand in `v-table`.

S-1 builds the supplier order's tree twice from one fixture, with `group-by` and with a `v-table` over the node model, and passes or fails each on: (1) three levels with the parent's figures in the same columns; (2) open by default, Expand all, and state kept across the reload; (3) empty parents; (4) the lines' order; (5) inline editors and staged markers; (6) keyboard and `aria-expanded`, with the grid navigation `useGridNavigation` already gives a form; (7) 300 lines, three warehouses each and three clients each, under 100 ms to toggle one. The tree ships on the one that passes all seven. The expected outcome is the `v-table`; the spike exists to prove it in a day, not to delay slice 5.

## 3. Requirements

### 3.1 Supplier facts and the list's new filters (slice 2)

**FR-28.1 — The service (MUST).**
- `services/biz/product-suppliers.service.ts` answers three questions and is the only code that reads purchases for this purpose:
  - `getSupplierFacts(orgId, productIds)` → per article, a list of `SupplierFact { supplierId, supplierName, lastPurchasedAt, lastUnitPrice?, currency?, quantity, documents, lastDocument: { kind: 'bill' | 'receipt', id, number } }`, in the default order of §2.2;
  - `findProductIdsBySuppliers(orgId, supplierIds)`;
  - `findProductIdsWithoutSupplier(orgId)`.
- The evidence rules are §2.2's. A bill and the receipt it covers count once. A voided or cancelled bill, a draft, an incoming credit or debit note, a reversed or `recordOnly` receipt and a supplier order never count.
- Nothing is stored. The interface does not mention how it reads, so a stored view can replace the body.

**FR-28.2 — Indexes and budget (MUST).**
- The schemas declare what the explain test of §6 demands. Expected: `Invoice { orgId, direction, 'lines.productId' }` and `{ orgId, direction, contactId }`, and `StockMovement { orgId, type, contactId }` (it already has `{ orgId, 'lines.productId', date }`). They build at start like every other index here.
- A page of 100 articles answers in 300 ms or less at the 95th percentile on a fixture of 25 000 articles and 20 000 bills. The supplier filter likewise. No `COLLSCAN` on `invoices` or `stockmovements` in either plan.

**FR-28.3 — The filters (MUST).**
- `GET /warehouse/product` accepts `supplierId` (comma list), `noSupplier`, `stockMin`, `stockMax`, `belowMin` and `basis` as §2.3 defines them. They combine with every existing filter and sort by AND. `ids` still overrides the warehouse restriction. The response shape and every existing parameter stay as they are.
- The warehouse restriction (`quantity > 0` there) holds unless a quantity filter is present; then the quantity filter decides.
- `supplierId` and `noSupplier` from a caller without `bills.view` are refused with 403.

**FR-28.4 — One stock figure (MUST).** The stock column's sort, the quantity filters and the order dialog's defaults call one function (the one in `product-stock-sort.ts`, extended): the sum of `quantity` over the warehouses, or the chosen warehouse's, an article with no row counting as 0. A unit test pins it equal to the Stock cell on a fixture with a negative level, a zero level and a missing row.

**FR-28.5 — One "below minimum" (MUST).**
- `belowMin` is the Reports `stock-levels` rule: `trackInventory`, `minStockLevel > 0`, figure `< minStockLevel`. A test runs both over one fixture and asserts the list's result contains everything the report lists, plus the articles the report drops for having no stock row.
- `ProductDao.findLowStock` (no caller, no test) is removed or becomes a call to the same function, so the codebase has one definition. The Stock-levels page's `lowStockOnly` switch, which sends a parameter nothing reads, is wired to it.

**FR-28.6 — Suppliers on the list (MUST).**
- `GET /warehouse/product-supplier/by-products?productIds=` (at most 100 ids) answers `{ suppliers: { [productId]: SupplierFact[] } }`, five facts per article at most, in the default order. The list calls it once per page, as it calls `stock-level/by-products`.
- The Suppliers column is on by default. *Last purchase*, *Last cost*, *Minimum* and *To order* are in the cog, off by default. The column order puts Suppliers after On order.
- A caller without `bills.view` gets no `suppliers` key, the Suppliers, Last purchase and Last cost columns are not offered, and the supplier filters are not drawn.

**FR-28.7 — The Suppliers tab (MUST).**
- `/inventory/products/:id/suppliers` joins the flat tab route (`edit | pricing | settings | stock | ledger | movements | levels`) and `ProductTabBar`. In `new` mode it is disabled with the "save first" tooltip, like the stock tabs.
- One row per supplier: the facts of §2.1, a link to the contact, and the last ten documents behind them (bills and receipts, each a link; one the caller may not open is not listed).

**FR-28.8 — From the supplier's side (MAY).** A supplier's contact page lists the articles bought from it, from the same service.

**FR-28.9 — Recorded suppliers (SHOULD).**
- The `ProductSupplier` model of §2.2, `PUT` and `DELETE /warehouse/product/:id/suppliers/:supplierId`, needing `products.edit`. A supplier with documents cannot be "deleted" from the tab (its facts return), but its recorded fields can be cleared.
- `preferred` is unique per article: setting it clears the previous one.
- The Suppliers tab edits it in place. The row shows facts and recorded fields together, with a badge where a supplier is recorded and has no documents.

**FR-28.10 — Searching by the supplier's code (MAY).** With FR-28.9, the product search also matches a recorded `supplierSku`, through a lowered mirror field kept by `loweredFieldsPlugin` like the other searchable fields. A Cyrillic pattern is never sent to Mongo as a `$regex` from Bun (it becomes `\uXXXX` and fails). The search box stays a text search on the article: a supplier's name is not a search term, and the Supplier filter does that job.

**FR-28.11 — One default supplier (MUST).** The rule of §2.2 is one function. The preview of FR-28.16 and `getInternalOrderSuggestions` use it, so the `supplierHint` the customer-order form's Generate dialog prefills from (`InternalOrderFormView.vue:1091`) becomes its answer. Today's rule, the newest supplier order with a line for the article (`reservation-ops.service.ts:909-919`), survives as its last fallback. `generateExternalOrder` takes the supplier as an input and does not change.

**FR-28.12 — Receipts that name a supplier (SHOULD).**
- The PlusMinus receipt import (`map-plusminus-stokrazp.ts`, `scripts/receive-stock-api.ts`) resolves `partner` to an existing supplier by exact normalized name through the matching ladder and posts `contactId`. It creates no contact from free text and books nothing differently.
- A name that matches none or several is listed in the import's report with a count. `receive-stock.ts` and `receive-new-products.ts` follow when they carry a partner.

### 3.2 Selection and orders from the list (slice 4)

**FR-28.13 — Selection in `ListScaffold` (MUST).** New props `selectable` and `v-model:selected` (an array of ids, not objects, so it holds across pages), and a `bulk-bar` slot above the table. Nothing changes for a list that does not set `selectable`.

**FR-28.14 — Selecting on the Products list (MUST).**
- The checkbox column, the header checkbox for the page, the "Select all N that match" banner, the "N selected (M outside this filter)" chip and Clear behave as §2.3 says. The selection survives paging, sorting, column changes and filter changes, is cleared after an order is created, and is not kept in the URL.
- "All that match" travels as the filter, never as a list of ids, and the server resolves it with the list's own filter builder. The cap is 500.

**FR-28.15 — The bulk bar (MUST).** *Create supplier order* and *Create customer order*, shown when at least one article is ticked and the role holds `orders.create`. Over the cap they are disabled, with the reason as a tooltip. The row menu's Receive, Sell and Reserve stay as they are.

**FR-28.16 — Preview (MUST).**
- `POST /org/:orgId/invoicing/orders/from-products/preview`, body `{ productIds?: string[], filter?: <the list's query>, warehouseId? }`, answers `{ rows, total }`. A row is `{ productId, sku, name, unit, onHand, reserved, onOrder, minStockLevel, maxStockLevel, suggestedQuantity, suppliers: [{ supplierId, name, lastUnitPrice?, currency? }], supplierId?, expectedUnitPrice?, warehouseId }`: the defaults of §2.3, computed on the server so every client gets the same ones.
- Over 500 articles: 422 `selection_too_large`. Deactivated articles are not in the rows.

**FR-28.17 — Create a supplier order (MUST).**
- `POST /org/:orgId/invoicing/orders/from-products`, body `{ requestId, items: [{ productId, quantity, supplierId, warehouseId, expectedUnitPrice? }], appendToOrderId? }`, answers `{ order, skipped: [{ productId, reason }] }`.
- It builds a draft ORDO with the same group, line and allocation builder `generateExternalOrder` uses, **extracted, not copied**: one group per supplier, a line per article (`description` = the name, `sku`, `unit`, `expectedUnitPrice`), one allocation of the whole quantity to the row's warehouse. The draft number is `DRF-ORDO-…` from the draft counter with the existing retry on a duplicate.
- Checks, all against the organization of the route: every product exists and is active, every supplier is a contact of type `supplier` or `both` and active, every warehouse exists, `quantity > 0`, at most 500 items, a supplier on every row. A failing item is skipped with a reason when the rest can stand, and the whole request is refused with 422 when none can.
- `appendToOrderId` must be a **draft** ORDO of the organization (else 422 `order_not_draft`, as `generateExternalOrder`). Lines are appended, never merged with an existing line of the same article; the dialog warns that the article is already there.
- **Idempotent on `requestId`**: a second request with the same id returns the order the first created, with 200. The id is stored as `createdFrom: { source: 'products', requestId }` under a sparse unique index on `{ orgId, 'createdFrom.requestId' }`.
- Audit: `create` / `order`, with the source and the number of items. No transaction is needed for a plain create; an append is one conditional update.

**FR-28.18 — Create a customer order (MUST).** `POST /org/:orgId/invoicing/internal-orders/from-products`, body `{ requestId, contactId, requestedDeliveryDate, issueDate?, priority?, warehouseId?, items: [{ productId, quantity }] }`. `contactId` is a customer or `both` contact of the organization. It creates a draft ORDI (`DRF-ORDI-…`), idempotent like FR-28.17, and answers `{ order, skipped }`. It confirms, reserves and sends nothing.

**FR-28.19 — The dialogs (MUST).**
- As §2.3 draws them: one row per article, editable quantity, supplier (or, for a customer order, none), price and warehouse; the supplier select in default order; "Set the supplier of all rows"; Create blocked until every row has a supplier, saying how many rows lack one.
- Creating a document opens it (FR-22.35). Closing the dialog keeps the selection.
- Offering "add to the open draft" is a SHOULD (FR-22.42).

**FR-28.20 — The same checks on the existing endpoints (SHOULD).** `POST` and `PUT` of an ORDO and an ORDI accept any ObjectId for `supplierId`, `contactId`, `productId` and `warehouseId` today. They get FR-28.17's checks, so there is one rule.

**FR-28.21 — Access (MUST).**
- The preview and both creates need what creating an order by hand needs: `orders.create` in FR-27's terms, `invoicing.write` with the `orders` area today. They are routes under `invoicing/orders` and `invoicing/internal-orders`, so they inherit the existing rules (`config/src/access/routes.ts:171-173`); no catalogue feature is added.
- Without `bills.view` the dialog's supplier select lists contacts but suggests none, and a price default is the article's `purchasePrice` only if the caller may see costs, else empty.

### 3.3 One product search (slice 3)

**FR-28.22 — One list engine (MUST).**
- `useProductList`, `ProductFilterBar` and `useProductColumns` in `ui-shared`, used by `ProductsView` and by the dialog. `ProductsView` does not change for the user: its URL keys, default query (`?page=0&size=10&sortBy=createdAt&sortOrder=desc&isActive=true`), column order, test ids and row menu stay. The specs that pin them pass unmodified: `product-actions`, `products-price-columns`, `products-stock-sort`, the `warehouse*` specs, `tags.spec`, `roles.spec`.

**FR-28.23 — The dialog (MUST).** As §2.4: the list's filters and columns, the list's per-user column choice (`inventory.products`), page sizes 10 to 100 and All, Status defaulting to Active, name order, categories from `GET /warehouse/product-category`, props `multiple`, `stockWarehouseId` (scopes figures, never rows) and `priceField`, Enter and double click to pick, Escape to close. Price columns follow FR-27's field groups (FR-27.6, and the price-visibility amendment on #529 of 2026-11-10): the server omits what a role may not see, and the dialog draws what arrives, as the list does.

**FR-28.24 — The autocomplete (MUST).** One result list under both widgets: a row is the name, then `SKU · unit · stock · price` (§2.4). Two characters, 300 ms and ten hits stay. A scanned code that matches one article is added with no list. Free text stays possible on document lines. A price the role may not see is not in the hit.

**FR-28.25 — Details everywhere (MUST).** A Details button with a tooltip and the shortcut F4 at the end of every product field and every line's product cell on the seven screens, and a "Show all N results" last hit that opens the dialog with the typed text.

**FR-28.26 — The seven screens (MUST).**
- Each of `/inventory/movements/new`, `/invoicing/invoices/new`, `/invoicing/bills/new`, `/invoicing/proforma/new`, `/invoicing/internal-orders/new` and `/invoicing/orders/new` has both parts, and so do the edit pages of the same documents and the credit and debit notes.
- `/invoicing/cash-sales/new` and the back-office cash sale keep their card grid, scanning included, and gain Details, through the till-catalog adapter of §2.4.

**FR-28.27 — What follows a pick (SHOULD).** On every screen with lines, after a pick the line's quantity field is focused and a blank line is added when the last one was filled. The walks P2, P3, P5, P6 and P7 stay inside their budgets, and FR-22's selectors (`.pld-item`, `product-line-create`, `price-combobox`, `register-card`, `cart-line-N`) keep working.

**FR-28.28 — Several articles at once (MUST).** In `multiple` mode "Add N articles" gives each article, in the order ticked, to the screen's own after-pick logic, so price resolution, unit and tax run per line. A document form that does not merge a repeated article keeps not merging it. The dialog marks the articles already on the document.

**FR-28.29 — No catalogue download (MUST).** Opening the dialog makes one products request, one stock side call, the category list and the warehouse list, and nothing sized by the catalogue. A test counts the requests.

**FR-28.30 — The others (SHOULD).** The price-list form and the document-import dialog use the new dialog. The reservation-create dialog and the reports parameter field use the new autocomplete.

**FR-28.31 — A spec for it (MUST).** One e2e spec runs over the seven routes: the placeholder, the Details button and F4, the dialog's column headers equal to the list's, a pick from the autocomplete, and a pick of two articles from the dialog. No spec opens `ProductPickerDialog` today.

### 3.4 Document headers (slice 1)

**FR-28.32 — One banner, without the title (MUST).**
- A `DocumentBanner` component replaces the five copies of the banner. The organization's name and the repeated title are gone from the bill, sales invoice and proforma forms, new and edit, and from the credit and debit notes that share their component.
- The `<h1>` in the form header bar stays, with its subtitle on edit.
- The cash-sale terminal, the supplier-order and customer-order forms and the reservation page use the component and drop the same block (SHOULD, D-14).

**FR-28.33 — Three equal columns (MUST).**
- The banner is a `v-row` of three `v-col cols="12" md="4"`: the party select with its search, create-contact and ledger buttons; the document number with the status chip; the issue date. Below `md` they stack in that order. The due or valid-until date takes the whole first row of the meta column.
- The party select stays the first autocomplete in DOM order, so `focusFirstField` and the specs that take `.v-autocomplete` `.first()` for the contact field still work.
- The classes `doc-banner-party` and `doc-banner-meta` stay, with the number as `.text-h6` and the status chip inside `doc-banner-meta`. Specs read them (`document-lists`, `p3-bill`, `p5-invoice`, `p5-credit-note`, `p6-proforma`, `receipt-to-bill`).

**FR-28.34 — Two notes move (MUST).**
- **Print note** goes to the top of the left column of the notes row, above Reason (Notes on invoices and proformas), the width of that column. **Companion documents note** goes into the right column under the totals card, on the forms that show it today (`companionDocs`: outgoing documents).
- Counters, limits (300), the properties saved (`printNote`, `companionNote`) and the printed PDF stay as they are. Print note keeps showing on every type that shows it today.

**FR-28.35 — Nothing else changes (MUST).** What `formRef.validate()` covers, the draft number's peek, the status chip, the ledger and create-contact buttons, every `data-testid` and accessible name, the Document Type toggle above the shell, and the tab order from the party select onward.

**FR-28.36 — A layout test (MUST).** An e2e spec opens a new and an edit document of each of bill, invoice and proforma at 1366 and 1920 px and asserts: the party select and the number on one row (tops within 2 px); three columns of equal width (within 1 px); Print note above Reason or Notes inside the left column; the companion note below the totals card on invoice and proforma and absent on a bill; the `<h1>` present; no organization-and-title block in the banner. The specs of FR-28.33 pass unmodified.

### 3.5 Orders as a tree (slices 5 and 6)

**FR-28.37 — One node model and one set of figures (MUST).**
- Plain functions build the tree from an order's state: the lines and allocations as edited, the server's reservations, the staged changes. A node has a kind (`line`, `allocation`, `reservation`, `placeholder`), a depth, a label, its quantity, the figures of §2.6, a status, flags, actions and children.
- A staged row counts at once. A reservation cancelled on save counts as `max(invoiced, dispatched)`. The Totals card of both order forms reads the same functions; *Reserved* there stops ignoring staged changes.
- Unit tests cover them with: nothing allocated, over-allocated, a new allocation with a staged reservation, a cancelled-on-save row, an allocation with received quantity, a line with no product.

**FR-28.38 — The component (MUST).** One component draws the tree for the three screens, chosen by the spike S-1 (§2.6): the tree ships on the candidate that passes all seven of its criteria, and the spike's result is recorded in the PR. Whichever it is, the open and closed state is the component's to hold and to give back, so FR-28.42 does not depend on a Vuetify internal.

**FR-28.39 — The supplier order (MUST).**
- Per supplier group, a tree of line, warehouse and client reservation, in the columns of §2.6, replacing the allocation chips, the allocation editor sheet and the reservations grid sheet.
- No server change. `supplierGroups[].lines[].allocations[]` and `reservationChanges { create, update, cancel }` are saved exactly as now; a reservation is still staged and saved with the order.
- Each group's header shows its summary, and a totals row follows its rows.

**FR-28.40 — The + actions (MUST).**
- **+ Warehouse** on a line and **+ Client** on a warehouse insert an editing row, as §2.6 draws it, with the defaults it names. Enter adds a staged row marked "new", Escape drops it. **+ Line** and **+ Supplier** stay.
- The checks of today apply on the row, with the message beside the field: quantity above zero, allocations not above the line, a reservation not above what is free, a client chosen, a warehouse chosen. A **+ Client** on a warehouse that is not saved yet works, because the reservation is staged.
- Add and cancel by keyboard alone are possible (FR-28.47).

**FR-28.41 — Nothing is lost (MUST).** The quantity of a reservation edited in its row (not below what is consumed), change client, cancel with undo, reserve again for a cancelled one, the over-allocation warning, the "new", "cancelled on save" and "unsaved changes" markers, the links to the reservation and to its customer order, received per allocation, invoiced and dispatched, and the Export menu of a saved group.

**FR-28.42 — Open and closed (MUST).**
- A line that holds live reservations opens by itself. A row with a flag (over-allocated, unsaved, unallocated, late) opens, and its parent shows the flag when closed.
- Expand all and Collapse all on each supplier's header.
- The state survives the reload after Save. Keeping it across sessions is a MAY (per user, order and organization).
- A parent with no children shows a placeholder row carrying its **+**.

**FR-28.43 — Collapsible panels (MUST).** A `CollapsiblePanel` (a header button with `aria-expanded`, a one-line summary when closed) wraps the supplier group cards, the Reservations card and the Invoices card of the supplier order, and the lines card, the toolbox card and the Reservations card of the customer order. The state is kept per user, screen and organization (`lgr:ui:panels:<userId>:<orgId>:<screen>`). The flat Reservations cards start closed once the tree exists (D-6), and are not removed.

**FR-28.44 — The customer order (MUST).**
- Lines and their reservations as a tree of two levels in the same columns, with *Invoiced* now shown, a coverage chip, and **+ Reserve** (from stock, from a supplier order, generate a supplier order), each opening the existing dialog filtered to the line.
- Reservation changes stay immediate, each with its own dialog as now. The toolbox card stays, in a panel.

**FR-28.45 — The reservation page (MUST).**
- The five cards become `CollapsiblePanel`s with one-line summaries.
- A **supply tree** shows where the reservation sits: for a supplier-order reservation, the order's line, the warehouse and every reservation on it, this one highlighted; for a stock reservation, the warehouse and the reservations on its stock. The other reservations show the client and the quantity, and link to their pages.
- Links from the page to a supplier order or a customer order open the line.

**FR-28.46 — Links to a line (MUST).** `…/orders/:id/edit?line=<lineId>&allocation=<allocationId>` and `…/internal-orders/:id/edit?line=<lineId>` open the form with that line (and warehouse) open, scrolled into view and highlighted for a moment. The reservation list and the reservation page use them. An id that matches nothing opens the form as usual.

**FR-28.47 — Keyboard and screen readers (SHOULD).** Each node's toggle is a button with `aria-expanded` and a name; the tree is navigable by arrows (up and down between rows, right and left to open and close); the inline rows take Enter and Escape. The grid navigation the forms use (`useGridNavigation`) is not broken.

**FR-28.48 — A reservation for a customer-order line from the supplier order (MAY).** The inline **+ Client** row offers the optional "for a customer order" select the Reservation page's create dialog has, so a reservation made on a supplier order can count toward a customer order's coverage. Today the supplier order's dialog stages only `{ allocation, client, quantity }`.

**FR-28.49 — Specs and budgets (MUST).**
- The specs that pin a control this removes are updated **in the same PR** and nothing else is: the "Allocations" button in `order-forms.spec.ts`, the "Client reservations" button and its `aria-expanded` in `orders-reservations.spec.ts`, and the line row, grid and chip locators in `ux-budgets/p7-who-reserved.spec.ts`.
- P7-who stays at 1 click or fewer (it reads the line's reservations; a line with live reservations opens by itself). P7-chain (≤ 18), P7-repeat (≤ 3) and P7-new (≤ 4) hold.
- A new walk, **P7-tree**, measures "reserve 4 units for a client on a new warehouse row of a supplier order's line": the first PR of slice 5 records today's cost, and the target is at most 7 clicks, 2 typed and no dialog.

### 3.6 Across this FR

**FR-28.50 — Four languages (MUST).** Every new key exists in `en`, `bg`, `de` and `mk` (`ui-shared/src/locales`). A missing key renders literally, so a unit test, in the manner of `web-catalogue-i18n`, fails the build on a key missing in any of the four. The orders' names are those of FR-22 D-1: "Supplier orders" for ORDO, "Customer orders" for ORDI.

**FR-28.51 — Guards stay green (MUST).**
- Access: no catalogue feature is added. A route resolves by its exact key, then by the longest prefix (`config/src/access/routes.ts`). The new ones fall under `warehouse/product…`, `invoicing/orders`, `invoicing/internal-orders` and `invoicing/contact`; where the longest prefix is not the rule wanted, one line is added to `routes.ts`. `access-differential.flow`, `route-permission.flow`, `read-permission.flow`, `tenant-isolation.flow` and `seller-roles.flow` pass without a change to their expectations.
- Replication: a new model declares its class (FR-28.9's `ProductSupplier`: **R**). `bun run gen:replication-meta` is rerun and `unit/replication-meta.test.ts` passes. Slices 1 to 6 add no model.
- Nothing logs a supplier, a price or a quantity at a level above debug.

**FR-28.52 — Contracts that do not move (MUST).**
- `GET /warehouse/product`: every existing parameter, the sorts and the response shape `{ products, items, total, page, size, totalPages }`.
- `POST /org/:orgId/bills/import/{extract,draft,convert}` stays byte-compatible, and so does `POST /org/:orgId/invoices` (the import skills drive them). Route names stay: Playwright and the per-user column preference (`gridId` = route name) depend on them.
- The ORDO and ORDI save payloads, `generateExternalOrder`'s inputs and outputs (its internals are shared, see FR-28.17), the sequence registry (no prefix is hardcoded).

**FR-28.53 — No business data (MUST).** Tests, fixtures, the spec and its field-test notes use the seeded demo organizations, never a customer's names or figures. Anything written to the issue or the PR says "equal", "unchanged" or a count.

**FR-28.54 — Documentation (SHOULD, with the last slice).** `CLAUDE.md` describes a `purchase-api` package with "reorder rules" and "blanket orders". No such package, model or route exists (the product list's minimum is `Product.minStockLevel`; the nearest thing is the Reports `stock-levels` report). That line is corrected in the same PR, and the supplier facts, the product search and the tree each get a short section.

**FR-28.55 — Windows (MUST).** No new test uses `.rejects` or `.resolves` (CLAUDE.md, Known Issues). New e2e spec files do not `import type` from `@playwright/test`; helpers do.

## 4. Migration

Almost nothing is stored, which is the point of reading supplier facts from the documents (§2.2).

| What | Change | Procedure |
|---|---|---|
| Supplier facts | none stored | Indexes declared on the schemas and built at start. No backfill, no flag. The deploy log is read for the index build on `invoices`, which at today's sizes takes seconds |
| Recorded suppliers (FR-28.9) | one new, empty collection, class **R** | Ships in slice 7, so slices 1 to 6 add no model. Before it ships, the PR says what a master older than the hub does with a collection it does not know (FR-20 #453, #515) |
| Orders made from products | an optional `createdFrom { source, requestId }` on `Order` and `InternalOrder`, and a sparse unique index | Existing documents are untouched. An older master ignores the field |
| Column preferences | none | `useGridColumns` places a column shipped later after its predecessor in the catalogue and starts `defaultHidden` columns hidden, so a saved choice neither hides *Suppliers* nor shows the optional columns |
| The dialog's columns | it now reads `inventory.products` | A user who set the list's columns sees them in the dialog. One who did not sees the defaults |
| Panel and tree state | new `localStorage` keys, each wrapped in `try/catch` | None |
| Specs | the three of FR-28.49 | Updated in the PR that removes the control each pins |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| 1 | FR-28.32 to .36 (headers); `CollapsiblePanel` on the order forms' cards, all open (FR-28.43 without the closed default) | calmer headers; collapsible cards | the layout spec; the specs of FR-28.33 unmodified; P3, P5, P6 inside their budgets |
| 2 | FR-28.1 to .8 and .11: the supplier service, the filters, the columns, the tab | Products: supplier and quantity filters, Suppliers column | the explain test and the 300 ms budget; the filter tests; `belowMin` equals the report; P1 unchanged |
| 3 | FR-28.22 to .31: the list engine, the product search, the dialog on the seven screens | one search | the conformance spec; the request-count test; P2, P3, P4-till, P5, P6, P7 inside their budgets |
| 4 | FR-28.13 to .21: selection, the bulk bar, orders from products | an order from the list in one step | P9; the integration tests; the idempotency test |
| 5 | S-1, then FR-28.37 to .43, .46 to .49 for the supplier order | the tree | P7-who ≤ 1; P7-tree ≤ 7 clicks; the three specs updated |
| 6 | FR-28.44 and .45: the customer order and the reservation page on the tree | the same everywhere | P7-chain, -repeat and -new inside their budgets |
| 7 | FR-28.9, .10, .12, .54: recorded suppliers, receipts that name a supplier, the docs | a preferred supplier | the recorded-supplier tests; an import report that lists unresolved partners |

**Order.** 1, then 2 to 4 in that order (4 needs the supplier defaults of 2 and the list engine of 3), then 5, 6 and 7. Slices 1, 5 and 6 do not touch products, so a second developer can take them beside 2 to 4.

**Rollback.** Slices 1, 3, 5 and 6 are interface changes: revert the PR, no data to undo. Slice 2 stores nothing: revert, and the indexes are harmless. Slice 4 creates ordinary drafts: cancel or delete them, and remove the three endpoints; `createdFrom` is optional. Slice 7 drops its collection.

**Risks.**
- *The supplier read slows down as an organization grows.* The budget test, and the stored view behind the same interface.
- *A role learns a supplier or a cost through the list.* FR-28.3 and FR-28.6 omit the keys on the server, and a test asserts the keys are absent from the JSON.
- *The tree loses something the old forms did.* FR-28.41 lists it, the specs and walks pin it, and S-1 comes first.
- *The new search slows the receipt, the invoice or the till.* The budgets, the unchanged barcode path, and a till that keeps its grid.
- *The list and the dialog drift apart again.* They share one engine.
- *A double click makes two orders.* `requestId`.
- *The 500-article cap surprises someone.* The bar says why it is disabled and what to do.

## 6. Tests

- **Supplier facts** (`product-suppliers.flow`): a received bill counts, and a draft, a voided, a cancelled one and an incoming credit note do not. A receipt counts only when no bill covers it, and a bill with its receipt counts once. Editing an issued bill's supplier, or a line's article, moves the fact at once. A void removes it. A receipt with no supplier names none. The default order. Visibility: without `bills.view`, no `suppliers` key and a 403 on `supplierId`. The cost key is absent without the cost right.
- **Filters** (`products-list-filters.flow`): supplier, no supplier, the range, `belowMin` against the Reports rule on one fixture, the article with no stock row counting as 0, a negative level, `trackInventory: false`, the warehouse restriction with and without a quantity filter, AND with every other filter, the response shape unchanged. `explain()` shows index use on `invoices` and `stockmovements`. An opt-in performance test runs the budget of FR-28.2 on a 25 000-article, 20 000-bill fixture (on mars or in the nightly).
- **Orders from products** (`orders-from-products.flow`, `internal-order-from-products.flow`): the preview's defaults; one group per supplier; one allocation per line; every id checked against the organization (a product, supplier or warehouse of another organization is refused); an inactive product and a non-supplier contact skipped; quantity ≤ 0; more than 500; `appendToOrderId` only to a draft; the same `requestId` twice gives one order; the audit entry; the draft number and its retry. `generateExternalOrder`'s existing tests pass unmodified after the builder is extracted.
- **Guards, unmodified**: `route-permission.flow`, `read-permission.flow`, `tenant-isolation.flow`, `access-differential.flow`, `seller-roles.flow`, `unit/replication-meta.test.ts`, `order-reservations`, `internal-order`, `reservation-preempt`, `order-form-reservations`, `order-screens`.
- **Unit**: the stock figure equals the Stock cell; the search hit row; `ListScaffold` selection holds ids across pages; the tree's node model and figures (FR-28.37); the four locales.
- **E2E**: the conformance spec over the seven routes (FR-28.31); the Products list: filter, select all that match, create a supplier order, land on it, and a second click makes no second order; the request count when the dialog opens (FR-28.29); the layout spec (FR-28.36); the tree: add a warehouse, add a client, collapse, compare the summary with the Totals card, cancel and undo; the panels' state across a reload.
- **Walks** (`ux-budgets`, FR-22's recorder). The first PR of each slice records today's number before changing anything, as FR-22 did.

| Walk | Today | Target | What gets it there |
|---|---|---|---|
| P1, P2, P3, P4-till, P5, P6, P7-chain, -repeat, -new | FR-22's budgets | unchanged | FR-28.27 |
| P7-who | ≤ 1 | ≤ 1, usually 0 | FR-28.42 |
| *new* P7-tree | to be measured in slice 5 (by hand about 11 clicks and one dialog) | ≤ 7 · 2 typed · no dialog | FR-28.40 |
| *new* P8 | three articles added to an invoice through Details, one by one: about 9 clicks | ≤ 8 clicks · 0 typed · 1 dialog | FR-28.23, .28 |
| *new* P9 | reorder from the list: not possible; by hand 4 or more clicks per article | filter, select all, create, set the supplier: ≤ 8 clicks · 0 typed | FR-28.14 to .19 |

## 7. Acceptance criteria

1. On a fixture organization, the supplier filter lists exactly the articles with a supplier fact for that supplier, and *No supplier* lists the rest. Editing or voiding a bill moves the facts at once. A role without `bills.view` gets no supplier key and a 403 on the filter.
2. *Below minimum* equals the Reports `stock-levels` rule on every article that report lists, and also lists the articles with no stock row. The stock-levels page's switch works.
3. From the Products list, with *Below minimum* on and *Select all that match*, *Create supplier order* makes one draft with a group per supplier, a line per article and one allocation per line, and opens it. The same request twice makes one. *Create customer order* makes a draft customer order. Neither sends, confirms or reserves anything.
4. Each of the seven screens has the autocomplete and Details; the dialog's headers equal the list's; its column choice is the list's; opening it makes no request sized by the catalogue.
5. The three headers have the party select, the number and the issue date on one row of three equal columns, Print note above Reason or Notes, the companion note under the totals, and no organization-and-title block. Every saved property and the printed PDF are unchanged.
6. The supplier order, the customer order and the reservation page show allocations and reservations as a collapsible tree or panels, with totals on each parent. FR-28.41's list still works. P7-who ≤ 1 and P7-tree ≤ 7.
7. The existing suites pass unmodified, except the specs FR-28.49 names. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.
8. The four locales are complete. The access, tenant and replication guards pass without a change.
9. No test, fixture, comment on the issue or PR carries a customer's name or figure.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

1. **Slice 1.** Open a new and an edit bill, invoice and proforma. Read the layout (FR-28.36 by eye). Print an invoice carrying a print note and a companion note: the text on the PDF is unchanged.
2. **Slice 2.** Post a bill for one article from a supplier. The article's Suppliers tab names it, and the filter finds the article. Change the bill's supplier: the fact moves. Void the bill: it goes. Give two articles a minimum above their stock: *Below minimum* lists them. A throwaway Seller sees no suppliers and gets 403 on the filter.
3. **Slice 3.** On each of the seven screens type two letters, pick; then Details, filter by a category, tick two articles, add them. Compare the dialog's columns with the list's.
4. **Slice 4.** On Products: *Below minimum*, *Select all that match*, *Create supplier order*, set the missing suppliers, create. It opens a draft. Press Create twice quickly in a second try: one draft. Create a customer order from two articles.
5. **Slices 5 and 6.** Build a supplier order with two lines, two warehouses and two clients. Collapse each level and compare its summary with the Totals card. Cancel a reservation and undo it. Open a reservation's page: its supply tree names the others. Follow its link back: the line is open and highlighted.
6. **Clean up.** Cancel or delete every draft, order and reservation the test made, drop the throwaway users, and report the count left (0) and how it was checked.

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | What is the "min quantity filter"? | Both a range on the list's stock figure, and *Below minimum*: the article's own `minStockLevel`, the Reports rule. The figure is on hand; *Count open orders* is the option. If the minimum quantity of a price tier (`priceTiers[].minQuantity`) was meant, that is another filter and is not built |
| D-2 | What counts as "procured through a supplier"? | A received bill's lines, and a receipt no bill covers. Not a supplier order (it is On order), not a credit or debit note, not a draft |
| D-3 | The third column of the banner row | The issue date. The request names the party select and the number only. Alternatives: the supplier invoice number (bills), or an empty column |
| D-4 | Supplier facts: read or stored? | Read from the documents (§2.2). A stored view replaces the body only if FR-28.2's budget fails |
| D-5 | One supplier order, or one per supplier? | One draft with a group per supplier: what the model is for, and what generate-external does. Several orders by creating several |
| D-6 | The flat Reservations cards once the tree exists | Kept, closed by default. Remove them later if nobody opens them |
| D-7 | Vuetify `group-by`, or our own tree? | S-1 decides on seven criteria. Expected: our own, over `v-table`, with Vuetify's group-summary as the pattern |
| D-8 | The dialog's columns | The same per-user choice as the Products list |
| D-9 | The suggested quantity | `max(1, target − position)`, with `target` = `maxStockLevel` when above zero, else `minStockLevel`, and `position` = on hand − reserved + on order |
| D-10 | The till | Keeps its card grid and scanning, gains Details |
| D-11 | Stock in a search row | On hand, with the reserved quantity in brackets |
| D-12 | The selection cap | 500 articles |
| D-13 | Who sees supplier facts | Whoever may see bills (`bills.view`); the price also needs the cost right |
| D-14 | The organization-and-title block on the other banners | Dropped on the cash-sale terminal, both order forms and the reservation page too, so the five stay alike |

## 10. Not in this FR

- Supplier price lists, quotations and requests for quotation, lead-time planning, supplier scoring, a supplier portal.
- Reordering on a schedule: a job that drafts supplier orders by itself. `ReorderRule` does not exist; this FR only makes the manual path one step long.
- A stored supplier index, until the budget of FR-28.2 fails.
- Bulk actions on the Products list other than the two orders (a selection of articles into an invoice, a receipt or a price change is the natural next use of FR-28.13), and the Products list's Export, whose `onExport` only logs.
- What a document line becomes after a pick: price resolution, units, tax and the product-update switch.
- Merging products or suppliers, or creating a supplier from a free-text name.
- Typing a supplier's name into the product search box: the Supplier filter does that job.
- A redesign of the till's card grid, or of the sales-side price resolution.
- Layouts below the width the forms already stack at.

## 11. Build log

What each slice shipped, and where building it differed from the plan above. Only what is new: the requirements stand as written.

### Slice 1: headers and panels

- **Built.** `DocumentBanner`, one component for the five banners (the six document types, the cash sale, both order forms, the reservation page); the two notes moved (FR-28.34); `CollapsiblePanel` with its state kept under `lgr:ui:panels:<userId>:<orgId>:<screen>`, on the order forms' cards, all open. Tests: the `document-header-layout` and `collapsible-panels` specs, and the `panel-state` unit test.
- **A new document has no status chip.** §2.5's drawing shows `[Draft]` under the number of a new bill. The code never showed a chip there (`statusDef` is undefined until the document is saved) and FR-28.35 keeps the chip as it is, so a new document shows its number alone.
- **One `.v-form` on the page.** Moving the issue date out of the document's `<v-form>` would drop its `required` check from a save (FR-28.35). A form of its own round the date works, but it is a second `.v-form`, and `credit-notes-fix`, `invoicing` and `proforma-convert` find the form by `page.locator('.v-form')` in strict mode. So `DateField` exposes `validate()`, and `validate()` in `useDocumentForm` asks the date as well as the form. The layout spec pins both: an emptied date still stops a save, and there is one form.
- **The banner keeps room for one message.** Without the print note, nothing in the banner set its height but the party select. When the select lost focus its `required` message appeared, the banner grew by a line, and everything under it moved while the mouse button was still down. The click that took the focus away was dropped: the first click on „With product update" did nothing (`bill-product-update` caught it). A banner that holds a field now reserves the line, and the layout spec asserts nothing below it moves when a field loses focus.
- **Cash sale.** The companion-documents note moved with the others, to the notes column of the terminal. That form has no totals card to put it under.
- **Panels.** A panel keeps its body mounted while folded (`v-show`), so its fields still validate and keep what was typed. A `flag` stays on the header either way: a supplier card with no supplier says so folded, because a save refuses it. The Reservations card of a customer order keeps its order-wide buttons on its header.
- **Walks, before and after** (clicks, typed): P3 3, 1. P5-credit 5, 1. P5-invoice 14, 6. P6 12, 5: equal. P7-chain 18, P7-new 4, P7-repeat 3, P7-who 1: inside their budgets.


- **Field test** (§8.1, production, demo organization): 48 of 48. The layout read at 1366 and 1920 px on a new and an edited bill, invoice and proforma; the print note and the companion note saved and printed on the PDF; what the test made was removed (0 left).

### Slice 2: supplier facts, the filters, the Suppliers column and tab

- **Built.** `services/biz/product-suppliers.service.ts` (`getSupplierFacts`, `findProductIdsBySuppliers`, `findProductIdsWithoutSupplier`, `getDefaultSuppliers`): supplier facts read from received bills and from completed receipts that name their supplier and that no received bill holds. Nothing is stored and no model is added. `GET /warehouse/product` takes `supplierId`, `noSupplier`, `stockMin`, `stockMax`, `belowMin` and `basis=projected`, ANDed with every other filter and with `ids`; a quantity filter decides instead of the warehouse's "hide what it does not hold" rule, and `supplierId` and `noSupplier` are 403 without `bills.view`. `GET /warehouse/product-supplier/by-products` (at most 100 articles, five facts and a count each, no `suppliers` key at all without `bills.view`) and `/:productId` (every fact and the last ten documents behind them). One stock figure and one "below minimum" (`ProductDao.findLowStock`, a third definition with no caller, is removed; the Stock-levels page's `lowStockOnly` switch, which sent a parameter nothing read, uses the same rule). `getInternalOrderSuggestions`' `supplierHint` is the default supplier. UI: a Suppliers column (on by default, after On order), Last purchase, Last cost, Minimum and To order on the cog, the filters in the URL, and `/inventory/products/:id/suppliers`. Tests: `product-suppliers.flow` (40), `products-list-filters.flow` (24), `product-suppliers.spec` (5); the budget of FR-28.2 (`LGR_PERF=1`): a page of 100 articles in 31 ms p95 on 25,000 articles and 20,000 bills, the supplier filter 7 ms.
- **Walks.** P1 unchanged (5 clicks, 2 typed; P1-act 2 clicks).

**Where the plan was silent or wrong.**

- *A receipt held by a DRAFT bill still counts.* The spec's rule ("no `invoiceId`") drops the purchase between making a bill from a receipt (FR-22.31, the path that flow recommends) and receiving that bill: a draft is not evidence, so the fact would blink out for days. The receipt carries it until the bill is received; then the bill does and the receipt stops (tested both ways, and for a void).
- *The Stock sort keeps ranking an article with no stock row last* (`products-stock-sort.spec` pins it: its cell shows a dash), so FR-28.4's "no row counts as 0" applies to the filters and the dialog defaults, through the same `columnFigures` sum. One figure, two readings of "absent", both documented where they are read.
- *`by-products` also returns `counts`*, so "+N" does not understate an article with more than five suppliers.
- *No cost right exists yet.* `products.costs` is designed in FR-27 but is not in the catalogue, so the price keys follow `bills.view` through one predicate (`canSeeSupplierPrices`); the day FR-27 lands, that predicate is the only line that changes.
- *No route line was needed.* `warehouse/product-supplier/*` resolves by the `warehouse` prefix; the access guards pass unmodified. A caller with products but not bills gets 200 `{}` from `by-products` and 403 from the tab.
- *The Suppliers column is capped at 100 px below 1600 px* (220 above): with real names it overflowed the 1366 px list by 43 px, which `product-actions.spec` (FR-22.23) forbids; names are cut with an ellipsis and the tooltip has them whole.
- *The explain test was too weak:* it asserted "no COLLSCAN", which the older `{orgId, direction, …}` indexes satisfy by prefix; it now asserts the intended index.

**Not done.** FR-28.8 (a supplier's contact page lists the articles bought from it, a MAY).

- **Field test** (§8.2): 18 of 19. A received bill makes its supplier a fact of the article (tab and filter), the fact moves when the bill's supplier is edited and goes when it is voided; *Below minimum* lists the articles given a minimum above their stock. The 19th (a role without `bills.view` gets 403 on the filter) could not run on production: no demo account lacks `bills.view` except one that is refused outright; it passes on the local seed (23 of 23). The one voided bill, its receipt and the compensating movement stay in the demo organization.

### Slice 3: one product search

- **Built.** The Products list's engine, shared: `useProductList`, `product-list-params`, `useProductColumns`, `ProductFilterBar` and `ProductCell` in `ui-shared`, under both the Products page (unchanged for the user: the specs that pin it pass unmodified) and `ProductPickerDialog`, which is now the Products list in a window ("Details"). It has the list's filters (the supplier and quantity ones only for a role that may read bills), its columns and the user's saved choice of them (`inventory.products`), page sizes up to All, Status on Active and name order. `multiple` adds a tick column and "Add N articles", in the order ticked; the articles the document already holds are marked, not hidden; `stockWarehouseId` scopes the figures and never the rows; `priceField` starts the cost column shown where a pick starts from the purchase price; the typed text is carried in; the arrows move the highlighted row, Enter picks it, Escape closes. `source="till"` reads the cash register's catalog.
- **One hit row** (`product-hit`) for `ProductSearch` and `ProductLineDescription`: the name, then SKU · unit · stock · price, a last row "Show all N results", and F4 or a `ProductDetailsButton` to open the dialog with what was typed.
- **The screens.** Details on movements, invoices, bills, proformas, customer orders, supplier orders, the back-office cash sale and the till (which keeps its card grid and scanning; the dialog adds one unit of each ticked article, as a card click does). The price-list form takes the same pieces in single-pick mode, and so does the document import. After a pick on a document the cursor goes to the quantity.
- **Tests.** `product-search.spec` (32): per screen the field, the hit row and the multi-add; the dialog's columns and the user's choice of them; the typed text carried in (F4, "Show all"); the request count on open (FR-28.29); Active until Status says otherwise; the arrow keys and Enter; a Seller (no supplier filter, column or call); the stock range's and the tags filter's labels not cut at 1366 px in four languages; the till. Unit `product-hit`, `product-list-params`, `product-columns`. Walk P8.
- **Walks** (clicks · typed · dialogs). All 17 existing walks are equal to what slice 2's head measured before this slice changed anything: P0-new ×3 1·0·0, P1-act 2·0·0, P1 5·2·0, P2 17·12·1, P3 3·1·0, P4-open 5·1·1, P4-storno 3·0·1, P4-till 3·4·0 (4 keys), P5-credit 5·1·0, P5-invoice 14·6·0, P6 12·5·0, P7-chain 18·8·1, P7-new 4·3·1, P7-repeat 3·0·1, P7-who 1·0·0. The new P8 (three articles added to an invoice through Details): 5·0·1, against 6·0·3 when each article is its own trip through the old dialog (target ≤ 8·0·1).

**Where the plan was silent or wrong.**

- *One request, not two.* A Vuetify server table asks for its page when it mounts, and the owner asks when the dialog opens: two identical requests (the Products page has always made two on load). The engine keeps one request in flight per set of parameters and ignores a stale answer.
- *The dialog's supplier calls are lazy.* The facts are asked for only while the Suppliers column is shown, the supplier filter's choices when it is first used. The page loads both at once, as before.
- *A closed dialog must not fetch.* The till's filters read the screen's warehouse; when it arrived the filter watcher fetched the catalog for a dialog nobody had opened. The engine has an `active` gate.
- *No `sort-by` on the dialog's table.* A controlled `sort-by` on a Vuetify server table swallows the header clicks (`update:options` never fires), so the initial name order shows no arrow.
- *The list's capital headers are AppShell's CSS*; a teleported dialog does not get them, so the dialog says the same again.
- *"Active" was not one rule for the inline search either.* It listed deactivated articles, so "Show all 13 results" opened a dialog of 12. The inline search now asks for active articles, as the list, the dialog and the till do; a deactivated article is one Status change away in Details. A small behaviour change: **to be confirmed by the owner**.
- *The inline overlay ran off the bottom of the window*, which hid its last row (now "Show all N results"). It takes the room it has and goes above the field when there is more.
- *The cost column.* A screen whose pick starts from the purchase price (a bill, a supplier order, a movement) shows that column by default. It only moves the default: the user's saved choice still wins.
- *The cursor after a pick* goes to the quantity only while it is still where the pick left it: an unconditional timer took it from a user who had already moved on.
- *The first look at 1920 px and in bg, de and mk found two things.* The dialog stopped at 1400 px while the list's columns are 1640 to 1930 px wide, so on a wide screen it scrolled sideways where the page did not: it takes up to 1840 px now, and at 1920 an invoice's dialog shows every column in all four languages (at 1366 it scrolls, as the page does). And „Филтриране по тагове" was cut to "…по таг…" at 1366 px, five pixels short, in the list since before this FR: that column has less padding, and the label spec runs in en, bg, de and mk.
- *The fixed Name cell took no tint.* The highlighted row (the first, on every open) is a translucent tint, and a fixed column paints its own opaque background, so the cell stayed white. The same tint goes over the cell. The hover tint on a fixed cell is Vuetify's and is the page's too: not touched.

**Not done, and next.**

1. FR-28.27 on the supplier order (the next line and the quantity focus): after slice 5 has rewritten that form's lines. The customer order and the movement already had both.
2. FR-28.30: the reservation-create dialog and the reports parameter field keep their own product autocompletes. Their search is tied to their own state (the reservation dialog resolves the chosen article for its unit and availability; the report field is one branch of a generic entity picker), so a swap needs a pass of its own.
3. ~~The field test of §8.3 on production, in the demo organization.~~ Done after the merge: see its Field test bullet.
4. Not covered by a spec: the price-list form and the document import's use of the dialog (single pick). The price-list form was clicked through (F4 with two letters, one row, the line holds the article); the import shares that code path and was not run.

- **Field test** (§8.3): 63 of 63, nothing saved. On each of the six document screens: the hit row (SKU · unit · stock · price, the stock filling in), the pick filling the line and the cursor going to its quantity (not on the supplier order: slice 5), *Details* opening the dialog with exactly one products page, its columns equal to the list's, its search narrowing it, two ticked articles coming back as two lines in the order ticked; the price-list form with F4 and a single pick. Not exercised on production: the till's dialog (it needs an open till session; the till specs cover it) and the category filter (the demo organization has no product categories). At 1366 px the dialog scrolls sideways, as the page does; at 1920 px an invoice's fits and a bill's overflows by 81 px with this organization's six price-tier columns. (The "Not done" item 3 above is this test.)

### Slice 4: orders from the Products list

- **Built.** Server: `POST invoicing/orders/from-products/preview` (one row per article with the defaults computed on the server; "all that match the filter" resolved with the list's own filter builder, which is now one function, `services/biz/product-list-query.ts`, taken out of the product controller and used by the list and the preview alike; 422 `selection_too_large` over 500); `POST invoicing/orders/from-products` (ONE draft supplier order, a group per supplier, a line per article, one allocation of the whole quantity; idempotent on `requestId`; `appendToOrderId` only to a draft); `POST invoicing/internal-orders/from-products` (ONE draft customer order). The group, line and allocation builder of `generateExternalOrder` is extracted (`order-builder.ts`, not copied: `reservation-preempt`, `order-reservations` and `internal-order` pass unmodified), the draft numbering moved from the two controllers to `order-numbering.ts`, and the reorder arithmetic is one pure function (`config/reorder-quantity`) that the list's „To order" column and the preview's starting quantity both read. UI: `ListScaffold` takes `selectable`, `v-model:selected` (ids) and a `bulk-bar` slot; the Products page has the tick column, the header checkbox, the banner "Select all N that match the filter", the chip "N selected (M outside this filter)" and Clear; two dialogs (one component, `OrderFromProductsDialog`) make the draft and open it.
- **Tests.** Integration `orders-from-products.flow` (26 cases) and `internal-order-from-products.flow` (10); unit `reorder-quantity` (11: the column's cases, each also asked of the dialog's function) and `product-selection` (14: ids held across pages and filters; "all that match" travels as the filter; the cap); e2e `product-orders.spec` (5); walk P9. The whole unit directory passes but for the one environmental failure on Windows ("rendering serves nothing", FR-20.25). The guards pass without a change to their expectations: `route-permission`, `read-permission`, `tenant-isolation`, `access-differential`, `seller-roles`, `replication-meta`; so do the three `generateExternalOrder` suites, `order-screens`, `order-form-reservations` and `reservation-screen`.
- **Walk P9** (clicks · typed · dialogs): today's number is "not possible" (the list had no filter for what is short, nothing to select and no order action; by hand four or more clicks per article). Through the list: **7 · 0 · 1** (target ≤ 8 · 0 · 1): „Below minimum", tick the page, „Select all N that match", „Create supplier order", open the supplier of all rows, choose it, „Create". The 18 other walks are equal to slice 3's numbers (P0-new ×3 1·0·0, P1-act 2·0·0, P1 5·2·0, P2 17·12·1, P3 3·1·0, P4-open 5·1·1, P4-storno 3·0·1, P4-till 3·4·0, P5-credit 5·1·0, P5-invoice 14·6·0, P6 12·5·0, P7-chain 18·8·1, P7-new 4·3·1, P7-repeat 3·0·1, P7-who 1·0·0, P8 5·0·1).

**Where the plan was silent or wrong.**

- *A sparse unique index does not do what the plan says.* `{ orgId, 'createdFrom.requestId' }` sparse: `orgId` is on every document, so every document is indexed, under a null `requestId`, and the second one is refused. It is a partial index (`partialFilterExpression: { 'createdFrom.requestId': { $type: 'string' } }`), on `Order` and `InternalOrder`.
- *An append creates nothing, so `createdFrom` cannot make it idempotent.* A replayed append would add the lines twice. The draft records the request ids that appended to it (`appendedRequestIds`), and the append is ONE conditional update on the draft as it was read (still a draft, `updatedAt` unchanged, the request id not recorded yet): a replay answers with the draft and `replayed: true`, a draft that changed meanwhile answers 409 `order_changed`.
- *A double click can still spend a draft number.* Two simultaneous requests both pass the lookup; the loser takes a number, hits the unique index on `requestId`, re-reads and answers with the winner's order. The number it took stays unused (a gap in the draft counter).
- *The preview takes two more things than the plan's body.* `kind: 'customer'` (the customer dialog asks the same endpoint for its rows: quantity 1, no suppliers, no cost) and the answer carries `currency`. Both are additive.
- *The price default.* The supplier's last unit price is copied only when it is in the currency the order is made in (the organization's base currency); else the article's `purchasePrice`; a cost price of 0 is "not set". For a caller who may not read bills none of `suppliers`, `supplierId` and `expectedUnitPrice` is in the answer (the integration test asserts the JSON, not a column); the supplier a role picks by hand is its own choice.
- *"To order" and the dialog's quantity.* They are equal wherever the list shows a figure of 1 or more. Where the list shows a dash (an article above its minimum that someone ticked) the dialog tops up to the maximum, at least 1; a missing quantity under one unit is one unit there, the fraction on the list.
- *A tick column costs 48 px.* "All statuses" overflowed 1366 px by 11, which `product-actions.spec` pins. The Active column takes the price columns' 8 px gutters (it only exists in that view), and the spec finds the name in cell 2 now, the tick column being cell 0: the only existing spec edited. Every other Products spec passes unmodified.
- *The selection's model.* "All that match" is a frozen filter and a count. While the list shows that very filter, every row of every page is ticked; unticking a row ends it, as in a mail list, and the rest of the page stays ticked; under another filter its rows are not shown ticked and what the user ticks there is explicit, so the chip counts both. The chip's "outside this filter" is asked of the list's own endpoint with the ticked ids (chunks of 100). With a warehouse filter that endpoint lets `ids` override the warehouse restriction (FR-28.3), so an article the warehouse holds none of counts as shown: the chip never claims more than is true.
- *The buttons follow FR-28.15, not the forms.* The existing order forms do not gate their Create button (they rely on the server's 403), so the bulk buttons check `orders.create` through `useAccess`, the capability the routes ask for.
- *The dialogs.* Closing keeps the selection, creating clears it. The dialog makes `requestId` once per opening and reuses it for every attempt. "Add to an open draft" (a SHOULD) is built, with a warning when the draft already has an article: the server appends, never merges.

**Not done, and next.**

1. FR-28.20 (the same checks on the existing ORDO and ORDI POST and PUT): not attempted, it is a SHOULD. A PUT must not refuse an old order for an article deactivated since, so the "active" rule belongs to new lines only, and the existing suites have to be run against each rule before it ships.
2. Not covered by a spec: the "add to an open draft" path in the browser (the server's side is in `orders-from-products.flow`), and the over-500 state of the bulk bar (the unit test holds the cap; the preview's 422 is in the integration test).
3. The field test of §8.4 on production, in the demo organization.

- **Field test** (§8.4): on *Products*, a page ticked, *Select all 18 that match*, *Create supplier order*, the missing suppliers set, created: ONE draft supplier order with one group, 18 lines and one allocation each, nothing sent or reserved; pressing *Create* twice and two simultaneous requests with one `requestId` made ONE draft, and a later repeat answered with the same order; a customer order from two articles opened a draft for the chosen client and date. Everything the test made was deleted (checked through the API: none left).

### Slice 5: the supplier order as a tree

- **Built.** The node model and one set of figures as plain code (`invoicing-ui/src/composables/order-tree`: `types`, `figures`, `supplier-order-tree`, `tree-rows`, `columns`, `links`), the tree component (`components/order-tree/OrderTree.vue`: the table, what is open, the toggles, the arrows, reveal and mark, and the room it has), and the supplier order on it. Warehouses and clients are rows of one table with one set of columns, a parent carrying what its children add up to; `+ Warehouse` and `+ Client` are rows (Enter adds, Escape drops, the list opens with the cursor in it); a reservation is still staged and saved with the order, so the server and the save payload are untouched. Expand all and Collapse all are on each supplier's header; the Totals card reads the tree's figures; a link with `?line=<id>&allocation=<id>` opens the card, the line and the warehouse, scrolls to it and marks it (the Reservations list and the reservation page now link that way). The article cell is slice 3's (Details, the hit row, F4, "Add N articles"), carried into the tree: the dialog's N articles become N lines of the supplier it was opened from. After a pick the cursor goes to that line's quantity (FR-28.27, which slice 3 left for this form because this slice was rewriting its lines). The customer order and the reservation page draw the same model in slice 6.
- **S-1: `v-table` over the node model.** One fixture of 300 lines × 3 warehouses × 3 clients (3,900 rows), the same cells in both candidates (a number field, the figures, chips, buttons), each in its best realistic form (`v-memo`, events rather than a closure per row). Medians of five runs:

  | | `v-table` over the node model | `v-data-table` `group-by` |
  |---|---|---|
  | first draw, all 3,900 rows open | 5.2 to 5.9 s | 5.5 to 6.3 s |
  | toggle one line, 660 rows showing | 69 to 89 ms | 69 to 70 ms |
  | toggle one line, 3,900 rows open: the script | 7 to 13 ms | 22 ms |
  | the same, the browser's layout included | 316 to 341 ms | 388 to 415 ms |
  | one quantity edited, tree rebuilt and drawn (660 / 3,900 rows) | 144 / 797 ms | 117 / 676 ms |

  1. *Three levels, the parent's figures in the same columns:* both. 2. *Open by default, expand all, state across the reload:* the `v-table` does it natively. `group-by` keeps what is open in a private set that the table does not expose (its ref has no group method; the only handle is a pair of functions handed to a slot), so it starts closed and is opened group by group after the first draw. Worse, a line closed by default that later gets a reservation **stayed closed** (tested), and a row the user closed cannot be told from one never opened: the tri-state the tree needs would live outside it and be pushed in. The state did survive a reload (group ids). 3. *Empty parents:* both, but `group-by` needs a made-up item per empty line or warehouse for the group to exist. 4. *The lines' order:* both. 5. *Inline editors and staged markers:* both, and focus stayed in a field while the tree was rebuilt around it. 6. *Keyboard and `aria-expanded`:* both, with a toggle that is a button; the arrows are ours in both. 7. *Speed:* the script is a few milliseconds in either; the other 310 to 380 ms is the browser laying out 3,900 rows of inputs, the same for both and not helped by a fixed table layout. With 660 rows showing, both toggle in under 100 ms. The `v-table` passes all seven, `group-by` fails the second, so D-7 is the `v-table`.  **A real order, timed in the form** (40 lines, two warehouses each, 20 reservations, 80 rows showing by default; headless Chromium at 1920 px): the page up and the tree drawn in 0.8 s, toggling a line 75 to 97 ms, a keystroke in a quantity until it is painted 99 to 121 ms. The tree is rebuilt from the form on every keystroke and its rows are not memoized, so that is the figure to watch if an order ever has hundreds of lines (S-1's 3,900 synthetic rows are the ceiling: 0.8 s for an edit).
- **P7-tree** (reserve 4 units for a client on a new warehouse row of a line, saved): before the tree **11 clicks, 1 typed, 0 keys, 1 dialog**; on the tree **5 clicks, 2 typed, 2 keys, no dialog** (`+ Warehouse`, pick, type 4, Enter, `+ Client`, type the name, pick, Enter, Save). The client's name is typed because the open list shows only the first 20 contacts. P7-who stays at 1 click, P7-chain 18, P7-new 4, P7-repeat 3.  All 17 walks (19 tests) on this build, clicks · typed · dialogs: P0-new ×3 1·0·0, P1-act 2·0·0, P1 5·2·0, P2 17·12·1, P3 3·1·0, P4-open 5·1·1, P4-storno 3·0·1, P4-till 3·4·0 (4 keys), P5-credit 5·1·0, P5-invoice 14·6·0, P6 12·5·0, P7-chain 18·8·1, P7-new 4·3·1, P7-repeat 3·0·1, P7-who 1·0·0, P8 5·0·1: every one equal to what slice 3 measured, and inside its budget.
- **A narrow paper.** At 1366 px with the right panel open the tree had 934 px for a table that asked for 1,170, so it scrolled sideways inside its card and Status and the actions were off screen. The fix is the smallest that keeps FR-28.41 whole: the tree measures the room it has (a `ResizeObserver` on its own box) and leaves out a column that its screen marks `optional` while drawing it would make the table scroll. Dispatched is that column, and its figure is the tooltip of Invoiced on every row and on the totals row while it has no column of its own. It goes only when the room is under about 990 px: 1280 px with the panel folded, 1366 px folded and 1920 px with the panel open or folded show all eleven columns. The rest of the room came from the cells: 8 px of padding instead of Vuetify's 16 (176 px across eleven columns), the fixed columns retuned, and an article column that holds to 160 px where it asked for 300 (the article's field gives way, so its Details button no longer lands on the quantity). Measured in the browser at 1366 px with the panel open, in all four languages: no sideways scroll, Status and the actions inside the card; the spec keeps it that way (`order-tree`, "The room the tree has"), at 1341 px as well, which is 1366 px less the 25 px a classic scrollbar takes in a real Windows browser (headless Chromium hides its scrollbars, so the first measurement missed it: 11 px of sideways scroll). That is the narrowest case, and it is cramped: the article column is 169 px there, warehouse names are cut, and a reservation number can touch the quantity beside it. Headers longer than their column now wrap onto a second line; before, `Резервирано` printed over `Свободно`, `Получено` and `Фактурирано` in Bulgarian and Macedonian at every width, and `Reserved` and `Dispatched` overran their cells in English. Left as it is: in Bulgarian and Macedonian the longest headers break inside the word at 1366 px with the panel open (a soft hyphen in those strings would make it tidy), and a status chip wider than its 96 px is cut with its full text in the tooltip.
- **Free means two things, by the table of §2.6.** A line's Free is ordered minus allocated; a warehouse's is allocated minus reserved. So a line's Free is not the sum of its warehouses'. The header says so in a tooltip (and is underlined with dots to say it has one), in the four languages.
- **Where the plan was read, or was wrong.**
  - *`unallocated` informs, it does not open.* FR-28.42 says a flagged row opens, and its own wireframe draws a line with "50 unallocated" closed. A new line is always unallocated, so opening on it would open every line of a draft. Over-allocated, new, changed and cancelled-on-save open a row and roll up to its closed parents.
  - *A reservation the server has cancelled is not a row,* as in the grid it replaces. The flat Reservations card still lists it with „reserve again", so that action is not on the tree, and the card now starts closed (D-6).
  - *Dispatched is a column,* beside Invoiced: the table lists both, the wireframe only one. It is also the column that gives way on a narrow paper (above).
  - *The reserve dialog is gone for creating,* and stays for „change client".
  - *The Totals card's Reserved now counts staged changes.* Between staging a reservation and saving it, the number a user reads there moves with the warehouse rows instead of waiting for Save: one set of figures (FR-28.37).
  - *The new row will not over-allocate;* an existing allocation field still only warns, as before.
  - *No `useGridNavigation`:* the order form never used it (it is the document line grid's). The toggles take the arrows (up and down between rows, right opens or goes in, left closes or goes to the parent), and the inline rows take Enter and Escape.
  - *Cells are found by their column, not their place.* The first spec found a cell by its position; a column that can leave breaks that, so headers and cells carry `data-col` and the spec asks for `td[data-col="status"]`.
  - *The first widths were tuned in English only.* Measuring the page in each of the four languages found the header collisions above, and the widths were set from those measurements.
  - *Not done:* keeping what is open across sessions, and FR-28.48 (both MAY). The customer order's two links to a supplier order (`InternalOrderFormView.vue`) are slice 6's.
- **Caught on the way.** Enter and Escape on the inline row are listened to in the capture phase. By the time a bubbling listener runs, the field has closed its list and Vue has written that to `aria-expanded`, so the Enter that picked a warehouse also added the row with the quantity it started at, and the first Escape dropped the row instead of closing the list. The spec reproduces both (and fails with the listener put back).
- **Decisions taken for the owner.** (1) A line shown as `unallocated` informs and does not force its row open; over-allocated, new, changed and cancelled-on-save rows still open. (2) A reservation the server has cancelled is not a tree row; the flat Reservations card keeps it, with „reserve again". (3) The Totals card's Reserved counts staged changes. (4) Free is level-specific, by the table, with a header hint. (5) On a narrow paper Dispatched gives way to the tooltip of Invoiced, as above. (6) The customer order's two links to a supplier order stay for slice 6.
- **Tests.** `supplier-order-tree` unit (48: 42 for the model, 6 for the columns that fit), `order-tree` spec (26: the model on screen, the keyboard, the links, the room the tree has at four widths and in two languages, the cursor after a pick, "Add N articles" on a second supplier) and the P7-tree walk. Each new behaviour was mutated and its test fails without it (the optional column, the focus call, the guard that keeps the cursor where the user put it). Updated, and nothing else: `order-forms` (the line's toggle replaces the Allocations button), `orders-reservations` (a `+ Client` row replaces the Client reservations button and the dialog), `p7-who-reserved` (the rows of a line by `data-root-id`), and slice 1's `collapsible-panels` (the Reservations card is closed by default). On the final tree, `--workers=1` on a database seeded just before each batch: the whole unit directory 2,569 pass and 1 fails (`rendering serves nothing (FR-20.25, AC 10)`, the one failure expected on Windows); ten end-to-end spec files, 115 pass and none fails (`order-tree` 26, `order-forms` 11, `orders-reservations` 3, `orders-product-autocomplete` 2, `reservations-page` 5, `collapsible-panels` 5, `document-header-layout` 18, `product-search` 32, `product-actions` 10, `products-price-columns` 3); the 19 walks. `order-forms` line 102 ("an edit after a save is unsaved again") flaked once for the previous run and failed 1 in 15 repeats here. It is the customer order's: its save shows the toast, then reloads the order and takes its clean baseline, and the spec types in that gap. This slice does not touch that form, so the spec is left as it is for slice 6; waiting for the Save button to stop loading before the edit made it pass 40 of 40 in a scratch copy. Not run: `bun run test`, CI, any browser but Chromium, a screen reader.

- **Field test** (§8.5, the supplier-order half): 28 of 29 (the 29th was a check of mine that expected a visible "new" tag on a staged *warehouse* row: only staged reservation rows carry it). Levels, *Expand all* and *Collapse all*, the arrow keys, the totals row against the Totals card and the folded summary, **+ Warehouse** and **+ Client** as inline rows, staged rows counting at once, cancelling, `?line=&allocation=`, no sideways scroll at 1366 and 1920 px; reservations only staged, never saved. It also found that a quantity of three digits or more was clipped in the Qty field (100 read "10"): fixed by #632 and re-measured on production (7, 70, 100, 1000 and 12500 all fit).
  - The lesson for the next tree: a geometry spec must check that every VALUE fits its field (`scrollWidth <= clientWidth`), not only that the table does not scroll sideways.

### Slice 6: the customer order and the reservation page on the tree

- **Status: both halves are built.** 6a, the customer order (FR-28.44, the customer-order half of .46, and .47); 6b, the reservation page, the server read and the links generated from the reservation list and page (written up below, after 6a's).** 6a is on its own branch and is not merged or deployed when this is written. What is below is 6a's.
- **Built (6a).** The node models are plain code (`composables/order-tree/customer-order-tree.ts` and `supply-tree.ts`, the second for 6b). The customer order's lines are the supplier order's tree component (`views/InternalOrderFormView.vue` over `components/order-tree/OrderTree.vue`): a line, and under it the reservations that cover it, in the same columns (Article / Reservation, Qty, Unit, Price, Reserved, Short, Invoiced, Delivered, Status, the actions) with a Totals row. A line says how far it is covered in the chip it has always had, word for word ("Reserved Qty: 4/4", "Ordered: 4/4"). A reservation says its status and, when its supplier order arrives after the day asked for, "Late". A closed line keeps both its figures and what is wrong below it. `+ Reserve` (`ReserveMenu.vue`) is on every saved line that has an article, and on the "Nothing reserved yet" row under a line with none. "From stock" and "From a supplier order" open the cover dialog for THAT line and that source (it is the toolbox's "Cover shortages" with its other sections left out), and "Generate supplier order" opens the generate dialog with that line's row. Reservations are still made, changed and released at once, each with its own dialog: nothing on this tree is staged. The flat Reservations card starts closed (D-6) and keeps its header buttons. Its supplier-order chip, and the one on the tree's reservation rows, are deep links (`?line=<line>&allocation=<warehouse>`). A link with `?line=<line>` opens the lines card and the line, scrolls to it and marks it for a moment; an id that matches nothing opens the form as usual. The Totals card and the folded card's summary read the tree's figures: one set (FR-28.37). Twelve strings under `invoicing.tree.*` in the four languages.
- **Walks, before and after** (clicks · typed · dialogs, `--workers=1`, a database seeded just before; before is slice 5's head, after is this branch on master with #632): P7-chain 18·8·1 → 18·8·1 (budget ≤ 18), P7-new 4·3·1 → 4·3·1 (≤ 4), P7-repeat 3·0·1 → 3·0·1 (≤ 3), P7-who 1·0·0 → 1·0·0 (≤ 1), P7-tree 5·2·0 with 2 keys → the same. Nothing moved, so no budget needed a fix. The whole `ux-budgets` directory (20 walks in 18 files) passes; the other fifteen were not measured before the slice, because none of them works on the lines of a customer order.
- **Quantity and price are read whole.** Slice 5 shipped number fields that clipped three digits (a column of 64 px, 8 px of cell padding on each side, 15 px kept for the spin buttons: "100" read "10"). A separate fix (#632, merged before this slice) removed the spin buttons and the field's own padding in `OrderTree.vue`, so a field is its column less 8 px. This slice sizes its own columns on top of that: Qty 68 px and Price 84 px (a digit is 9 px), Status 142 px (the longest coverage chip, in German, is 125 px) and the actions 152 px (`+ Reserve` and the remove button side by side, in the longest of the four languages: 104 + 32 px). Measured in the browser in all four languages at 1341 px (1366 less a classic scrollbar), 1366 px with the right panel open and folded, and 1920 px with it open and folded: no sideways scroll, no number field cut short, and Delivered is a column wherever there is room (from about 980 px of table: 160 for the article, 728 for the rest and 90 for Delivered). The spec reads every number field of the tree with a line of 12,500 at 9,999.99 and one of 99,999 at 1,234.5 (`scrollWidth <= clientWidth + 1`) at four of those five widths. Mutation check: with the columns at the supplier order's 64 and 76 px and the CSS as it was before #632, all four cases fail ("Qty = 12500 is cut short in a field 48px wide"); with the fix and 64 and 76 px they pass, so the widths above are a margin and not the minimum (the fix's own figure is 56 and 68 px of field).
- **Where the plan was read, or was wrong.**
  - *Reserved is added up from the rows;* the server's `reservedQuantity` is the same sum. Invoiced and Delivered stay the server's per-line figures, because an invoice can name a line without naming any of its reservations. The header chip of the whole order still reads the server's figures (they agree).
  - *A reservation the server cancelled is a row here,* as it was in the sub-row this replaces: it says "Cancelled", holds nothing, and offers "Reserve again". On the supplier order it is not (slice 5).
  - *`late` is only said of an ACTIVE reservation:* a fulfilled or cancelled one is history. The clock icon of the old sub-row and of the flat card showed on any row; both now use the one rule (`isLateReservation`), and the indicator is a "Late" chip in Status instead of an icon in the article cell, which a screen reader reads.
  - *A new flag, `overReserved`,* for a quantity edited down below what is held (a save would be refused): the line opens and says so.
  - *Free is "Short" here:* needed minus reserved, with a header hint. The plan's table said "Free (what is short)"; the supplier order's Free is ordered minus allocated, so the one word would have meant two things on the same component.
  - *"Delivered", not "Dispatched",* is the column on the customer order, and the old "Delivered Qty" chip is gone: its figure is the column, or the tooltip of Invoiced while the column gives way.
  - *`+ Reserve` is disabled while nothing is short,* and the scoped dialog does not offer to take a lower-priority order's reservation (the toolbox's does).
  - *A line with nothing reserved is closed,* so its placeholder row is not in view; `+ Reserve` is on the line itself for that reason, and again on the placeholder.
  - *A blank or unsaved line shows no figures* (no 0, 0, 0 under a line nothing can be reserved for).
  - *`lineFigures` and `reservations` stay out of `form`.* The pending-changes snapshot is the form, and a reservation action changes the server's figures without the user editing anything: inside the form they made an untouched order read as having unsaved changes (the P7-chain flake).
- **Not done.** FR-28.48 (a MAY). At 1341 px with the right panel open the article's chip, with its remove button, is 18 px wider than its 181 px column and lands in the padding of the quantity beside it (the supplier order has the same; the article cell is slice 3's). The reservation page, `detail.supply`, the reservations list and the supplier tree's links to the customer order are 6b's. The generate dialog still goes to the new supplier order when it succeeds, and not to its line. Not run: CI, any browser but Chromium, a screen reader. The screenshots were looked at in headless Chromium, which hides scrollbars.
- **Tests (6a).** Unit: `customer-order-tree` 23 and `supply-tree` 15 (new), `supplier-order-tree` 48 (slice 5's, unchanged); the whole `src/unit` directory: 2,632 pass, 1 fails, the one that is expected on Windows ("rendering serves nothing (FR-20.25, AC 10)"). E2E: `customer-order-tree.spec.ts` 13 (a line folds and opens and still says what it holds, `+ Reserve` from stock with its release, from a supplier order, a quantity edited below what is held, the placeholder row and Generate for that line only, the ORDO link, the cards' state across a reload with Reservations closed, `?line=`, the keyboard, and the number fields read whole at four widths); `collapsible-panels` (5) now asserts that the flat Reservations card starts closed (D-6) and opens and closes, and `order-forms` (11) waits for the Save button to stop loading before it edits (without that wait it failed 1 run in 15). With `order-tree` (28), those four are 57 of 57 on master with #632; the batch of nine specs (those four, `orders-reservations`, `reservations-page`, `document-header-layout`, `orders-product-autocomplete`, `product-search`) was 114 of 114 on slice 4's merge with #632's CSS applied. All `--workers=1`.

- **Field test, 6a** (§8.5, production, demo organization): 16 of 16. A draft customer order of two lines (one of 12,500 pieces) made through slice 4's endpoint: the lines drawn as a tree with the blank row to add one, the coverage chip in today's words ("Reserved Qty: 0/12500"), every numeric field showing its whole value at 1366 and 1920 px, Expand all and Collapse all, the totals row, `?line=` showing and scrolling to a line, an unknown id opening the form as usual, no page errors. No reservation was made on production (a reservation cannot be removed again: deleting an order only cancels it), so what reserving does is covered by the specs; the draft order was deleted (none left). My first run counted two line rows where the page has three (the blank row to add an article): the script was wrong, not the page.

### Slice 6b: the reservation page on panels, with a supply tree (the customer order is 6a)

- **Built.** The reservation page (`ReservationDetailView.vue`) is five `CollapsiblePanel`s on the screen `reservations.detail`: the client, article and quantity; where the goods come from; the customer order; the invoices; the history and links. A folded panel says what it holds in one line, and a flag that needs attention stays on its header (Late; Allocation gone). The second panel draws the supply the reservation hangs on as the supplier order's own tree (`OrderTree`, slice 5's component, read-only here): for an order reservation, the line, every warehouse it was given and every live reservation on them; for a stock reservation, the warehouse (on the shelf, reserved, free) and the active stock reservations on it. This reservation is the shaded row, marked "This reservation", and its number is plain text; every other row names its client and links its own number to its own page, which then reads the same supply with that row shaded. The tree is built by `composables/order-tree/supply-tree.ts` (slice 6's shared builders) from one new field of an existing read.
- **The server read.** `GET /invoicing/reservations/:id` answers `detail.supply` (`reservationSupply`, called from `reservationDetail` in `reservation.controller.ts`). For an order reservation: the order's line (description, quantity, received), ALL the line's allocations with their warehouse names, and the reservations found by `{ orgId, orderId, allocationId in the line's allocations, status not cancelled }`, so every row has a home in the tree and another line of the same order never appears. For a stock reservation: the warehouse (name, on hand, and the stock level's `availableQuantity`) and `{ orgId, source: 'stock', productId, warehouseId, status: 'active' }`. This reservation is always a row, whatever its state; at most 200 others, oldest first, read with `limit(201)` to know whether it was cut, and `total` is counted (one extra `countDocuments`) only when it was. `supply` is `null` when the allocation or the order is gone, or when a stock reservation names no article or warehouse. **No new route and no new rule.** `invoicing/reservations` is `any('orders.view')` for the list and the detail alike (`config/access/routes.ts`), and the supply shows only what the list (every client, number and quantity) and `GET /orders/:id` (the line and its warehouses) already give to the same permission; no `RECORD_SCOPE_CONFIG` entry covers reservations. Every query carries `orgId` (reservations, warehouses, stock levels, contacts, customer orders), and the isolation test fails when `orgId` is taken out of the supply's filters and of the contact lookup (checked, then restored).
- **Links to a line (FR-28.46, the generating half).** The reservation page's supplier-order link already named the line and the warehouse (slice 5); its customer-order link now carries `?line=<internalOrderLineId>`, and so does the customer order's number in the Reservations list and in a supplier order's tree (the supplier tree's rows copy `internalOrderLineId` now: slice 5 left it out). The handler that opens a customer order's line is slice 6a's; this slice only generates the link.
- **Where the plan was read, or was wrong.**
  - *The other rows link their number, not their client or their customer order.* FR-28.45 says the others "show the client and the quantity, and link to their pages". The reservation's number is the link. The client's name and the customer order's number are plain text, because the page keeps meeting specs that look for exactly one link by the client's name (walk P7-new) and by the ORDO and the ORDI number (`reservations-page`): Playwright matches names by substring and refuses two. A second link would have meant changing those specs, and FR-28.49 allows changing only one that pins a control this slice removes. None does. This page's own number is plain text too.
  - *The supply tree is inside the Source panel,* not a sixth panel, and the panels stack at full width: half a row is too narrow for the table, and the five old cards (two columns) are gone.
  - *A stock warehouse has no allocation, so its Free is the server's `availableQuantity`.* The plan's table gives a warehouse "allocated minus reserved". On a shelf the figure also counts goods held for a supplier order and already received there, so Reserved and Free need not add up to what is on the shelf; the header says so in a tooltip, in four languages. A negative figure is shown as 0.
  - *This reservation is a row whatever its state.* The supplier order's tree leaves cancelled reservations out (slice 5); the page about a cancelled one still shows where it was and strikes it through.
  - *Panel flags are short* ("Late", "Allocation gone"); the long sentence stays in the panel's body, so it is not said twice on an open panel. The old captions inside the cards ("Source", "Invoices") are gone: the panel's title says it.
  - *Slice 5 defect found: `column-gap-3` is not a Vuetify class* (`ga-3`, `gr-3` and `gc-3` are; `ga-x-8` is not either). The supplier tree's reservation row ran the client's name, the reservation's number and the customer order's number together. No spec could see it (a spec reads text, not gaps); a screenshot did. It is `gc-3` there now and here.
  - *Slice 5 defect found: the numbers in that row were bare `router-link`s,* drawn in the browser's blue with an underline, unlike every other link of the app. Both trees use `EntityLink` now (primary, no underline); same role and name, so no locator changed.
- **Not done.** Expand all and Collapse all on the supply tree (a handful of rows, open by default); a Late mark per row of the supply tree (the builder is given no requested delivery date per row; the page's own Late flag covers this reservation); keeping what is open in the supply tree across sessions (MAY). The customer order's side of the round trip (`internal-orders/:id/edit?line=`) is 6a's: this slice's specs check the link, not what it opens. The numeric headers of the shared tree break inside a word in Bulgarian at any width (fixed column widths, and headless Chromium has no hyphenation dictionary): that is slice 5's table and is not touched.
- **Decisions taken for the owner.** (1) The other rows' customer-order number is plain text, not a link. (2) No Expand all / Collapse all on the supply tree. (3) The supply is part of the existing read, not a route of its own. (4) At most 200 other reservations, with a line that says it was cut.
- **Tests.** `reservation-supply.flow` (10 integration tests, 75 expectations: the order supply with two warehouses, two clients and a customer order; the same supply from every reservation on it; other cancelled ones left out, a fulfilled one kept, this one kept whatever its state; another line of the order left out; null when the allocation or the order is gone; the stock supply and active-only; a stock level that is gone; the cap with this one outside it; not cut below the cap; another organization's rows never appear); `supply-tree` unit (15), `supplier-order-tree` unit (49, one new for `internalOrderLineId`); the new spec `reservation-supply` (5: the order supply, figures and strict-mode choices; another reservation opened from the tree; a stock supply with the cancelled cases; the links that name the line, from the list, the page and the supplier order's tree; the panels folded, summarised, flagged and kept across a reload). On the final build, `--workers=1`, on a database seeded just before each batch: the whole unit directory, before 6a came in, 2,633 pass and 1 fails (`rendering serves nothing (FR-20.25, AC 10)`, the one failure expected on Windows; 2,634 tests in 182 files), and on the merged head the six files that read the trees, the catalogues and the session keys again, 97 pass; the five access guards, expectations unchanged, green when the controller was written, and no server file has changed since (`route-permission` 11, `read-permission` 13, `tenant-isolation` 25, `access-differential` 7, `seller-roles` 29); seven end-to-end spec files on the merged head (this branch on master with 6a), 70 pass and none fails (`reservation-supply` 5, `reservations-page` 5, `orders-reservations` 3, `order-tree` 28, `order-forms` 11, `collapsible-panels` 5, `customer-order-tree` 13), and this branch modifies none of them. The spec was mutated: with the shaded row switched off its first three tests fail, with the customer order's `?line=` dropped the link test fails, and the panels test, which reads neither, passes.
- **Walks.** All 18 walk files (20 tests) on the merged head (this branch on master with 6a), `--workers=1`, on a database seeded just before the batch, with the same numbers on the head before 6a came in, clicks · typed · dialogs: P0-new ×3 1·0·0, P1-act 2·0·0, P1 5·2·0, P2 17·12·1, P3 3·1·0, P4-open 5·1·1, P4-storno 3·0·1, P4-till 3·4·0 (4 keys), P5-credit 5·1·0, P5-invoice 14·6·0, P6 12·5·0, P7-chain 18·8·1, P7-new 4·3·1, P7-repeat 3·0·1, P7-tree 5·2·0 (2 keys), P7-who 1·0·0, P8 5·0·1, P9 7·0·1. Every walk slice 5 listed is equal to what it measured, and each of the five this slice is held to is inside its budget (P7-chain ≤ 18, P7-repeat ≤ 3, P7-new ≤ 4, P7-who ≤ 1, P7-tree 5·2·0); P9 is slice 4's walk and is new to this list. P7-new lands on this page and still finds exactly one link named by the client.

- **Field test, 6b.** The demo organization has no reservation, and one made on production could not be removed again, so the check created no data: the route answers 404 for an id that is no reservation (the deployed route and read are alive), the list opens, and the page for such an id shows its empty state with no page error, at 1366 and 1920 px (6 of 6). The page WITH data (panels, supply tree, highlighted row, links) is covered by the 70 specs and the 20 walks of its PR.
