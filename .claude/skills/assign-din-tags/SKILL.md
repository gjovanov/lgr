---
name: assign-din-tags
description: Assign fastener facet tags (DIN/ISO/EN standard numbers + catalog cross-equivalents, dimensions like М8Х25/Ф90Х529/6Х70, coating/material/strength codes ZN/BL/HDG/A2/A4/МЕСИНГ/8.8) to an org's products derived from product NAMES, and recategorize catalog-matched DIN products into the 12 fastener categories. Use after seeding/importing products (receive-new-products leaves new products untagged in Общи), after a clean reseed (which wipes tags+categories), or to refresh tags for regal-pz. Runs locally against the dev DB or against the production cluster Mongo.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(tmux:*), Bash(docker:*)
---

# Assign DIN/ISO/dimension/coating tags to products

Two scripts, run in order (both dry-run by default, `--execute` to write, both idempotent):

1. **`scripts/seed-din-catalog.ts`** — upserts the global `din_catalog` reference
   collection (165 DIN rows ↔ ISO/EN equivalents in 12 Bulgarian categories, data in
   committed `scripts/data/din-catalog.json`, source: DOCX „DIN ↔ ISO/EN разширен
   каталог крепежни елементи"). With `--org <slug>` also get-or-creates the 12
   `ProductCategory` docs for the org (sortOrder = раздел 1..12). Never touches
   existing categories incl. „Общи".
2. **`scripts/assign-din-tags.ts`** — cursors the org's products and, from each NAME:
   - tags `DIN <base>` (junk-proof: "DIN 933 - K 8.8" → only `DIN 933`; whitelisted
     variants `DIN 7504-K/-M/-N/-O/-P/-R`, `DIN 125-A/-B`, `DIN 7380-1/-2`, `DIN 976-1`,
     Cyrillic lookalikes folded: "DIN 7504 Р" → `DIN 7504-P`)
   - cross-tags from din_catalog: `DIN 933` → `ISO 4017`; reverse `EN 14399-4` → `DIN 6914`
   - dimension tags, canonical uppercase-Cyrillic + dot decimals: `М8Х25`, `Ф90Х529`,
     `6Х70`, `М10Х1.25Х40` (Latin M8x30/х/X all fold; pipe fractions `1/2Х3/8`,
     `Ф20Х1/2` and slash-suffixed `10Х100/94` are skipped)
   - coating/material/strength tags: `ZN` (incl. ПОЦ.), `BL`, `HDG`, `YELLOW ZINC`,
     `A2`, `A4` (Cyrillic А2/А4 fold, А2-70 → A2), `МЕСИНГ`, `6.8/8.8/10.9/12.9`
   - **recategorizes** (default ON) products whose name carries a catalog DIN into the
     standard's category; FIRST catalog DIN wins („ШАЙБА DIN 5406 - за DIN 981" → шайби);
     only moves products currently in „Общи" or one of the 12 (manual categorization is
     never overridden unless `--force-category`); sets category+categoryId+categoryLower
     explicitly (bulkWrite bypasses loweredFieldsPlugin)
   - upserts `Tag { orgId, type:'product', value }` vocabulary so TagInput autocomplete
     and the products tag filter work
   - extraction logic lives in `packages/services/src/biz/fastener-tags.utils.ts`
     (unit-tested: `packages/tests/src/unit/fastener-tags.test.ts`)

```
bun run scripts/seed-din-catalog.ts [--org <slug>] [--execute]
bun run scripts/assign-din-tags.ts [--org <slug=regal-pz>] [--execute]
    [--no-recategorize] [--force-category] [--batch 500] [--samples 30]
```

Writes are additive (`$addToSet`) — re-runs converge to 0 updates; rule changes never
REMOVE stale tags (delete via portal tag admin, which `$pull`s from all products).
Expected regal-pz scale: ~10.8k of 16.3k products tagged (~2.7k distinct tags),
~7.4k recategorized, ~8.9k stay in „Общи".

## When to (re-)run

- **After `receive-new-products`** — newly created products land untagged in „Общи".
  Re-run `assign-din-tags` (cheap, only the new products produce writes).
- **After any `seed-products --clean` re-baseline** — that wipes tags AND resets
  category to „Общи": re-run BOTH `seed-din-catalog --org <slug>` and `assign-din-tags`.
  (`seed-products --no-clean` is safe — matches by name, only $sets unit/price fields.)
- After extending `scripts/data/din-catalog.json` (edit → seed → assign).

## Run locally (dev DB)

```bash
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/seed-din-catalog.ts --org regal-pz --execute
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/assign-din-tags.ts --org regal-pz            # review report
MONGODB_URI='...same...' bun run scripts/assign-din-tags.ts --org regal-pz --execute
```

## Run against production (cluster Mongo)

Same recipe as the seed-products skill (local `lgr` tmux session SSH'd to master-node;
`set +H` first; Cyrillic only via committed files, never `send-keys`):

```bash
cd ~/lgr && git pull --ff-only && [ -d node_modules ] || bun install
kubectl -n lgr port-forward svc/mongodb 27017:27017 >/tmp/pf.log 2>&1 &
set +H
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"
bun run scripts/seed-din-catalog.ts --org regal-pz --execute
bun run scripts/assign-din-tags.ts --org regal-pz              # dry-run: review counts,
                                                               # not-in-catalog list, samples
bun run scripts/assign-din-tags.ts --org regal-pz --execute
kill %1
```

## Verify

Dry-run report should show ~0 write errors and plausible per-category counts. After
execute: products filter by tag (`GET /warehouse/product?tags=DIN 933` or the UI
tag filter), TagInput suggests `DIN …`/`М8Х…`/`ZN`, category dropdown in Products
lists all 13, a „Стопорни пръстени…" listing shows the ЗЕГЕРКА items. Re-run dry-run
→ "needing tag updates: 0".

## Gotchas

- **Bun transpiles Cyrillic regex literals to `\uXXXX`** — fine in JS, but FATAL if such
  a regex is sent to MongoDB as `$regex` (PCRE2 rejects `\u`). Never query Mongo with
  Cyrillic regex literals from bun scripts; use equality on the exact tag value instead.
- Bulk-pricing Mode 1 selects products by these tags — after this run, selecting tag
  `8.8` or `ZN` there reprices thousands of products in one click. Intended, but real.
- `updatedAt` bumps on every touched product (Model.bulkWrite applies timestamps) —
  nothing in the import/compare skills keys on it.
