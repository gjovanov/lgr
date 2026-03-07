# Contact

## Entity Interface

**Source:** `packages/db/src/models/contact.model.ts`

```typescript
interface IContactAddress {
  type: string            // 'billing' | 'shipping' | 'office'
  street: string
  street2?: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault: boolean
}

interface IContactBankDetail {
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string        // default: 'EUR'
  isDefault: boolean
}

interface IContact extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string            // 'customer' | 'supplier' | 'both'
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  mobile?: string
  website?: string
  taxId?: string
  registrationNumber?: string
  addresses: IContactAddress[]
  bankDetails: IContactBankDetail[]
  currency?: string
  paymentTermsDays: number  // default: 30
  creditLimit?: number
  discount?: number
  notes?: string
  tags?: string[]
  accountReceivableId?: Types.ObjectId  // ref: Account
  accountPayableId?: Types.ObjectId     // ref: Account
  isActive: boolean         // default: true
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

**Source:** `packages/dal-sqlite/src/schema/invoicing.schema.ts`

### Main table: `contacts`

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL CHECK(type IN ('customer','supplier','both')),
  company_name TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  mobile TEXT,
  website TEXT,
  tax_id TEXT,
  registration_number TEXT,
  currency TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  credit_limit REAL,
  discount REAL,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  account_receivable_id TEXT,
  account_payable_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_org_type ON contacts(org_id, type);
CREATE INDEX IF NOT EXISTS idx_contacts_org_email ON contacts(org_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_org_company ON contacts(org_id, company_name);
CREATE INDEX IF NOT EXISTS idx_contacts_org_tax ON contacts(org_id, tax_id);
```

### Child table: `contact_addresses`

```sql
CREATE TABLE IF NOT EXISTS contact_addresses (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('billing','shipping','office')),
  street TEXT NOT NULL,
  street2 TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);
```

### Child table: `contact_bank_details`

```sql
CREATE TABLE IF NOT EXISTS contact_bank_details (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  iban TEXT,
  swift TEXT,
  currency TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

### contacts

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id / _id | ObjectId | TEXT PK | Yes | auto | Primary key |
| orgId / org_id | ObjectId | TEXT | Yes | - | Tenant ID (via tenantPlugin) |
| type | String | TEXT | Yes | - | `customer`, `supplier`, `both` |
| companyName / company_name | String | TEXT | No | - | |
| firstName / first_name | String | TEXT | No | - | |
| lastName / last_name | String | TEXT | No | - | |
| email | String | TEXT | No | - | |
| phone | String | TEXT | No | - | |
| mobile | String | TEXT | No | - | |
| website | String | TEXT | No | - | |
| taxId / tax_id | String | TEXT | No | - | |
| registrationNumber / registration_number | String | TEXT | No | - | |
| currency | String | TEXT | No | - | |
| paymentTermsDays / payment_terms_days | Number | INTEGER | Yes | 30 | |
| creditLimit / credit_limit | Number | REAL | No | - | |
| discount | Number | REAL | No | - | |
| notes | String | TEXT | No | - | |
| tags | [String] | TEXT (JSON) | No | `[]` | JSON array in SQLite |
| accountReceivableId / account_receivable_id | ObjectId | TEXT | No | - | Ref: Account |
| accountPayableId / account_payable_id | ObjectId | TEXT | No | - | Ref: Account |
| isActive / is_active | Boolean | INTEGER | Yes | true / 1 | |
| createdAt / created_at | Date | TEXT | Yes | auto | |
| updatedAt / updated_at | Date | TEXT | Yes | auto | |

### contact_addresses

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id | (subdoc _id) | TEXT PK | Yes | auto | |
| contact_id | (parent ref) | TEXT FK | Yes | - | CASCADE delete |
| type | String | TEXT | Yes | - | `billing`, `shipping`, `office` |
| street | String | TEXT | Yes | - | |
| street2 | String | TEXT | No | - | |
| city | String | TEXT | Yes | - | |
| state | String | TEXT | No | - | |
| postalCode / postal_code | String | TEXT | Yes | - | |
| country | String | TEXT | Yes | - | |
| isDefault / is_default | Boolean | INTEGER | Yes | false / 0 | |
| sort_order | - | INTEGER | No | 0 | SQLite only |

### contact_bank_details

| Field | Mongo Type | SQLite Type | Required | Default | Notes |
|-------|-----------|-------------|----------|---------|-------|
| id | (subdoc _id) | TEXT PK | Yes | auto | |
| contact_id | (parent ref) | TEXT FK | Yes | - | CASCADE delete |
| bankName / bank_name | String | TEXT | Yes | - | |
| accountNumber / account_number | String | TEXT | Yes | - | |
| iban | String | TEXT | No | - | |
| swift | String | TEXT | No | - | |
| currency | String | TEXT | Yes | `EUR` | |
| isDefault / is_default | Boolean | INTEGER | Yes | false / 0 | |
| sort_order | - | INTEGER | No | 0 | SQLite only |

## Relationships

| Relation | Target Model | Field | Type |
|----------|-------------|-------|------|
| Belongs to | Org | orgId | Many-to-one |
| References | Account | accountReceivableId | Many-to-one (optional) |
| References | Account | accountPayableId | Many-to-one (optional) |
| Has many | ContactAddress | addresses (embedded) / contact_addresses (child table) | One-to-many |
| Has many | ContactBankDetail | bankDetails (embedded) / contact_bank_details (child table) | One-to-many |
| Referenced by | Invoice | contactId | One-to-many |
| Referenced by | PaymentOrder | contactId | One-to-many |
| Referenced by | CashOrder | contactId | One-to-many |
| Referenced by | StockMovement | contactId | One-to-many |
| Referenced by | ProductCustomPrice | contactId | One-to-many |

## API Endpoints

**Base URL:** `/api/org/:orgId/invoicing/contact`

**Controller:** `packages/invoicing-api/src/controllers/contact.controller.ts`

| Method | Path | Description | Auth | Query Params |
|--------|------|-------------|------|-------------|
| GET | `/` | List contacts (paginated) | Yes | `type`, `tags`, `page`, `size`, `sortBy`, `sortOrder` |
| POST | `/` | Create contact | Yes | - |
| GET | `/:id` | Get contact by ID | Yes | - |
| PUT | `/:id` | Update contact | Yes | - |
| DELETE | `/:id` | Delete contact | Yes | - |

**List response key:** `contacts`

**MongoDB indexes:**
- `{ orgId: 1, type: 1 }`
- `{ orgId: 1, email: 1 }`
- `{ orgId: 1, companyName: 1 }`
- `{ orgId: 1, taxId: 1 }`
