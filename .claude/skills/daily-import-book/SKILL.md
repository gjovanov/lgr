---
name: daily-import-book
description: Step 4 of the daily import - dry-run and book the day into LGR, one org and one family at a time, in order (receipts, transfers, write-offs, till, invoices), including the cases a plain run gets wrong - a line whose product is named differently in LGR (a corrected copy), a back-dated document, a document that is held, an invoice whose product a receipt of the day creates. Use after the prediction says 0 or every residual is named.
allowed-tools: Bash(bun:*)
---

# Book

The only step that writes documents, stock and prices into production. `D` is
`bun .claude/skills/daily-import/daily.ts`.

## 1. Read the dry runs

```bash
D dry --org regal-pz        # every family the day folder holds; full output in out/dry-<family>.txt
```

Resolve each `ACT` before booking that family. The ones a dry run raises:

- **"outgoing line(s) match no product"** (a receipt with negative lines). The importer matches by exact name, and
  LGR names the product differently. Booked as it is, the lines that do match go in under the document's marker,
  and the marker then stops the others from ever being booked. So the document goes in whole, from a
  **corrected copy**:

  ```bash
  bun .claude/skills/daily-import/doc.ts rename <day folder>/stokrazp_<n>.json <evidence>/out/corrected \
      "<name in the file>=<name of the LGR product>" ["<another>=<…>"]
  D dry --org <org> --dir <evidence>/out/corrected --only <n>      # every line must match now
  ```

  The LGR product is the one the comparison of step 3 shows beside the name. Take it only when the quantities agree
  with it (what the document removes is what LGR holds, or less).
- **"price-only line(s) name a product that does not exist"**: no receipt of this run creates it. Find the product
  under its LGR name, or leave the line and say so in the report: a price nobody applied.
- **"line(s) match no product"** on a transfer, a write-off or the till: the same name problem. The transfer and
  write-off importers take the corrected-copy route too; a till line needs the product to exist under the till's
  name, so it goes to the owner.
- **"a line with a quantity and no product"** on an invoice: when a receipt of the day creates that product, book
  the receipts first and the `ACT` is gone. Otherwise the invoice would stay a draft: link the product after the
  convert (section 3).

Notes to carry into the report: products a receipt creates, a sale price held as a typo on the PlusMinus item card,
partners that are no active supplier. Such a receipt is booked without a supplier and no later import changes it. When
the partner is a supplier that exists under another spelling (a short form, a missing legal form), the fix is one
name on that contact, under *Also known as*, which only a person may say; `scripts/backfill-receipt-suppliers.ts`
then names the receipts already booked. A partner that is one of the organization's own stores stays without one.

## 1b. The contacts family (first)

`D dry` lists the contacts the day's documents need before anything else (`out/dry-contacts.txt`): the customers of the
invoices and the suppliers of the receipts that bring stock in, found in LGR by the same ЕИК/VAT number, else the same
name or one of the contact's other names, else the same words with other punctuation. It plans, never forces:

- **create**: a contact nobody holds, with what PlusMinus knows (a `note`: read the names against the catalogue, an existing
  company under another spelling would be doubled). A supplier PlusMinus knows by name alone is created by name, with a
  note on the contact and the contacts that start with the same word listed beside it (`similar on file`): merge them by
  hand on the contact form (**Also known as**) when it is a short form of one of them.
- **update**: only what is EMPTY is filled (ЕИК, VAT, phone, address, МОЛ), the documents' name becomes one of the
  contact's other names when it differs, and a contact the documents use in the other role is widened to `both`.
- **`ACT`, nothing written for it**: `ambiguous` (several contacts fit and none exactly), `conflict` (a contact of that
  name holds a DIFFERENT ЕИК: another company, or a typo on one side), `inactive` (only a deactivated contact fits). A
  person decides, on the contact; the next dry run no longer raises it.
- **skipped**: the org's own stores, the КОРЕКЦИЯ placeholder, a partner the directory does not list, and a customer
  PlusMinus holds nothing about (the invoice import creates it by name when it must).

Book it before the receipts (`D book --org <org> --family contacts --execute`): the receipts then find their suppliers
and the invoices their customers by name. `--max-create` (default 80) refuses a run that would create more. The one-off
catch-up of a shop's whole `КЛИЕНТИ` ledger is `D book … --family contacts --all-clients --execute`, after reading its
dry run: a shop whose customers were never seeded has hundreds to create.

## 2. Book, in this order

One org, one family, one command at a time:

```bash
D book --org <org> --family contacts  --execute
D book --org <org> --family receipts  --execute
D book --org <org> --family transfers --execute
D book --org <org> --family writeoffs --execute
D book --org <org> --family till      --execute
D book --org <org> --family invoices  --execute
```

A family the day folder does not hold answers "no … file" and is skipped. `book` first repeats the dry run of
exactly its selection and writes only when that came back without `ACT` or `STOP`; then it checks what the importer
said after writing. The order is the point: the contacts exist before the receipts and invoices look them up by name,
a receipt creates the products an invoice sells, and the till day must exist before an invoice of a till sale can attach to it.

Receipts are booked in number order, because each one also restates its articles' prices and the later document
must win. That shapes the special cases:

- **Back-dated documents** (step 2) go first:
  `D book --org <org> --family receipts --dir <evidence>/<chunk>/api --only <numbers> --execute`.
- **A corrected copy** goes in its own place: `--only` the numbers before it from the day folder, then
  `--dir <evidence>/out/corrected --only <n>`, then `--only` the numbers after it. A later run over the whole day
  folder skips it by its marker.
- **A held document** stays out: `--only` every other number.

## 3. When a write did not land

- **`STOP` after a write**: the importer failed part-way. Read `out/run-<family>.txt` before anything else; what it
  confirmed is booked, and a rerun skips that by marker.
- **Invoices "NOT issued … stay drafts"**: link the product on the line the log names (`PUT /invoices/:id` with
  that line's `productId` and `warehouseId`), then issue with
  `POST /doc-import/convert {target:'sales_invoice', ids:[…]}`, which keeps the PlusMinus number. `/send` would
  take the next number of the sales series.
- **"N stock movements for M invoices that move stock"**: one invoice was issued without dispatching, or something
  else moved stock at the same moment. Step 5's comparison says which.

**Done when** every family of every org's day folder has been booked with a `book` that ended without `ACT` or
`STOP`, and each held document is written down.
