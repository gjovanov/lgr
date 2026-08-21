---
name: receive-stock
description: Import a day's goods receipts (Доставки) from the legacy PlusMinus storeOperations_*.xlsx export into an LGR org as ONE completed receipt StockMovement (quantities only — prices untouched). Use when the user wants to import daily deliveries/заприходяване into the warehouse. Runs against the deployed API.
allowed-tools: Bash(bun:*)
---

# Receive stock — daily goods receipts (legacy PlusMinus → LGR)

> **UI equivalent:** *Inventory → Stock Movements → Import* accepts the same
> `storeOperations_*.xlsx`, applies the same `Операция: Доставки` gate, header check,
> `Всичко` cross-check and period↔date guard, and writes the same
> `storeOperations:<date>` marker into the movement notes. It also applies the same
> avgCost-invariant `unitCost` rule.
>
> The UI goes one step further: unmatched rows can be created as products in the review step
> (see `receive-new-products`) instead of aborting the run.


Backed by `scripts/receive-stock.ts`. Creates **one receipt StockMovement per
day** (the API equivalent of `/inventory/movements/new` + confirm) from the day
folder's `storeOperations_*.xlsx` export.

## Source format (fixed — and shared with other reports!)

Sheet1: rows 1–8 title block (`Склад: <name|Всички складове>`,
`Период: DD.MM.YYYY - …`, **`Операция: <kind>`**, `Фирма: РЕГАЛ ООД`, ЕИК),
**row 9 headers** `Име | Мярка | Количество | Цена | Стойност`, item rows, final
`Всичко` row.

⚠ **The same filename can carry a different report** — the export's content
depends on the operation filter used in PlusMinus. The script imports **only
`Операция: Доставки`** and aborts on anything else (e.g. the
`_docs/2026-07-23/storeOperations_*.xlsx` sample is `Операция: Продажби`, a
sales report — correctly rejected). It also validates the row-9 headers and
cross-checks Σ item qty against the `Всичко` row, aborting on drift.

## What one run does

1. Parse + validate the xlsx (Операция gate, header check, Всичко cross-check,
   and period-start ↔ date consistency — a stale file in the wrong folder aborts
   unless `--date` is passed explicitly).
2. **Dedup**: the movement's notes carry `storeOperations:<date>` (movements
   have no reference field) — if a receipt with that marker exists, the run is a
   no-op. One receipt per day, re-runs safe.
3. **Warehouse**: `--warehouse <code>` override, else the file's `Склад:` value
   matched by name/code (full value and after-`:` leaf, e.g.
   `ОБЕКТИ:СКЛАД - 1` → `СКЛАД - 1`); `Всички складове`, blank, or no match →
   the org default (isDefault, else first) with a warning.
4. **Match** each row's "Име" to a product: exact bg-lowercased name, then
   whitespace-tolerant retries (collapsed-space comparison + longest-token
   search) — the catalog keeps the legacy exports' multi-space padding.
5. **Quantities only**: "Количество" becomes the received qty. Line
   `unitCost` is set to the product's **current StockLevel.avgCost**, so the
   confirm-time weighted-average recompute leaves `avgCost` unchanged
   (`unitCost: 0` would dilute it toward zero). No product or price field is
   touched anywhere.
6. **Dry-run by default** — prints a preview table (`stock current → new` per
   line) and stops. With `--execute`: `POST /warehouse/movement`
   (`type: receipt`, draft) → `POST /warehouse/movement/:id/confirm`
   (draft→completed — the only step that writes stock; upserts missing levels).
   Verifies status, movement-count delta, and a first-line qty/avgCost
   spot-check.

## Usage

```bash
export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN

DAY=2026-07-24
FOLDER="//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/$DAY"

# 1) dry-run: validation + match report + stock preview, no writes
bun run scripts/receive-stock.ts --folder "$FOLDER"

# 2) create + confirm the receipt movement
bun run scripts/receive-stock.ts --folder "$FOLDER" --execute
```

Options: `--date <YYYY-MM-DD>` (default: folder basename) · `--org <slug>`
(default `regal-pz`) · `--api <url>` · `--warehouse <code>` ·
`--skip-unmatched`.

Daily cadence (after the day's exports land): `import-sales-invoices` →
`import-cash-register-sales` → `receive-stock`, same folder.

## Verify

- Output: `✓ SM-… | <date> | N lines | Σqty … | <warehouse> | status completed`,
  `stock movements: … (+1)`, spot-check `OK`/`unchanged`.
- UI: `/inventory/movements` — the SM receipt, status completed; a received
  product at `/inventory/products` → Stock tab shows the increase.

## Gotchas

- **Unmatched rows abort `--execute`** by default (a silently skipped receipt
  line = permanent stock drift). Seed/fix the product first (deliveries can
  contain catalog-new products), or consciously pass `--skip-unmatched` to
  import the matched subset.
- **Baseline caveat**: a file whose receipts are already inside the last
  `storeAvailability` snapshot reseed must NOT be executed — double-count. The
  snapshot boundary decides (same rule as the sales imports' `--no-stock`).
  First live day was 2026-07-24 (snapshot taken 2026-07-23 23:07).
- Negative or zero current stock is fine — confirm allows negatives and upserts
  missing StockLevel rows (migration mode).
- **Future extension (not built)**: "With product update" semantics — use the
  file's `Цена` column via `POST /warehouse/movement/with-update` to also
  refresh purchase price/tiers. For now quantities only; do not add prices
  ad-hoc.
