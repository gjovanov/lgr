# AccountingAnalytic

An analytic of a company's books (аналитичен признак), in a tree. See FR-25 §1.3 and §3.2.

⚠ `path` is the path exactly as booked, double spaces included: two paths that differ by a space are two rows in the accountant's trial balance. An analytic under `СТОКИ:` is an accounting group, not a product.

## Entity Interface

```typescript
export interface IAccountingAnalytic extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  path: string
  root: string
  parentId?: Types.ObjectId
  name: string
  nameLower: string
  kind: AnalyticKind    // 'goods_group' | 'material' | 'product' | 'service' | 'customer' | 'supplier' | 'partner'
                        // | 'bank_account' | 'expense' | 'income' | 'settlement' | 'personnel' | 'fixed_asset' | 'equity' | 'other'
  unit?: string
  contactId?: Types.ObjectId
  bankAccountId?: Types.ObjectId
  fixedAssetId?: Types.ObjectId
  params?: { key: string; value: string }[]   // FR-25a
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| path | string | Yes | - | The full path, as booked. Unique within the organization |
| root | string | Yes | - | The path's first segment. `services/biz/accounting-books/registry.ts` says what each root is |
| parentId | ObjectId | No | - | The analytic one level up |
| name | string | Yes | - | The path's last segment |
| nameLower | string | Yes | - | `name` in the `bg` locale: Cyrillic through a Mongo `$regex` from Bun is broken |
| kind | string | Yes | `other` | What the root makes it |
| unit | string | No | - | The unit of a goods group or a material |
| contactId | ObjectId | No | - | The partner's Contact. It goes on each line too, and the balance sheet splits an account by it |
| bankAccountId | ObjectId | No | - | The BankAccount of `БАНКОВИ СМЕТКИ:<iban>` |
| fixedAssetId | ObjectId | No | - | The FixedAsset of `ДА:<name>` |
| params | { key, value }[] | No | - | FR-25a. The analytic's own properties as the accountant's file lists them (`ПАРАМЕТРИ`), in file order and spelling, empty values included: a list of pairs, not a map, because some names carry dots. Set when the analytics file brings them; a file (or an older client) that lists none leaves them as they are. Never for `ПЕРСОНАЛ` |
| isActive | boolean | No | `true` | Soft delete |
| deactivatedAt | Date | No | - | When it was deactivated |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |

## Relationships

- `parentId` → AccountingAnalytic
- `contactId` → Contact
- `bankAccountId` → BankAccount
- `fixedAssetId` → FixedAsset
- JournalEntry lines point here through `analyticId`

## Indexes

- `{ orgId: 1, path: 1 }` unique
- `{ orgId: 1, root: 1, nameLower: 1 }`

## API Endpoints

None of its own. Written by `POST /api/org/:orgId/accounting/import/analytics`, and by the journal for each path it meets
(an operation's, and since FR-25a a document header's partner where the operations name none). The views planned for it are
in [FR-25a §3.2](../../fr/FR-25a-books-schema-reconciliation.md).
