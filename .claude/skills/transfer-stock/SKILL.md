---
name: transfer-stock
description: Book internal warehouse transfers-OUT from PlusMinus sklrazp_*.pdf (СКЛАДОВА РАЗПИСКА за приемане/предаване на МЦ) — goods handed from СКЛАД-1 to another РЕГАЛ store LGR doesn't track. Each разписка becomes ONE completed movement that reduces the warehouse's stock (destination untracked, single-WH tenant). Use for daily store-to-store transfer notes, which are a major source of "LGR higher than PlusMinus" quantity drift.
allowed-tools: Bash(bun:*), Read
---

# Transfer stock OUT (store-to-store разписки → dispatch from the WH)

Backed by `scripts/transfer-stock.ts`. РЕГАЛ operates more than one store; goods move
from СКЛАД-1 (the LGR-tracked Pazardzhik warehouse) to other stores
(СКЛАД - УЛ.М.ВОЙВОДА 12, МАГАЗИН - РЕГАЛ - СОФИЯ, …) on `sklrazp_*.pdf` notes.
LGR tracks a single warehouse, so each transfer becomes a **movement OUT** that
reduces the warehouse quantity and adds nowhere ("into the unknown"). These
transfers are typically NOT captured by the daily invoicem/cash/receipt imports,
so they are the main reason LGR reads higher than the PlusMinus snapshot.

## Mechanics

`type:'transfer'` movement with `fromWarehouseId` set and **no** `toWarehouseId`
→ `confirmMovement` reduces the source, adds nowhere. `adjustStock` leaves avgCost
untouched on any reduction (the weighted-average recompute only runs for a positive
quantity), so transfers-out never disturb cost; line `unitCost` is set to the
product's current avgCost purely for movement valuation. Negative stock is allowed.
Idempotent: each movement's notes carry `sklrazp:<number>`.

## Workflow (Claude reads the PDFs → JSON → script books)

The sklrazp table text is column-ordered and splits multi-digit prices across
lines, so it can't be parsed deterministically. Claude (or subagents, one per few
PDFs, for large batches) reads each PDF and transcribes it into a transfers JSON —
the same read-to-JSON pattern as `receive-new-products`:

```json
{
  "transfers": [
    { "number": "0000012643", "date": "2026-07-24",
      "destination": "СКЛАД - УЛ.М.ВОЙВОДА 12", "total": 1027.91,
      "lines": [ { "name": "ВИНТ 6Х120", "qty": 1000, "value": 75.00 }, ... ] }
  ]
}
```

Transcribe `Име` EXACTLY (Cyrillic + Latin + digits + dashes/dots/slashes; many
start with a numeric product code). `date` = the `Дата:` header; `destination` =
`Партньор → Име`; `total` = `Крайна сума`. Per transfer, the script cross-checks
Σ`line.value` against `total` (±0.5) — a transcription guard.

```bash
export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN
bun run scripts/transfer-stock.ts --items <transfers.json>              # dry-run
bun run scripts/transfer-stock.ts --items <transfers.json> --execute
```

Options: `--org <slug>` (default `regal-pz`) · `--api <url>` · `--warehouse
<code>` (default: org default = Pazardzhik) · `--max-date <YYYY-MM-DD>` (only
transfers dated ≤ this — e.g. to book just the pre-snapshot backlog for a clean
reconciliation) · `--skip-unmatched`.

## Verify

- Per transfer: `✓ SM-… confirmed | first "<product>" <before> → <after> OK`.
- Movement-count delta at the end; `/inventory/movements` shows the `transfer`
  movements (status completed, source = Pazardzhik, no destination).
- After booking the pre-snapshot backlog, re-run `compare-products` against the
  matching `storeAvailability` — the "LGR higher" quantity drifts should shrink.

## Gotchas

- **Date discipline for reconciliation**: the transfers span several days. Only
  transfers dated ≤ a given `storeAvailability` snapshot are reflected in it — use
  `--max-date <snapshot day>` to book exactly the backlog that snapshot expects,
  so the compare is apples-to-apples. Transfers dated after the snapshot move LGR
  past it (correct, but they will read as new deltas against a stale snapshot).
- **Unmatched lines abort `--execute`** by default (a skipped transfer-out line
  leaves LGR stock too high — the exact drift this skill fixes). Seed the product
  first, or pass `--skip-unmatched` consciously.
- Runs AFTER the day's sales/cash/receipts. Do not confuse `sklrazp` (transfer,
  "предаване") with `stokrazp` (receipt, "получаване") — different documents.
- **Not handled here**: `2000 КОРЕКЦИЯ` stokrazp are stock *corrections* with
  mixed +/- quantities (not transfers) — they need an adjustment-movement path,
  still to be built.
