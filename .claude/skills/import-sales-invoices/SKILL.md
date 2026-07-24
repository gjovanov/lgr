---
name: import-sales-invoices
description: Import a day's sales invoices (invoicem_*.pdf exports from the legacy PlusMinus ERP) into an LGR org via the deployed OCR→AI-draft pipeline, then convert the drafts to issued INV- invoices that preserve the legacy invoice numbers and dispatch stock. Use when the user wants to import a daily folder of legacy sales-invoice PDFs (e.g. _docs/2026-07-21), re-run a partially imported day, or convert previously reviewed drafts.
allowed-tools: Bash(bun:*)
---

# Import daily sales invoices (legacy PlusMinus → LGR)

Backed by `scripts/import-sales-invoices.ts`. Drives the **deployed** batch-OCR
endpoints of the LGR API (`/bills/import/extract|draft|convert`) — no DB or cluster
access needed; runs from any machine that can reach the API and read the folder.

## Source folder

One folder per day (WSL path works from Windows via `//wsl.localhost/...`):

```
//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/<YYYY-MM-DD>/
  invoicem_<number>.pdf     ← sales invoices (imported)
  stokrazp_*.pdf, *.xlsx    ← other daily exports (ignored)
```

The `<number>` in the filename is the legacy invoice `Номер` (e.g. `3000100390`)
and is the ground truth the pipeline is checked against.

## What one run does

1. **Dedup** — fetches the org's invoices; PDFs whose number is already issued are
   skipped, numbers still in `draft` are picked up for conversion. → re-runnable
   daily and after partial failures.
2. **Extract** — uploads PDFs (chunks of 4) to `POST /bills/import/extract`
   (pdftotext native-text fast-path, Tesseract-bul fallback). Warns if the
   filename number or the org identity (ЕИК `112500982` / РЕГАЛ as ДОСТАВЧИК)
   is missing from the text.
3. **Draft** — `POST /bills/import/draft` background job (Claude via ocr-server);
   polls the invoice list by batch tag `ocr:<batchId>`. Each draft: direction
   auto-detected (org tax number as ДОСТАВЧИК → `outgoing`), counterparty
   (ПОЛУЧАТЕЛ, e.g. ЕЛКОНТРОЛ-КОРЕКТ ЕООД) matched to existing customers by
   ЕИК → VAT → name or auto-created, `reference` = legacy number, draft number
   `DRF-INV-*`. Line products are **exact-matched by name** (bg-lowercased
   `nameLower`, then `skuLower`) — never fuzzy; an unmatched line stays
   free-text instead of guessing a wrong product/price. Units normalize to the
   canonical UOM codes so the Unit dropdown resolves. Also parsed from the PDF
   text (deterministic, not AI): **paymentMethod** from `Плащане:` (По сметка →
   bank_transfer, В брой → cash, карта → card, чек → check), **terms** = the
   standard legal clauses (ЗДДС/ДОПК consent block + the "Съгласно чл.6, ал.1
   от ЗСч." no-stamp clause), **notes** = the amount-in-words line ("Словом :
   …", AI's version preferred), **preparedBy** = the "Съставил:" name and
   **placeOfTransaction** = "Място на сделката:" (both shown in the signature
   footer). Matched/created contacts are enriched: ЕИК lands in both `taxId`
   and `taxNumber` (the form's "Tax Number (EIK)" field) and the party address
   in structured `addresses[]` when missing.
4. **Summary + gate** — prints a per-invoice table (number, draft #, contact,
   lines, total). A draft is **eligible** only if: `reference` == filename
   number, `direction` == outgoing, and not flagged `needs-review`
   (`--include-uncertain` overrides). Without `--convert` the run **stops
   here** — that's the review/confirmation gate.
5. **Convert** (`--convert`) — `POST /bills/import/convert`: status → `sent`,
   `invoiceNumber` → **`INV-<legacy number>`** (e.g. `INV-3000100390`), the
   `SALES_DOC` sequence is bumped to ≥ the max imported number (future normal
   invoices continue after the legacy series), and a dispatch **stock movement**
   decreases the warehouse quantities (negative stock allowed — migration mode).
   Add **`--no-stock`** to convert WITHOUT dispatching — use when the inventory
   baseline (opening-stock / availability snapshot) already reflects these
   sales. Prints per-invoice results, the stock-movement count delta, and the
   `SALES_DOC` counter check.

## Usage

```bash
# credentials (org admin), e.g. from the seed-user skill
export LGR_USERNAME=rdodova LGR_PASSWORD=...   # or LGR_TOKEN=<jwt>

DAY=2026-07-21
FOLDER="//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/$DAY"

# 1) extract + draft + summary (no writes beyond drafts; the confirmation gate)
bun run scripts/import-sales-invoices.ts --folder "$FOLDER"

# 2) review the summary (or the drafts in the UI at /invoicing/bills/import),
#    then convert — re-run picks the drafts up, nothing is drafted twice
bun run scripts/import-sales-invoices.ts --folder "$FOLDER" --convert
```

Options: `--org <slug>` (default `regal-pz`) · `--api <url>` (default
`https://lgrai.app`) · `--warehouse <code>` (default: org default) ·
`--only <num,num>` (limit to specific invoice numbers) · `--include-uncertain`.

Daily cadence: run the same two commands with the next day's folder
(`_docs/2026-07-22`, …). Dedup makes overlapping or repeated runs safe.

## Verify after convert

- The summary's convert section: every eligible row `✓ <num> → INV-<num>`,
  `stock movements +N` (one dispatch per converted invoice), `SALES_DOC counter … OK`.
- Spot-check in the UI: `/invoicing/invoices` — invoices `INV-<num>` status
  **sent** with the right ПОЛУЧАТЕЛ; a product from one invoice at
  `/inventory/products` → Stock tab shows the dispatch and reduced quantity.

## Gotchas

- **Ineligible rows** (✗ in the summary) are left as drafts on purpose — fix them
  in the UI (`/invoicing/bills/import` review step, or edit the draft) and re-run
  with `--convert`, or delete the draft to retry OCR from scratch next run.
- A draft whose `reference` was misread by the AI will show
  `reference <n> not in folder` — never convert it blindly; the preserved number
  would be wrong. Edit the draft's reference in the UI first.
- `needs-review` = direction was uncertain (org identity not confidently found).
  Inspect the PDF; if it is genuinely our sales invoice, re-run with
  `--include-uncertain` (or fix the draft in the UI).
- The extract step stores each PDF + text on the server (File model,
  `module:'bill-ocr'`) — safe to re-run; orphaned files from abandoned runs are
  harmless.
- Incoming (purchase) invoices in the same folder would be auto-detected as
  `incoming` and drafted as DRF-BILL — they are **not** converted by this skill's
  eligibility gate (direction must be outgoing). Convert those from the UI.
- **Line prices are the PDF's verbatim** (each client's legacy price-group price,
  e.g. `Цена 4` → 0.0071) — the import never substitutes the product's selling
  price. If a form or the price resolver shows a different price than the stored
  line, check the client's price-group tag (`scripts/assign-price-group-tags.ts`
  derives + assigns them from imported invoices) — the import data is not the bug.
