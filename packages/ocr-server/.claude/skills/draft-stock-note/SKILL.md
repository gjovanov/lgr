---
name: draft-stock-note
description: Convert extracted (OCR'd) text of a Bulgarian СКЛАДОВА РАЗПИСКА (store-to-store transfer note) or ИСКАНЕ за отпускане на материали (internal materials issue / write-off) into a structured JSON object. Use when given the raw text of either note and asked to map it to a stock movement OUT.
---

# Draft stock note from OCR text

You are given the raw extracted text of one of two **Bulgarian internal stock documents**:

- **СКЛАДОВА РАЗПИСКА** (за приемане/предаване на МЦ) — goods handed from one store to
  another → `doc_kind: "transfer_note"`.
- **ИСКАНЕ За отпускане на материали** — materials issued internally (consumed, damaged,
  lost) → `doc_kind: "issue_note"`.

Return **only** a single JSON object (no prose, no code fences) with exactly this shape:

```json
{
  "doc_kind": "transfer_note"|"issue_note",
  "document_number": string|null,
  "issue_date": "YYYY-MM-DD"|null,
  "warehouse_from": string|null,
  "warehouse_to": string|null,
  "line_items": [
    { "description": string, "quantity": number|null, "unit": string|null, "unit_price": number|null, "total": number|null }
  ],
  "notes": string|null
}
```

## Rules

- Output **only** the JSON object. Use `null` for anything absent — never invent values.
- Keep all Cyrillic **verbatim** (do not transliterate or "correct" product names). The
  product name is the join key against our catalog.
- `document_number` = the **Номер** / **Документ №** value. Dates `DD.MM.YYYY` → `YYYY-MM-DD`.
- `warehouse_from` = the store the goods LEAVE (Предал / От склад / Склад). `warehouse_to` =
  the receiving store when the note names one (Приел / За склад / За обект); an ИСКАНЕ has
  no destination — leave it `null`. Copy the values as printed, including any `ОБЕКТИ:` prefix.
- **Line items**: the table is `No / Име / Мяр / Кол` and sometimes `Цена / Стойност`.
  `Кол` → `quantity` (always POSITIVE — the document type carries the direction, not the sign),
  `Мяр` → `unit`. Include `unit_price`/`total` only when the note prints them.
- `notes` = the **Основание** / reason line, when present.
- Skip summary rows (`Всичко`, `Общо`) and signature blocks (`Предал`, `Приел`, `Съставил`).
- The table text is column-ordered and OCR often splits a multi-digit value across lines:
  reassemble each item so the quantity belongs to the right name. Do not drop line items.

Return the JSON object and nothing else.
