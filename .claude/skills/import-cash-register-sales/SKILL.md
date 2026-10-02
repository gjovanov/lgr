---
name: import-cash-register-sales
description: Import a day's cash-register (каса) sales from the legacy PlusMinus salesAnalysis_*.xlsx export into an LGR org as ONE issued cash-sale document (CSR-...) with a line per sold product. Use when the user wants to import daily каса/cash-register sales, with or without dispatching stock. Runs against the deployed API.
allowed-tools: Bash(bun:*)
---

# Import daily cash-register sales (legacy PlusMinus → LGR)

> **UI equivalent:** *Invoicing → Cash Register Sales → Import* accepts the same
> `salesAnalysis_*.xlsx` (and a printed cash-sale PDF). It applies the identical
> `Общо` cross-check and the same `reference = salesAnalysis:<date>` idempotency key, so a
> day imported either way is recognised by the other.
>
> One difference: the UI never forces the `CSR` display prefix. Whatever the org configured
> at */invoicing/configuration/sequences* is what a cash sale gets.


Backed by `scripts/import-cash-register-sales.ts`. Creates **one cash-sale document
per day** (number `CSR-…` — the org's CASH_SALE display prefix, set automatically)
from the day folder's `salesAnalysis_*.xlsx` (АРТИКУЛИ report, ПЕРИОД: ДНЕС, EUR).

## Source format (fixed)

Sheet1: rows 1–8 title block (`Валута: Евро`, `Фирма: РЕГАЛ ООД`, ЕИК), **row 9
headers** `Артикул | Количество | Стойност | % Ст-ст | % Кол-во`, then item rows,
group rows (`СТОКИ`, `УСЛУГИ`, …) and a final `Общо` row. **Стойност is NET (EUR)**
— it equals the products' net selling prices; 20% VAT is added on top. The script
cross-checks Σitems against `Общо` and **aborts on mismatch** (protects against
tree sub-group rows double-counting).

### A second layout carries the same day

A „Складови операции" export filtered to **`Операция: Продажби`**
(`storeOperations_*.xlsx`, headers `Име | Мярка | Количество | Цена | Стойност`,
`Тип на док.: СР`) is the **same business document** — a day of till takings — in
a different shape. regal-sf exports its register this way; regal-pz used
`salesAnalysis`. The **Files app** reads either and books one cash sale:

- The routing is decided by the sheet's `Операция:` header, never by the
  filename, because `Доставки` in the very same layout is a *delivery* (stock IN).
- Both land on `reference = salesAnalysis:<date>` — the key names the **day**, not
  the file. So a day that arrives in both formats collides with itself instead of
  booking twice, and every cash sale already in the ledger keeps its guard.
- ⚠ This script (`salesAnalysis` only) still rejects the other layout. Upload a
  `Продажби` export in the Files app; `receive-stock` rejects it too, and says so.

## What one run does

1. Parse + cross-check the xlsx (skips `СТОКИ`/`УСЛУГИ`/`МАТЕРИАЛИ`/`Общо` rows).
2. **Dedup**: the document carries `reference = salesAnalysis:<date>` — if one
   exists for the day, the run is a no-op. One CSR per day, re-runs safe.
3. Ensure the CASH_SALE **display prefix is `CSR`** (org-global, set via the
   sequences API on first run).
4. **Exact-match** each item to a product by name (bg-lowercased); unmatched rows
   stay free-text lines (totals still correct). Unit comes from the matched
   product (canonical UOM codes).
5. `POST /invoices` `type=cash_sale` → issued immediately (status `paid`),
   `paymentMethod=cash`, currency EUR @ 1.95583, `issueDate` = the folder date,
   `preparedBy` = the importing user, `placeOfTransaction` (default гр.Пазарджик),
   notes `Дневни продажби каса — <date>`, tag `cash-register-import`.
6. **Stock**: dispatches by default (negatives allowed — migration). Pass
   `--no-stock` when the inventory baseline (availability snapshot) already
   reflects the day's sales.

## Usage

```bash
export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN

DAY=2026-07-23
FOLDER="//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/$DAY"

# baseline day(s): snapshot already includes the sales → no stock dispatch
bun run scripts/import-cash-register-sales.ts --folder "$FOLDER" --no-stock

# daily runs after the baseline: dispatch stock normally
bun run scripts/import-cash-register-sales.ts --folder "$FOLDER"
```

Options: `--date <YYYY-MM-DD>` (default: folder basename) · `--org <slug>`
(default `regal-pz`) · `--api <url>` · `--warehouse <code>` · `--place <text>`.

## Verify

- Output line: `✓ CSR-… | <date> | N lines | net X + VAT Y = Z EUR`, matched
  count, and the stock-movement delta (`+1` with stock, `skipped by design` without).
- UI: `/invoicing/cash-sales` — the CSR document, status paid, with the
  signature footer (Получател/Съставил) and Място на сделката.

## Gotchas

- Unmatched product names print as `✗ unmatched:` — they usually mean the
  availability seed predates the product; re-check after the next reseed, or
  leave as free-text (totals are still right).
- The Общо cross-check aborting means the export layout changed (new group
  rows) — inspect the xlsx before touching the parser.
- Running before the day's `storeAvailability` reseed with `--no-stock`, or
  after it with stock, double-counts nothing — but be consistent: the snapshot
  boundary decides which mode a given day needs.
