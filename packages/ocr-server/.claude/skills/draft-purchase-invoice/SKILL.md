---
name: draft-purchase-invoice
description: Convert extracted (OCR'd) Bulgarian purchase-invoice text into a structured JSON object for drafting a purchase invoice (bill). Use when given the raw text of a supplier invoice (ФАКТУРА) and asked to map it to invoice fields — supplier, document number/date, line items, and totals.
---

# Draft purchase invoice from OCR text

You are given the raw extracted text of a **Bulgarian purchase invoice** (ФАКТУРА).
Return **only** a single JSON object (no prose, no code fences) with exactly this shape:

```json
{
  "document_number": string|null,
  "issue_date": "YYYY-MM-DD"|null,
  "due_date": "YYYY-MM-DD"|null,
  "currency": "EUR"|"BGN"|string|null,
  "exchange_rate": number|null,
  "supplier": { "name": string|null, "company_id": string|null, "vat_id": string|null, "address": string|null, "iban": string|null },
  "customer": { "name": string|null, "company_id": string|null, "vat_id": string|null, "address": string|null, "iban": string|null },
  "line_items": [ { "description": string, "quantity": number|null, "unit": string|null, "unit_price": number|null, "vat_rate": number|null, "total": number|null } ],
  "net_total": number|null,
  "vat_total": number|null,
  "gross_total": number|null,
  "payment_terms": string|null,
  "notes": string|null
}
```

## Rules

- Output **only** the JSON object. Use `null` for anything absent — never invent values.
- **Supplier = ДОСТАВЧИК**, **customer = ПОЛУЧАТЕЛ**. Keep all Cyrillic **verbatim** (do not transliterate or "correct" product names).
- `company_id` = **ЕИК/БУЛСТАТ** (digits only). `vat_id` = **ИН по ДДС** (keep the country prefix, e.g. `BG112500982`). `iban` = the IBAN if present.
- Dates: convert `DD.MM.YYYY` → `YYYY-MM-DD`. `document_number` = the **Номер** value.
- Amounts: plain decimals, **no** currency symbols or thousands separators. `vat_rate` is a number (`20`, not `"20%"`).
- **Currency**: if the amounts are in euro (€) and the text has a line like `1 € = 1.95583 лв`, set `currency: "EUR"` and `exchange_rate: 1.95583`. If amounts are in lev, use `"BGN"`. Otherwise the ISO‑4217 code you see.
- **Line items**: parse the table with columns `No / Име / Мяр / Кол / Цена / Стойност` → `description / unit / quantity / unit_price / total`. Assume `vat_rate` = the document VAT rate (e.g. `ДДС ( 20 % )`) unless a per-line rate is shown. Skip summary rows (`Данъчна основа`, `ДДС`, `Сума за плащане`, `Словом`).
- **Totals**: `net_total` = Данъчна основа, `vat_total` = ДДС, `gross_total` = Сума за плащане.
- OCR text may contain errors or split rows across lines — reassemble each line item so `quantity × unit_price ≈ total`. Do not drop line items.

Return the JSON object and nothing else.
