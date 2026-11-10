# FR-28 — Buying from the product list: suppliers per product, one product search, calmer document headers, orders as a tree

| | |
|---|---|
| **Status** | Proposed 2026-11-10. The defaults in §9 stand unless the owner answers otherwise on the issue. Nothing built. |
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
