---
name: receive-new-products
description: Create catalog-NEW products from a delivery's стокова разписка (stokrazp_*.pdf) with proper cost/tier prices and book their goods receipt — the follow-up for rows the receive-stock skill reported as unmatched because the products didn't exist yet. Use when receive-stock printed ✗ unmatched rows for a day's Доставки.
allowed-tools: Bash(bun:*), Read
---

# Receive NEW products (catalog-new delivery items → products + receipt)

Backed by `scripts/receive-new-products.ts`. Complements the `receive-stock`
skill: that one refuses rows whose product has no catalog match (a silently
skipped receipt line = permanent stock drift). This skill creates those
products **with real prices from the стокова разписка PDF** and books the
missing quantities as ONE completed receipt movement.

## Workflow (Claude does the reading, the script does the writing)

1. **Collect the unmatched rows** from the day's `receive-stock` output
   (`✗ unmatched: "<name>" (qty N)`).
2. **Find the стокова разписка** that delivered them: the day folder's
   `stokrazp_*.pdf` files. Locate the one whose item lines contain the
   unmatched names (pdftotext grep or Read each PDF). It carries per item:
   `Кол`, **`Цена`** (supplier cost) and sale-tier columns **`Цена 1`…`Цена 5`**
   — pricing the storeOperations xlsx does not have.
3. **Write the items JSON** (in the session scratchpad — business data, never
   commit) with names copied EXACTLY from the разписка:

   ```json
   {
     "receipt": "3000016107",
     "date": "2026-07-27",
     "supplier": "PROJAHN-PRAZISIONSWERKZEUGE GMBH",
     "items": [
       { "name": "49160 СВРЕДЛО - Ф16 - с намалена опашка", "qty": 2, "unit": "pcs",
         "cost": 8.24, "tiers": { "Цена 1": 7.49, "Цена 2": 6.24 } }
     ]
   }
   ```

   Cross-check each `qty × cost` against the разписка's `Стойност` column
   before proceeding. Column mapping: `Цена` → `cost` (→ Доставна цена /
   purchasePrice / initial avgCost); `Цена N` → `tiers["Цена N"]`. `selling`
   is optional — default is `cost × 1.10` (the org's observed retail markup),
   flagged in the output; the next storeAvailability seed overwrites it with
   the authoritative value.
4. **Dry-run, review, execute**:

   ```bash
   export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN
   bun run scripts/receive-new-products.ts --items <items.json>            # dry-run
   bun run scripts/receive-new-products.ts --items <items.json> --execute
   ```

Options: `--org <slug>` (default `regal-pz`) · `--api <url>` ·
`--warehouse <code>` (default: org default) · `--category <name>` (default `Общи`).

## What the script does

- **Corrects BOTH quantity AND prices for existing AND new products** (2026-08-03).
  Existing products are NOT re-created but ARE **repriced** via a product PUT —
  `purchasePrice` = разписка cost, `sellingPrice` if the sheet has a Прод.цена
  column, and `priceTiers` MERGED (Доставна цена = cost + the provided Цена N
  overlaid onto the current tiers, so slots the разписка does not carry — e.g.
  Цена на едро / Цена 0/6/7 from a prior storeAvailability seed — are preserved,
  not wiped). Previously existing products were received quantity-only, so a
  supplier price change was silently dropped until the next re-baseline.
- **Prices refresh on EVERY run; quantity is booked ONCE.** The movement dedup
  (notes `stokrazp:<number>`) only gates the receipt MOVEMENT — re-running the
  skill on an already-received delivery re-applies prices (no re-receive, no new
  movement). This is how you back-fill prices for deliveries booked before the fix.
- **Creates products indistinguishable from seed-products output**: SKU
  continues the org's numeric sequence (max `<PREFIX>-NNNNN` + 1), category
  Общи, type goods, taxRate 20, and the 10 canonical priceTiers slots
  (Доставна цена, Цена на едро, Цена 0…Цена 7) with `manualOverride` and
  tier-name `tags` on non-zero sale tiers — so tag-based price resolution works
  and the **next storeAvailability seed (which matches by exact name) adopts
  them** instead of duplicating.
- **Books ONE receipt** (`POST /warehouse/movement` + `/confirm`) with
  `unitCost = cost` — these are new products, so this SETS their initial
  avgCost to the real supplier cost (deliberately unlike receive-stock's
  avgCost-invariant rule, which protects EXISTING products).
- **Idempotent**: movement notes carry `stokrazp:<receipt>` (or
  `new-products:<date>` without a receipt number) — if found, the QUANTITY is not
  re-received (product creation is ensure-exists, prices are re-applied).

## Verify

- Execute output: per-product `created <SKU>`, then `✓ SM-… | status completed`,
  movements `+1`, and a per-line stock check `qty=<received> avgCost=<cost>`.
- UI: `/inventory/products` → the new SKUs, Pricing tab shows Доставна цена +
  the Цена N tiers; Stock tab shows the receipt.

## Gotchas

- **Only rows receive-stock reported `✗ unmatched`** belong in the items JSON —
  anything else double-books (receive-stock already received the matched rows).
- Run AFTER `receive-stock` for the day, and never for deliveries booked via
  ORD-linked purchase bills (`import-purchase-invoices`) — same double-receipt
  rule as receive-stock.
- The разписка lists ALL items of the delivery — pick ONLY the unmatched ones.
- Unit: разписка `Мяр` is Bulgarian (`БР`→`pcs`, `М`→`m`, `КГ`→`kg`); the
  script normalizes common codes, default `pcs`.
- First tested live 2026-07-28 on разписка 3000016107 (PROJAHN): 5 products
  REGALPZ-23105…23109 + SM-2026-00033 (Σqty 26, Σcost 242.24), re-run no-op.
- New products land untagged in „Общи" — follow up with the `assign-din-tags`
  skill (`bun run scripts/assign-din-tags.ts --org <slug> --execute`, idempotent)
  to give them DIN/ISO/dimension/coating tags + their fastener category.
