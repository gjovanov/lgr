---
name: adjust-stock
description: Book stock WRITE-OFFS from a PlusMinus sklisk_*.pdf (ИСКАНЕ За отпускане на материали) — materials issued internally (consumed / damaged / lost). Each искане becomes ONE completed adjustment movement that REDUCES the warehouse quantity by each line's Кол. Use for daily materials-issue / write-off documents.
allowed-tools: Bash(bun:*), Read
---

# Adjust stock — write-offs (materials issued / consumed / damaged / lost)

> **UI equivalent:** *Inventory → Stock Movements → Import* a `sklisk_*.pdf` directly. Same
> `stock_note` OCR profile, same result: `type:'adjustment'`, `fromWarehouseId` set, and
> `sklisk:<number>` in the notes.


Backed by `scripts/adjust-stock.ts`. A PlusMinus `sklisk_*.pdf` is an
**"ИСКАНЕ За отпускане на материали"** — an internal materials-issue request:
consumables and materials taken out of СКЛАД-1 (the LGR-tracked Pazardzhik
warehouse) for internal use, damage, or loss. LGR books each as ONE movement OUT
that **reduces the warehouse quantity by the line's `Кол`** (there is no
destination — the stock is written off).

## Mechanics

`type:'adjustment'` movement with `fromWarehouseId` set and **no** `toWarehouseId`
→ `confirmMovement` reduces the source and adds nowhere. `adjustStock` leaves
avgCost untouched on any reduction (the weighted-average recompute only runs for a
positive quantity), so a write-off never disturbs cost; line `unitCost` is set to
the product's current avgCost for movement valuation. Negative resulting stock is
allowed (migration mode). Idempotent: notes carry `sklisk:<number>`.

Not to be confused with: `transfer-stock` (sklrazp — goods moved to another store,
`type:'transfer'`) or `receive-*` (stokrazp — goods received in). And note the
`2000 КОРЕКЦИЯ` stokrazp corrections (mixed +/- quantities) are a *different*
document — this skill only reduces by a positive `Кол`.

## Workflow (Claude reads the PDFs → JSON → script books)

The sklisk table text is column-ordered + splits multi-digit prices across lines,
so it can't be parsed deterministically — Claude (or a subagent per few PDFs)
reads each and transcribes it into an adjustments JSON (same read-to-JSON pattern
as transfer-stock / receive-new-products):

```json
{
  "adjustments": [
    { "number": "0000000130", "date": "2026-07-31",
      "reason": "изписване на материали", "total": 44.92,
      "lines": [ { "name": "ТИКСО - ПРОЗР.", "qty": 12, "value": 12.00 }, ... ] }
  ]
}
```

Transcribe `Име` EXACTLY (Cyrillic + Latin + digits + dashes; keep any leading
numeric code). `date` = the `Дата:` header; `total` = `Крайна сума`; `qty` = the
positive `Кол`; `value` = `Стойност`. Per doc the script cross-checks Σ`line.value`
against `total` (±0.5).

```bash
export LGR_USERNAME=rdodova LGR_PASSWORD=…   # or LGR_TOKEN
bun run scripts/adjust-stock.ts --items <adjustments.json>              # dry-run
bun run scripts/adjust-stock.ts --items <adjustments.json> --execute
```

Options: `--org <slug>` (default `regal-pz`) · `--api <url>` · `--warehouse
<code>` (default: org default = Pazardzhik) · `--max-date <YYYY-MM-DD>` ·
`--skip-unmatched`.

## Verify

- Per doc: `✓ SM-… confirmed | first "<product>" <before> → <after> OK` (after =
  before − Кол); movement-count delta at the end.
- `/inventory/movements` shows the `adjustment` movements (status completed, source
  = Pazardzhik, no destination).

## Gotchas

- **Positive `Кол` only** — a write-off reduces by `Кол`; the script rejects
  non-positive quantities. (If a future sklisk carries a return/negative line,
  handle it separately.)
- **Unmatched lines abort `--execute`** by default (a skipped write-off line leaves
  LGR stock too high). Seed the product first, or pass `--skip-unmatched`. Unmatched
  lines are now listed loudly (`✗ qty … "name"`) — read them before skipping.
- **Cyrillic↔Latin homoglyph fold** (same as `transfer-stock`): the matcher applies an
  unambiguous Cyrillic→Latin fold after exact/collapse fail (`↪ homoglyph-matched …`),
  so a wrong-alphabet spec letter (`DIN 7504 K` vs `К`) still matches. Still transcribe
  the letter the PDF actually shows — don't "correct" the alphabet.
- Runs as part of the daily cadence alongside sales / cash / receipts / transfers.
