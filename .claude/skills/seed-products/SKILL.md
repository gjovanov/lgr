---
name: seed-products
description: Import or update products + stock for an org from a "storeAvailability" Excel export (Bulgarian nomenclature). Use when the user wants to bulk-load a product catalogue with quantities and price columns into an LGR org, re-seed an org's inventory from a fresh export, or update just some columns (prices, stock) of existing products. Runs locally against the dev DB or against the production cluster Mongo.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(tmux:*), Bash(docker:*)
---

# Seed products from a storeAvailability Excel export

Backed by `scripts/seed-products.ts`. Bulk-loads (or updates) `Product` + `StockLevel`
documents for one org from the legacy `storeAvailability_*.xlsx` format.

## Excel format (fixed)

Sheet1, rows 1–4 title block, **headers on row 5**, data rows 6..N, final `Всичко`
total row skipped. The script validates the header row (tolerating known label
variants, e.g. `Дост. цена` = `Доставна цена`, `Прод. цена` = `Продажна цена`) and
aborts on real drift.

| Col | Header | Field |
|-----|--------|-------|
| 1 | Име | product name |
| 2 | Мярка | unit (normalized: trim, strip leading `/`, uppercase-bg; empty/`0` → `БР`) |
| 3 | Количество | stock quantity (negatives preserved by default) |
| 4 | Доставна цена | purchasePrice + stock avgCost + tier slot 1 `Доставна цена` |
| 5 | Продажна цена | sellingPrice |
| 6 | Цена на едро | tier slot 2 `Цена на едро` |
| 7–11 | Цена1..Цена5 | tier slots 3–7 `Цена 1..Цена 5` |
| 12–14 | Цена7..Цена9 | tier slots 8–10 `Цена 7..Цена 9` (no Цена6 → exactly 10 slots) |

Non-zero tiers other than the cost tier `Доставна цена` carry `tags: [<tier name>]`
(e.g. `Цена 4`) — a contact tagged with the same name resolves that tier's price
(`resolvePrice` step 4; this is how the legacy per-client price groups work in LGR).
Empty slots and `Доставна цена` stay filterless (display-only). Each non-zero tier is
pinned with `manualOverride: true` and `percent` computed from purchasePrice — matching
the product form's manual-edit behavior. Contacts get their group tag via
`scripts/assign-price-group-tags.ts` (derives each client's group from the imported
invoices; dry-run by default).

## Modes & options

```
bun run scripts/seed-products.ts --org <slug> --file <path.xlsx> [options]
```

- `--org <slug>` **(required)** — target org, must already exist (use the `seed-user` skill / register flow to create it).
- `--file <path.xlsx>` **(required)**.
- **`--clean` (DEFAULT)** — wipe the org's existing products + stock, then insert everything fresh. `--no-clean` switches to **update-in-place**: match existing products by name and update only the selected columns.
- **`--columns <csv>` (DEFAULT `all`)** — which fields to write/update, from `name,unit,quantity,purchase,selling,tiers`. Examples: `--columns purchase,selling,tiers` (reprice only), `--columns quantity` (restock only).
- `--warehouse <code>` — stock target (default: the org's `isDefault` warehouse).
- `--category <name>` — category for new products (default `Общи`, created if missing).
- `--sku-prefix <p>` — SKU prefix in clean mode (default: derived from org slug).
- `--clamp-negative` — clamp negative quantities to 0 (default: **preserve** negatives).
- `--execute` — perform writes. **Without it the script is a dry-run** (prints stats and the first sample rows' tiers, no DB connection).

⚠ **`--clean` wipes product `tags` and resets `category` to „Общи"** — after any clean
re-baseline of an org that uses the DIN fastener tagging (regal-pz), re-run
`scripts/seed-din-catalog.ts --org <slug> --execute` + `scripts/assign-din-tags.ts
--org <slug> --execute` (see the `assign-din-tags` skill). `--no-clean` is safe: it
matches by name and only `$set`s the selected columns.

Idempotency: clean mode fully rebuilds; update mode upserts stock and `$set`s only the
chosen product fields. **Duplicate-name rows are merged** (quantities summed to the
net; unit/prices/tiers from the largest-|qty| line) so the catalog never carries
duplicate product names — exact-name importers (sales invoices, cash register)
depend on this. **Units normalize to canonical UOM codes** (`pcs`, `kg`, `m`, …
via `services/biz/uom.utils.ts`) so the Unit dropdowns across the app resolve.

## Run locally (dev DB)

```bash
# 1. Ensure Mongo is up (single-node replica set on :27018)
docker compose up -d mongo

# 2. Dry-run — confirm row count, negatives, sample tiers
bun run scripts/seed-products.ts --org <slug> --file <path.xlsx>

# 3. Execute (directConnection avoids replica-set discovery over the mapped port)
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/seed-products.ts --org <slug> --file <path.xlsx> --execute
```

## Run against production (cluster Mongo)

The repeatable path is a host that has `kubectl` + the repo checkout + `bun` — the
local **`lgr` tmux session already SSH'd to `master-node`** (k8s control-plane), or
`ssh mars`. Drive it with `tmux send-keys -t lgr '<cmd>' C-m` + `tmux capture-pane -t lgr -p`.

```bash
cd ~/lgr && git pull --ff-only          # get the latest script + xlsx (commit them first)
[ -d node_modules ] || bun install       # checkout is build-only; install once

# port-forward the cluster Mongo (headless svc "mongodb")
kubectl -n lgr port-forward svc/mongodb 27017:27017 >/tmp/pf.log 2>&1 &

# credentials from the sealed secret (kept in shell vars, never echoed)
set +H
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"

bun run scripts/seed-products.ts --org <slug> --file <path.xlsx>            # dry-run
bun run scripts/seed-products.ts --org <slug> --file <path.xlsx> --execute  # go
kill %1                                                                     # stop port-forward
```

Gotchas when driving the tmux pane:
- The interactive shell has history expansion on — run `set +H` first, or a `!` in any
  argument/grep pattern (e.g. `Done!`) throws `event not found`.
- `send-keys` mangles literal Cyrillic (→ `???`). Keep Cyrillic in committed `.ts`/`.xlsx`
  files; if you must type it inline, use `\uXXXX` escapes.
- `bun -e` can't resolve bare `mongoose`/`mongodb` from the workspace — for ad-hoc checks
  write a tiny `scripts/_tmp.ts` importing from `../packages/db/...` and delete it after.

## Verify

After `--execute`, confirm counts and one product's tiers (mongosh locally, or a temp
`scripts/_verify.ts` importing the models against `MONGODB_URI`):
product count, stock-level count, a sample product's 10 tier names/prices, and that
negative stock persisted (`StockLevel.findOne().sort({quantity:1})`).
