---
name: draft-goods-receipt
description: Convert extracted (OCR'd) text of a Bulgarian СТОКОВА РАЗПИСКА (goods receipt / delivery note) into a structured JSON object. Use when given the raw text of a стокова разписка — including the "2000 КОРЕКЦИЯ" correction variant — and asked to map it to a receipt with its item quantities, supplier cost and sale-tier prices.
---

# Draft goods receipt from OCR text

You are given the raw extracted text of a **Bulgarian стокова разписка** (goods receipt).
Return **only** a single JSON object (no prose, no code fences) with exactly this shape:

```json
{
  "doc_kind": "goods_receipt"|"correction",
  "document_number": string|null,
  "issue_date": "YYYY-MM-DD"|null,
  "currency": "EUR"|"BGN"|string|null,
  "supplier": { "name": string|null, "company_id": string|null, "vat_id": string|null, "address": string|null },
  "customer": { "name": string|null, "company_id": string|null, "vat_id": string|null, "address": string|null },
  "warehouse_to": string|null,
  "correction": true|false,
  "line_items": [
    {
      "description": string,
      "quantity": number|null,
      "unit": string|null,
      "unit_price": number|null,
      "total": number|null,
      "prices": { "Цена": number, "Цена 1": number, "Цена 2": number }|null
    }
  ],
  "net_total": number|null,
  "notes": string|null
}
```

## Rules

- Output **only** the JSON object. Use `null` for anything absent — never invent values.
- Keep all Cyrillic **verbatim** (do not transliterate or "correct" product names). The
  product name is the join key against our catalog — a "corrected" name will not match.
- `document_number` = the **Номер** / **Документ №** value. Dates `DD.MM.YYYY` → `YYYY-MM-DD`.
- `supplier` = **ДОСТАВЧИК**; `customer` = **ПОЛУЧАТЕЛ**. `warehouse_to` = the receiving
  **Склад** as printed, including any `ОБЕКТИ:` prefix.
- **Line items**: the table is `No / Име / Мяр / Кол / Цена / Стойност`, often followed by
  sale-tier columns headed `Цена 1`, `Цена 2`, … `Цена 10`.
  - `Кол` → `quantity`, `Мяр` → `unit`, `Цена` → `unit_price` (the SUPPLIER COST),
    `Стойност` → `total`.
  - Put **every** price column into `prices`, keyed by its exact printed header:
    `{"Цена": 8.24, "Цена 1": 7.49, "Цена 2": 6.24}`. Omit columns that are blank or zero.
  - `unit_price` and `prices["Цена"]` are the same number — emit both.
- **Correction documents**: when the header says `Тип на документа: 2000 КОРЕКЦИЯ`, set
  `doc_kind: "correction"` and `correction: true`. Quantities in a correction **may be
  negative** — keep the sign exactly as printed. Otherwise `doc_kind: "goods_receipt"` and
  `correction: false`.
- Amounts: plain decimals, **no** currency symbols or thousands separators.
- Skip summary rows (`Всичко`, `Общо`, `Данъчна основа`, `ДДС`, `Словом`).
- OCR text may split a row across lines, and the price columns are column-ordered: reassemble
  each item so `quantity × unit_price ≈ total`. Do not drop line items.

Return the JSON object and nothing else.
