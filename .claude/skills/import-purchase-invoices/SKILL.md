---
name: import-purchase-invoices
description: Import a batch of supplier invoice PDFs against an Order (ORD-) into an LGR org via the deployed ORD-aware OCR→AI-draft pipeline, then convert the drafts to received BILL- purchase invoices that book the stock receipt per the order's warehouse allocations, activate client-reservation holds, and learn per-supplier product-name aliases (DIN vs ISO wording). Use when a supplier delivery for a previously created ORD- order arrives with its invoice PDFs, or to re-run/convert a partially imported delivery.
allowed-tools: Bash(bun:*)
---

# Import purchase invoices against an Order (ORD-)

> **UI equivalent:** *Invoicing → Bills → Import*, which offers the same ORDO- picker and
> therefore the same allocation splitting and alias learning. The script remains the better
> tool for a large delivery; the UI is better when a single supplier PDF needs correcting
> before it is converted.


Backed by `scripts/import-purchase-invoices.ts`. Drives the **deployed** ORD-aware
batch-OCR endpoints of the LGR API (`/bills/import/extract|draft|convert`) — no DB
or cluster access needed; runs from any machine that can reach the API and read the
PDF folder.

## Inputs

- a folder with the supplier's invoice PDFs (any filenames, `*.pdf`)
- the **ORD- number** the delivery belongs to (created beforehand at
  `/invoicing/orders`, status `sent`/`partially_received`/`received`)
- credentials: env `LGR_TOKEN`, or `LGR_USERNAME` + `LGR_PASSWORD`

## What one run does

1. **Resolve the order** — `GET /invoicing/orders?search=<ORD->` and check it is in
   a receivable status; print its suppliers and received/ordered totals.
2. **Extract** — uploads the PDFs (chunks of 4) to `POST /bills/import/extract`
   (pdftotext native fast-path, Tesseract fallback).
3. **Draft** — `POST /bills/import/draft` with `{ warehouseId, orderId, items }`;
   polls by batch tag `ocr:<batchId>`. Per document: direction auto-detected (org
   ЕИК as customer → `incoming`), the supplier contact matched by ЕИК → VAT → name,
   and the **order supplier group** picked by that contact. Per line the matching
   ladder is:
   1. **learned alias** (`SupplierProductAlias` — this supplier's wording seen before)
   2. **exact** catalog name/SKU
   3. **AI** against the order group's ordered products only (small candidate set —
      handles DIN↔ISO designations, German/English wording; unsure → stays free-text)

   Matched quantities are **split across the order line's warehouse allocations**
   (remaining capacity in listed order; overflow → the fallback warehouse), one bill
   line per warehouse with an `orderRef` back-reference. Drafts carry
   `tags: [ord:<ORD->]`; a supplier that is not in the order gets `ord-unmatched`.
4. **Summary gate** — per draft: direction `incoming`, linked to the requested
   order, has a supplier document number (`reference`) not already issued, not
   `needs-review` (override with `--include-uncertain`). Nothing converts without
   `--convert`.
5. **Convert** — `POST /bills/import/convert`: draft → `received` BILL, books the
   per-warehouse stock receipt, **learns aliases** from every confirmed line that
   still carries its original supplier wording (`sourceText`) — including lines the
   user fixed manually in the review UI — and re-syncs the order (receivedQuantity,
   `partially_received`/`received` status, reservation stock holds).
6. **Verify** — stock-movement count delta and the order's received/ordered totals
   + status before vs after.

## Commands

```bash
# 1) draft-only (review pass)
bun run scripts/import-purchase-invoices.ts --folder <dir> --order ORD-2026-00001

# 2) review: open unmatched lines in the UI (bills → edit draft), pick the right
#    product on free-text lines — those fixes are LEARNED as supplier aliases on convert

# 3) convert (book the receipt)
bun run scripts/import-purchase-invoices.ts --folder <dir> --order ORD-2026-00001 --convert
```

Options: `--org <slug>` (default regal-pz), `--api <url>` (default https://lgrai.app),
`--warehouse <code>` (fallback WH; order allocations decide placement),
`--no-stock`, `--include-uncertain`.

## Gotchas

- **Double-receipt guard (regal ops):** a delivery received here must NOT also be
  booked by the daily `receive-stock` (storeOperations *Доставки*) import. Either
  skip those rows/day there, or run this skill with `--no-stock` and let
  `receive-stock` book the quantities (then the order's receivedQuantity still
  updates, but stock arrives via the other movement).
- Partial deliveries are normal: the order goes `partially_received` and the next
  delivery's import continues filling the remaining allocation capacity.
- A PDF whose supplier is NOT a group in the order drafts unlinked
  (`ord-unmatched`) and is excluded from convert — check the order/PDF pairing.
- The AI matching rung is constrained to the ordered products and never guesses;
  a wrong learned alias can be corrected by fixing a future draft line (the upsert
  overwrites the mapping) or deleting the `SupplierProductAlias` row.
- Invoice list pagination is 0-based `page` + `size` — the script handles it.
