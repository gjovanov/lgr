---
name: compare-products
description: Reconcile an LGR org's catalog + warehouse stock against a PlusMinus storeAvailability_*.xlsx snapshot and report QUANTITY and PRICE discrepancies (read-only). Use to verify that a day's imports (sales dispatch, cash, receipts) leave LGR in agreement with the PlusMinus end-of-day inventory, or to spot price drift and missing products.
allowed-tools: Bash(bun:*)
---

# Compare products — LGR vs PlusMinus storeAvailability snapshot

Backed by `scripts/compare-products.ts`. **Read-only** — no writes. Takes a
PlusMinus `storeAvailability_*.xlsx` ("Наличност в текущия обект") export, which
is the authoritative stock+price snapshot for one warehouse, and reports where
LGR disagrees.

## Source format (fixed)

Sheet1: rows 1–4 title block (`Наличност…`, `Склад:`, `Фирма: РЕГАЛ ООД`, ЕИК),
**row 5 headers** `Име | Мярка | Количество | Дост. цена | Прод. цена | Цена на
едро | Цена0 | Цена1 … Цена7`, data from row 6. The export lists in-stock
products for the warehouse (~16k rows; zero-stock/delisted items are omitted —
that is why "LGR products not in file" is large and expected).

## What it compares (per snapshot row, matched to LGR by exact + whitespace-tolerant name)

- **quantity** — file `Количество` vs LGR `StockLevel.quantity` in the warehouse
- **purchase** — file `Дост. цена` vs LGR `product.purchasePrice`
- **selling**  — file `Прод. цена` vs LGR `product.sellingPrice`
- **tiers**    — file `Цена на едро`, `Цена0`..`Цена7` vs LGR `priceTiers` slots
  `Цена на едро`, `Цена 0`..`Цена 7` finalPrice — matched by SLOT/index, not
  label (file `Цена0` ↔ LGR `Цена 0`).

Duplicate file names (correction/reservation splits) are summed to a net quantity
before comparing (prices from the largest-|qty| row), mirroring the
opening-stock/seed dedup so split lines don't read as phantom gaps.

## Output

Terminal summary + capped top-N detail per section (`--limit`), and a **full CSV
of every discrepancy** written next to the xlsx (or `--out <path>`), columns
`type,sku,name,field,file,lgr,diff` with `type ∈ {missing_in_lgr, qty_mismatch,
price_mismatch}`. Sort is by |diff| desc so the biggest gaps are first.

## Usage

```bash
export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN

FILE="//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/2026-07-28/storeAvailability_20260728_213346.xlsx"
bun run scripts/compare-products.ts --file "$FILE"
```

Options: `--org <slug>` (default `regal-pz`) · `--api <url>` · `--warehouse
<code|name>` (default: **Pazardzhik / pz**, else org default) · `--qty-tol <n>`
(default 0.001) · `--price-tol <n>` (default 0.005 EUR) · `--limit <n>` (default
40) · `--out <path>` · `--no-csv` · `--reverse-since <YYYY-MM-DD>` (date-correct a
stale snapshot — see below).

### Date-correcting a stale snapshot (`--reverse-since`)

When LGR has already booked operations dated after the snapshot (you imported a
later day, but only have the previous day's `storeAvailability`), a plain compare
reports every one of those later movements as a "diff". `--reverse-since <day>`
fetches all movements dated ≥ `<day>` and undoes their effect on the warehouse
(a movement that LEFT the warehouse is added back, one that ENTERED is subtracted)
so LGR reads as of the snapshot's day — an apples-to-apples comparison. Example:
snapshot is 07-28, LGR is booked through 07-29 → `--reverse-since 2026-07-29`
strips the 07-29 activity and shows only the true structural residual.

## Interpreting the report

- **MISSING from LGR** — snapshot has the product with stock but LGR's catalog
  has no name match → a product created in PlusMinus after the last reseed. Seed
  it (`receive-new-products` from its стокова разписка, or the next
  `storeAvailability` seed-products merge).
- **Quantity mismatches** — LGR ≠ snapshot in the warehouse. On a healthy day
  this should be small and reflect only movements PlusMinus recorded that the
  daily import doesn't cover (bulk corrections, non-invoicem dispatches). Run the
  compare AFTER the day's sales/cash/receipt imports — the snapshot is the
  end-of-day truth.
- **Price mismatches** — a product's stored price/tier drifted from PlusMinus
  (real price changes since the last reseed), or a tier the reseed left empty is
  now populated. Newly-created products (via `receive-new-products`) legitimately
  lack a `Цена на едро` until the next availability seed fills it.
- **LGR products not in file** — count only; these are zero-stock/delisted at the
  warehouse (the snapshot omits them). Not real discrepancies.
- **⚠ LGR duplicate-name products** — collapsed-name collisions in LGR; only the
  first is used for matching. Investigate as a data-hygiene item (the seed dedups
  by SKU, not name).

## Gotchas

- Pagination is on `_id` ascending on purpose: the reseed bulk-inserts rows with
  identical `createdAt` (the default sort), so paging over that non-unique key
  overlaps pages and silently drops records — which reads as thousands of false
  "LGR 0" quantities. If a future API change alters sort handling, verify a known
  high-stock SKU reports its real quantity, not 0.
- Tolerances: default qty 0.001 (exact for integer counts, room for kg), price
  0.005 EUR (ignores sub-half-cent rounding). Tighten/loosen per need.
- Warehouse defaults to Pazardzhik; pass `--warehouse` for a different store.
