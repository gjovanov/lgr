# VatRegisterEntry

One row of a VAT register: the sales register (`PRODAGBI`) or the purchase register (`POKUPKI`) of a Bulgarian VAT return ([FR-25](../../fr/FR-25-books-payroll-and-bg-filings.md) §3.8, §7.1). Rows are the record of a return: its files regenerate from them, byte for byte, so a VAT file is never stored.

## Entity Interface

```typescript
export interface IVatRegisterEntry extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  period: string        // 'YYYYMM', the period it is declared in
  side: string          // 'sales' | 'purchase'
  ledger: string        // 'books' | 'shadow'
  rowNo: number
  docTypeCode: string   // '01' invoice, '03' credit note, '09' protocol, '81' sales report …
  docNumber: string
  docDate: Date         // the document's calendar day, at UTC midnight
  partnerVat?: string
  partnerName?: string
  description?: string
  branch?: number
  code?: string
  cells: Record<string, number>  // integer cents, by official code
  source?: { orgId?: Types.ObjectId; kind?: string; id?: Types.ObjectId }
  frozen: boolean
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| period | string | Yes | - | `YYYYMM`. A purchase document chooses its own, within 12 periods (ЗДДС чл. 72) |
| side | string | Yes | - | `sales` or `purchase` |
| ledger | string | Yes | `books` | `shadow` comes with posting forward (R3) |
| rowNo | number | Yes | - | 1..n within the register, by date, once `generate` has numbered it |
| docTypeCode | string | Yes | - | The annex's document type |
| docNumber | string | No | `''` | As filed |
| docDate | Date | Yes | - | At UTC midnight, so it prints as the same `dd/mm/yyyy` everywhere |
| partnerVat | string | No | - | `999999999999999` for a person the supplier need not identify |
| partnerName | string | No | - | As filed, inner double spaces included |
| description | string | No | - | The goods or service |
| branch | number | No | - | Blank in everything filed so far |
| code | string | No | - | 02-27 or 03-45. Blank in everything filed so far |
| cells | object | Yes | `{}` | Value cells by official code (`02-10`, `03-41`), in integer cents. A blank cell has no key |
| source | object | No | - | The document behind the row, once LGR posts forward. An imported row has none |
| frozen | boolean | Yes | `false` | Set when the return is filed. A frozen row does not change |

## Indexes

| Index | Why |
|-------|-----|
| `{ orgId, ledger, period, side, rowNo }` | A register in row order |
| the same, unique, on `frozen: true` | `vat_row_frozen_unique`. Frozen rows are the record. An open row's number is only a place in the queue until `generate` numbers the register |

## Replication and retention

`R`: written on the org's home, mirrored whole. Never pruned: `TOUCHABLE` in `retention.service.ts` does not name it, and VAT documents are kept five years past the limitation period (ЗДДС чл. 121(1)).
