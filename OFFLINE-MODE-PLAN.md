# LGR Offline-First Desktop App — Implementation Plan

## Requirements Restatement

LGR customers need to run the ERP **locally on their machines** without uploading data to `lgrai.app`:

1. **Desktop App** — installable on Windows/macOS/Linux with a user-friendly installer
2. **Local Database** — all tenant data stored on the customer's machine (SQLite via `bun:sqlite`)
3. **Offline-First** — full CRUD operations without internet connectivity
4. **Multi-Machine Sync** — bidirectional sync between machines (e.g., two warehouses)
5. **Data Archival** — automatic daily + manual on-demand archives of selected data
6. **Auto-Updates** — detect and install updates (configurable in settings)
7. **Cloud ↔ Desktop Sync** — bidirectional MongoDB ↔ SQLite data migration/sync
8. **Documentation** — updated docs covering both MongoDB and SQLite models

### Constraints

- **Same codebase** — cloud and desktop share business logic via a Data Abstraction Layer (DAL)
- **Clean code** — SOLID principles, typed interfaces, no Mongoose leakage into business logic
- **Test coverage** — integration tests run against both MongoDB and SQLite; E2E tests for desktop flows

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                         LGR Monorepo                                   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                   Shared Business Logic                          │  │
│  │  packages/services/src/biz/*.service.ts                         │  │
│  │  (never imports mongoose, never imports bun:sqlite)             │  │
│  │  (only imports from packages/dal)                               │  │
│  └──────────────────────────┬──────────────────────────────────────┘  │
│                              │                                         │
│                    ┌─────────▼─────────┐                              │
│                    │   packages/dal     │                              │
│                    │   (Repository      │                              │
│                    │    interfaces)     │                              │
│                    └───┬───────────┬───┘                              │
│                        │           │                                   │
│              ┌─────────▼──┐  ┌────▼────────┐                         │
│              │ dal/mongo   │  │ dal/sqlite  │                         │
│              │ (Mongoose)  │  │ (bun:sqlite)│                         │
│              └─────────────┘  └─────────────┘                         │
│                    │                  │                                │
│         ┌──────────▼──────┐  ┌───────▼──────────┐                    │
│         │  Cloud APIs     │  │  Desktop API      │                    │
│         │  (8 Elysia      │  │  (unified Elysia  │                    │
│         │   services)     │  │   single process)  │                    │
│         └─────────────────┘  └──────────┬────────┘                    │
│                                          │                             │
│                              ┌───────────▼───────────┐                │
│                              │  packages/desktop      │                │
│                              │  (Tauri 2 shell)       │                │
│                              │  - Bun sidecar         │                │
│                              │  - System tray          │                │
│                              │  - Auto-updater         │                │
│                              │  - Archive scheduler    │                │
│                              └───────────────────────┘                │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  packages/sync                                                    │ │
│  │  - Change tracking (SQLite triggers + _changes table)            │ │
│  │  - WebSocket sync protocol (LAN discovery + WAN relay)           │ │
│  │  - MongoDB ↔ SQLite bidirectional migration                      │ │
│  │  - Conflict resolution (LWW per field + additive merge)          │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## New Packages

| Package | Purpose | Dependencies |
|---------|---------|-------------|
| `packages/dal` | Repository interfaces + factory + filter types | `config` |
| `packages/dal-mongo` | MongoDB/Mongoose repository implementations | `dal`, `db` |
| `packages/dal-sqlite` | SQLite repository implementations (`bun:sqlite`) | `dal`, `config` |
| `packages/desktop-api` | Unified Elysia API (all modules, single process) | `dal`, `dal-sqlite`, `services`, `config` |
| `packages/desktop-ui` | Unified Vue 3 SPA (all modules merged) | `ui-shell`, `ui-shared` |
| `packages/desktop` | Tauri 2 shell (Rust core + Bun sidecar) | `desktop-api`, `desktop-ui` |
| `packages/sync` | Sync engine (change tracking, WebSocket, migration) | `dal`, `dal-mongo`, `dal-sqlite` |

---

## Phase 0: Data Abstraction Layer (DAL) — Foundation

**Goal**: Decouple all business logic from Mongoose so it works against any storage backend.

### 0.1 — Core DAL Types (`packages/dal/src/`)

```
packages/dal/
├── src/
│   ├── index.ts                    # Public API barrel
│   ├── types.ts                    # Core types: Filter, Sort, Page, etc.
│   ├── repository.ts               # IRepository<T> interface
│   ├── unit-of-work.ts             # IUnitOfWork interface (optional transactions)
│   ├── factory.ts                  # RepositoryFactory (runtime backend selection)
│   ├── errors.ts                   # DAL-specific errors (NotFound, Duplicate, etc.)
│   └── entities/                   # Pure TypeScript interfaces (no Mongoose)
│       ├── core.ts                 # IOrg, IUser, IInvite, IOrgApp, etc.
│       ├── accounting.ts           # IAccount, IJournalEntry, IFiscalYear, etc.
│       ├── invoicing.ts            # IContact, IInvoice, IPaymentOrder, ICashOrder
│       ├── warehouse.ts            # IProduct, IWarehouse, IStockLevel, etc.
│       ├── payroll.ts              # IEmployee, IPayrollRun, IPayslip, ITimesheet
│       ├── hr.ts                   # IDepartment, ILeaveType, ILeaveRequest, etc.
│       ├── crm.ts                  # ILead, IDeal, IPipeline, IActivity
│       ├── erp.ts                  # IBillOfMaterials, IProductionOrder, etc.
│       └── index.ts                # Entity barrel
├── package.json
└── tsconfig.json
```

**Key design decisions:**

1. **Entity interfaces are pure TypeScript** — no `Document`, no `Types.ObjectId`. IDs are `string`. Dates are `Date`. This is the single source of truth for data shapes.

2. **Repository interface** — mirrors current `BaseDao` but is storage-agnostic:

```typescript
// packages/dal/src/types.ts
export interface Filter<T> {
  [K in keyof T]?: T[K] | FilterOperator<T[K]>
}

export interface FilterOperator<V> {
  $eq?: V
  $ne?: V
  $gt?: V
  $gte?: V
  $lt?: V
  $lte?: V
  $in?: V[]
  $nin?: V[]
  $regex?: string
  $exists?: boolean
  $text?: { $search: string }  // full-text search
}

export interface SortSpec {
  [field: string]: 1 | -1
}

export interface PageRequest {
  page: number
  size: number
  sort?: SortSpec
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  totalPages: number
}

// packages/dal/src/repository.ts
export interface IRepository<T extends { id: string; orgId: string }> {
  findById(id: string): Promise<T | null>
  findOne(filter: Filter<T>): Promise<T | null>
  findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>>
  findMany(filter: Filter<T>, sort?: SortSpec): Promise<T[]>
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>
  update(id: string, data: Partial<T>): Promise<T | null>
  delete(id: string): Promise<boolean>
  count(filter: Filter<T>): Promise<number>
  aggregate<R>(pipeline: AggregateStage[]): Promise<R[]>
}
```

3. **Aggregate abstraction** — for the 1-2 services that use aggregation (product-ledger), define a portable pipeline format:

```typescript
export type AggregateStage =
  | { $match: Filter<any> }
  | { $sort: SortSpec }
  | { $limit: number }
  | { $skip: number }
  | { $unwind: string }
  | { $lookup: { from: string; localField: string; foreignField: string; as: string } }
  | { $project: Record<string, 0 | 1 | Expression> }
  | { $group: { _id: string | Record<string, string>; [key: string]: any } }

type Expression = string | Record<string, any>
```

4. **Repository factory** — runtime dispatch based on `LGR_MODE`:

```typescript
// packages/dal/src/factory.ts
export type DalBackend = 'mongo' | 'sqlite'

export interface RepositoryRegistry {
  orgs: IRepository<IOrg>
  users: IRepository<IUser>
  accounts: IRepository<IAccount>
  invoices: IRepository<IInvoice>
  products: IRepository<IProduct>
  // ... all 48 repositories
}

export function createRepositories(backend: DalBackend, config: DalConfig): RepositoryRegistry
```

### 0.2 — Extract Entity Interfaces from Mongoose Models

**Process for each of the 48 models:**

1. Copy the TypeScript interface (e.g., `IInvoice`) from the `.model.ts` file
2. Replace `Types.ObjectId` → `string` for all ID fields
3. Remove `extends Document`
4. Keep embedded sub-interfaces (e.g., `IInvoiceLine`, `IInvoicePayment`) as-is but with `string` IDs
5. Add `id: string` (replacing `_id`)
6. Ensure `createdAt: Date` and `updatedAt: Date` are explicit

**Example transformation:**

```typescript
// BEFORE (packages/db/src/models/invoice.model.ts)
export interface IInvoice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  contactId: Types.ObjectId
  lines: IInvoiceLine[]
  // ...
}

// AFTER (packages/dal/src/entities/invoicing.ts)
export interface IInvoice {
  id: string
  orgId: string
  contactId: string
  lines: IInvoiceLine[]
  // ...
  createdAt: Date
  updatedAt: Date
}

export interface IInvoiceLine {
  id?: string              // sub-document ID (optional)
  productId?: string
  description: string
  quantity: number
  // ...
}
```

**Full entity count:**

| Module | Entities | Embedded sub-types |
|--------|----------|-------------------|
| Core | 9 (Org, User, Invite, Code, EmailLog, AuditLog, File, Notification, BackgroundTask, OrgApp) | IOAuthProvider, IOrgSettings, ITaxConfig |
| Accounting | 9 | IJournalEntryLine, IDepreciationEntry, IReconciliationItem, ITaxReturnLine |
| Invoicing | 4 | IInvoiceLine, IInvoicePayment, IInvoiceAddress, IContactAddress, IContactBankDetail |
| Warehouse | 6 | IStockMovementLine, IInventoryCountLine, IPriceListItem, IProductVariant, IProductCustomPrice |
| Payroll | 4 | IPayrollRunItem, IPayrollRunTotals, IPayslipEarning, IPayslipDeduction, ISalary, IDeduction |
| HR | 6 | ILeaveRequestAttachment, ITripExpense |
| CRM | 4 | IPipelineStage, ICustomField (Map) |
| ERP | 5 | IBOMMaterial, IProductionStage, IMaterialConsumed, IConstructionPhase, IPOSTransactionLine, IPOSPayment |
| Tags | 1 | — |
| **Total** | **48** | **~30 sub-types** |

### 0.3 — MongoDB Repository Implementation (`packages/dal-mongo/`)

```
packages/dal-mongo/
├── src/
│   ├── index.ts                    # Factory: createMongoRepositories()
│   ├── base.repository.ts          # MongoRepository<T> (wraps Mongoose Model)
│   ├── filter-translator.ts        # DAL Filter → Mongoose FilterQuery
│   ├── aggregate-translator.ts     # DAL AggregateStage → Mongoose pipeline
│   ├── entity-mapper.ts            # Mongoose Document ↔ DAL Entity mapping
│   └── repositories/
│       ├── account.repository.ts   # Custom methods (if any beyond base)
│       ├── invoice.repository.ts   # getNextInvoiceNumber, findOverdue, etc.
│       ├── product.repository.ts   # search (text index), findLowStock
│       └── ...                     # One per entity with custom methods
├── package.json
└── tsconfig.json
```

**Base MongoDB Repository** — wraps the existing Mongoose model:

```typescript
export class MongoRepository<T extends BaseEntity> implements IRepository<T> {
  constructor(
    private model: Model<any>,
    private mapper: EntityMapper<T>,
  ) {}

  async findById(id: string): Promise<T | null> {
    const doc = await this.model.findById(id).lean().exec()
    return doc ? this.mapper.toEntity(doc) : null
  }

  async findAll(filter: Filter<T>, page?: PageRequest): Promise<PageResult<T>> {
    const mongoFilter = translateFilter(filter)
    const sort = page?.sort ?? { createdAt: -1 }
    const skip = (page?.page ?? 0) * (page?.size ?? 10)
    const limit = page?.size ?? 10

    if (limit === 0) {
      const docs = await this.model.find(mongoFilter).sort(sort).lean().exec()
      return { items: docs.map(d => this.mapper.toEntity(d)), total: docs.length, page: 0, size: 0, totalPages: 1 }
    }

    const [docs, total] = await Promise.all([
      this.model.find(mongoFilter).sort(sort).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(mongoFilter).exec(),
    ])

    return {
      items: docs.map(d => this.mapper.toEntity(d)),
      total,
      page: page?.page ?? 0,
      size: limit,
      totalPages: Math.ceil(total / limit),
    }
  }

  // ... create, update, delete, count, aggregate
}
```

**Entity mapper** — converts `_id` → `id`, `ObjectId` → `string`:

```typescript
export class EntityMapper<T extends BaseEntity> {
  toEntity(doc: any): T {
    const { _id, __v, ...rest } = doc
    return { id: String(_id), ...this.convertIds(rest) } as T
  }

  toDocument(entity: Partial<T>): any {
    const { id, ...rest } = entity as any
    return this.convertToObjectIds(rest)
  }
}
```

### 0.4 — SQLite Repository Implementation (`packages/dal-sqlite/`)

```
packages/dal-sqlite/
├── src/
│   ├── index.ts                    # Factory: createSQLiteRepositories()
│   ├── connection.ts               # SQLite connection manager (bun:sqlite)
│   ├── base.repository.ts          # SQLiteRepository<T>
│   ├── filter-translator.ts        # DAL Filter → SQL WHERE clause
│   ├── aggregate-translator.ts     # DAL AggregateStage → SQL (with CTEs)
│   ├── entity-mapper.ts            # SQL row ↔ DAL Entity mapping
│   ├── migrations/                 # Schema versioning
│   │   ├── runner.ts               # Migration runner
│   │   ├── 001-initial-schema.ts   # All 48 tables + child tables
│   │   └── ...
│   ├── schema/                     # Table definitions
│   │   ├── core.schema.ts
│   │   ├── accounting.schema.ts
│   │   ├── invoicing.schema.ts
│   │   ├── warehouse.schema.ts
│   │   ├── payroll.schema.ts
│   │   ├── hr.schema.ts
│   │   ├── crm.schema.ts
│   │   └── erp.schema.ts
│   └── repositories/
│       ├── account.repository.ts
│       ├── invoice.repository.ts   # Handles lines/payments child tables
│       ├── product.repository.ts   # FTS5 for search
│       └── ...
├── package.json
└── tsconfig.json
```

**SQLite schema design principles:**

1. **IDs are UUIDs** (TEXT) — generated via `crypto.randomUUID()`, not auto-increment
2. **Embedded arrays → child tables** with foreign keys
3. **Embedded objects → JSON columns** (for small nested objects like addresses)
4. **Indexes mirror MongoDB** — composite `(org_id, ...)` on every table
5. **WAL mode** enabled for concurrent read/write
6. **FTS5** for product text search

**Example schema (Invoice with child tables):**

```sql
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('invoice','proforma','credit_note','debit_note')),
  direction TEXT NOT NULL CHECK(direction IN ('outgoing','incoming')),
  status TEXT NOT NULL DEFAULT 'draft',
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  issue_date TEXT NOT NULL,           -- ISO 8601
  due_date TEXT NOT NULL,
  currency TEXT DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  subtotal REAL DEFAULT 0,
  discount_total REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  total REAL DEFAULT 0,
  total_base REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  amount_due REAL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  footer TEXT,
  billing_address TEXT,               -- JSON: {street, city, state, postalCode, country}
  shipping_address TEXT,              -- JSON (nullable)
  related_invoice_id TEXT REFERENCES invoices(id),
  converted_invoice_id TEXT REFERENCES invoices(id),
  proforma_id TEXT REFERENCES invoices(id),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  recurring_config TEXT,              -- JSON (nullable)
  sent_at TEXT,
  paid_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  tags TEXT,                          -- JSON array: ["tag1","tag2"]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, invoice_number)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL DEFAULT 0,
  tax_rate REAL NOT NULL,
  tax_amount REAL NOT NULL,
  line_total REAL NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  warehouse_id TEXT REFERENCES warehouses(id),
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','bank_transfer','card','check','other')),
  reference TEXT,
  bank_account_id TEXT REFERENCES bank_accounts(id),
  journal_entry_id TEXT REFERENCES journal_entries(id)
);

CREATE TABLE invoice_attachments (
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id),
  PRIMARY KEY (invoice_id, file_id)
);

-- Indexes
CREATE INDEX idx_invoices_org_contact ON invoices(org_id, contact_id);
CREATE INDEX idx_invoices_org_status ON invoices(org_id, status);
CREATE INDEX idx_invoices_org_dir_date ON invoices(org_id, direction, issue_date DESC);
CREATE INDEX idx_invoices_org_due_status ON invoices(org_id, due_date, status);
CREATE INDEX idx_invoice_lines_product ON invoice_lines(product_id);
```

**SQLite Repository handling child tables:**

```typescript
export class InvoiceSQLiteRepository extends SQLiteRepository<IInvoice> {
  async findById(id: string): Promise<IInvoice | null> {
    const row = this.db.query('SELECT * FROM invoices WHERE id = ?').get(id)
    if (!row) return null

    const lines = this.db.query('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order').all(id)
    const payments = this.db.query('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date').all(id)
    const attachments = this.db.query('SELECT file_id FROM invoice_attachments WHERE invoice_id = ?').all(id)

    return this.mapper.toEntity(row, { lines, payments, attachments })
  }

  async create(data: Omit<IInvoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<IInvoice> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db.transaction(() => {
      // Insert parent
      this.db.run('INSERT INTO invoices (...) VALUES (...)', [...])

      // Insert lines
      for (const line of data.lines) {
        this.db.run('INSERT INTO invoice_lines (...) VALUES (...)', [...])
      }

      // Insert payments
      for (const payment of data.payments) {
        this.db.run('INSERT INTO invoice_payments (...) VALUES (...)', [...])
      }
    })()

    return this.findById(id) as Promise<IInvoice>
  }
}
```

### 0.5 — Refactor Services to Use DAL

**Current pattern** (direct Mongoose):
```typescript
// packages/services/src/biz/warehouse.service.ts
import { StockLevel, StockMovement, Product } from 'db/models'

export async function confirmMovement(movementId: string): Promise<IStockMovement> {
  const movement = await StockMovement.findById(movementId)
  // ...
  movement.status = 'completed'
  await movement.save()
}
```

**New pattern** (via DAL):
```typescript
// packages/services/src/biz/warehouse.service.ts
import type { RepositoryRegistry } from 'dal'

export function createWarehouseService(repos: RepositoryRegistry) {
  return {
    async confirmMovement(movementId: string) {
      const movement = await repos.stockMovements.findById(movementId)
      if (!movement) throw new NotFoundError('StockMovement', movementId)
      if (movement.status !== 'draft') throw new BusinessError('Only draft movements can be confirmed')

      for (const line of movement.lines) {
        if (movement.fromWarehouseId) {
          await adjustStock(repos, movement.orgId, line.productId, movement.fromWarehouseId, -line.quantity, line.unitCost)
        }
        if (movement.toWarehouseId) {
          await adjustStock(repos, movement.orgId, line.productId, movement.toWarehouseId, line.quantity, line.unitCost)
        }
      }

      return repos.stockMovements.update(movementId, { status: 'completed' })
    },
  }
}
```

**Service refactoring approach:**

| Service file | Complexity | Mongoose-specific patterns |
|-------------|-----------|--------------------------|
| `warehouse.service.ts` | Low | `findById`, `findOne`, `.save()` → `update()` |
| `accounting.service.ts` | Medium | `findById`, batch `Account.save()` loops |
| `invoicing.service.ts` | Medium | `findById`, embedded array push (`.payments.push()`) |
| `payroll.service.ts` | Medium | `Employee.find()`, batch `Payslip.create()` |
| `crm.service.ts` | Low | Standard CRUD |
| `hr.service.ts` | Low | `findOne` + `save()` patterns |
| `erp.service.ts` | Medium | Cross-module (warehouse stock adjustments) |
| `product-ledger.service.ts` | **High** | Aggregation pipeline with `$unwind`, `$lookup` |

**For `product-ledger.service.ts`** — the most complex case:
- Rewrite using the `aggregate()` method on the repository
- MongoDB backend translates to native MongoDB aggregation
- SQLite backend translates to SQL with JOINs and CTEs:

```sql
-- SQLite equivalent of the product ledger aggregation
WITH movement_lines AS (
  SELECT
    sm.id, sm.date, sm.movement_number, sm.type,
    sm.from_warehouse_id, sm.to_warehouse_id, sm.invoice_id,
    sl.product_id, sl.quantity, sl.unit_cost, sl.total_cost
  FROM stock_movements sm
  JOIN stock_movement_lines sl ON sl.movement_id = sm.id
  WHERE sm.org_id = ? AND sl.product_id = ? AND sm.status IN ('confirmed','completed')
    AND sm.date BETWEEN ? AND ?
),
with_names AS (
  SELECT ml.*,
    fw.name AS from_warehouse_name,
    tw.name AS to_warehouse_name,
    inv.invoice_number
  FROM movement_lines ml
  LEFT JOIN warehouses fw ON fw.id = ml.from_warehouse_id
  LEFT JOIN warehouses tw ON tw.id = ml.to_warehouse_id
  LEFT JOIN invoices inv ON inv.id = ml.invoice_id
)
SELECT * FROM with_names ORDER BY date ASC, id ASC;
```

### 0.6 — Runtime Mode Detection

```typescript
// packages/config/src/index.ts (add)
export type LgrMode = 'cloud' | 'desktop'

export function getLgrMode(): LgrMode {
  return (process.env.LGR_MODE as LgrMode) || 'cloud'
}
```

### 0.7 — Integration Tests for DAL Parity

**Goal**: The exact same test suite runs against both backends.

```
packages/tests/src/
├── dal/
│   ├── parity/                      # Tests that run against BOTH backends
│   │   ├── account.parity.test.ts
│   │   ├── invoice.parity.test.ts
│   │   ├── product.parity.test.ts
│   │   ├── stock-movement.parity.test.ts
│   │   ├── journal-entry.parity.test.ts
│   │   └── ... (one per entity)
│   ├── mongo-specific/              # MongoDB-only tests (text search, regex, etc.)
│   │   └── text-search.test.ts
│   ├── sqlite-specific/             # SQLite-only tests (FTS5, triggers, etc.)
│   │   └── fts5-search.test.ts
│   └── helpers/
│       ├── dal-test-setup.ts        # Creates repos for both backends
│       └── dal-factories.ts         # Factory functions using DAL (not Mongoose)
```

**Parity test pattern:**

```typescript
// packages/tests/src/dal/parity/invoice.parity.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardown } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>][] = [
  ['mongo', setupMongoRepos],
  ['sqlite', setupSQLiteRepos],
]

for (const [name, setup] of backends) {
  describe(`Invoice Repository [${name}]`, () => {
    let repos: RepositoryRegistry

    beforeAll(async () => { repos = await setup() })
    afterAll(teardown)

    test('creates invoice with lines and payments', async () => {
      const org = await repos.orgs.create({ name: 'Test', slug: 'test', ... })
      const contact = await repos.contacts.create({ orgId: org.id, ... })
      const invoice = await repos.invoices.create({
        orgId: org.id,
        invoiceNumber: 'INV-001',
        contactId: contact.id,
        lines: [{ description: 'Item 1', quantity: 2, unitPrice: 100, ... }],
        payments: [],
        ...
      })

      expect(invoice.id).toBeDefined()
      expect(invoice.lines).toHaveLength(1)
      expect(invoice.lines[0].description).toBe('Item 1')

      // Verify findById returns the same data
      const found = await repos.invoices.findById(invoice.id)
      expect(found).toEqual(invoice)
    })

    test('filters by orgId + status', async () => { ... })
    test('paginates results', async () => { ... })
    test('updates embedded payment array', async () => { ... })
    test('enforces unique invoice number per org', async () => { ... })
    test('deletes cascades to lines and payments', async () => { ... })
  })
}
```

**Estimated parity tests**: ~200 tests across 48 entities (4-5 tests per entity average).

---

## Phase 1: SQLite Schema + Migrations

**Goal**: Define all 48 SQLite tables with indexes, constraints, FTS5, and a migration system.

### 1.1 — Schema Definitions

One schema file per module, each exporting an array of `CREATE TABLE` + `CREATE INDEX` statements:

| Schema file | Tables | Child tables |
|------------|--------|-------------|
| `core.schema.ts` | orgs, users, invites, codes, email_logs, audit_logs, files, notifications, background_tasks, org_apps | user_oauth_providers, org_settings (JSON) |
| `accounting.schema.ts` | accounts, fiscal_years, fiscal_periods, journal_entries, fixed_assets, bank_accounts, bank_reconciliations, tax_returns, exchange_rates | journal_entry_lines, fixed_asset_depreciation, reconciliation_items, tax_return_lines |
| `invoicing.schema.ts` | invoices, contacts, payment_orders, cash_orders | invoice_lines, invoice_payments, invoice_attachments, contact_addresses, contact_bank_details |
| `warehouse.schema.ts` | products, warehouses, stock_levels, stock_movements, inventory_counts, price_lists | stock_movement_lines, inventory_count_lines, price_list_items, product_variants, product_custom_prices |
| `payroll.schema.ts` | employees, payroll_runs, payslips, timesheets | payroll_run_items, payslip_earnings, payslip_deductions, employee_deductions, employee_benefits |
| `hr.schema.ts` | departments, leave_types, leave_requests, leave_balances, business_trips, employee_documents | trip_expenses |
| `crm.schema.ts` | leads, deals, pipelines, activities | pipeline_stages, lead_custom_fields |
| `erp.schema.ts` | bill_of_materials, production_orders, construction_projects, pos_sessions, pos_transactions | bom_materials, production_stages, materials_consumed, construction_phases, pos_transaction_lines, pos_transaction_payments |
| `tags.schema.ts` | tags | — |
| `sync.schema.ts` | _changes, _sync_state, _device_info | — |

**Total: ~48 parent tables + ~30 child tables = ~78 tables**

### 1.2 — Migration System

```typescript
// packages/dal-sqlite/src/migrations/runner.ts
interface Migration {
  version: number
  name: string
  up(db: Database): void
  down(db: Database): void
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
  const applied = db.query('SELECT version FROM _migrations').all().map(r => r.version)

  db.transaction(() => {
    for (const m of migrations.filter(m => !applied.includes(m.version))) {
      m.up(db)
      db.run('INSERT INTO _migrations VALUES (?, ?, datetime("now"))', [m.version, m.name])
    }
  })()
}
```

### 1.3 — SQLite Connection Manager

```typescript
// packages/dal-sqlite/src/connection.ts
import { Database } from 'bun:sqlite'

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true })

  // Performance pragmas
  db.exec('PRAGMA journal_mode = WAL')          // Write-ahead logging
  db.exec('PRAGMA synchronous = NORMAL')        // Balanced durability
  db.exec('PRAGMA foreign_keys = ON')           // Enforce FK constraints
  db.exec('PRAGMA busy_timeout = 5000')         // Wait up to 5s for locks
  db.exec('PRAGMA cache_size = -64000')         // 64MB page cache
  db.exec('PRAGMA temp_store = MEMORY')         // Temp tables in memory

  return db
}
```

### 1.4 — Integration Tests: Schema & Migrations

```typescript
// packages/tests/src/dal/sqlite/schema.test.ts
describe('SQLite Schema', () => {
  test('creates all tables from initial migration', () => { ... })
  test('all foreign keys are valid', () => { ... })
  test('unique constraints match MongoDB indexes', () => { ... })
  test('migration runner is idempotent', () => { ... })
  test('migration rollback works', () => { ... })
})
```

---

## Phase 2: Desktop API (Unified Elysia)

**Goal**: Single Elysia process serving all 8 modules, using `dal-sqlite`.

### 2.1 — Package Structure

```
packages/desktop-api/
├── src/
│   ├── index.ts                    # Entry point: start Elysia on port 4000
│   ├── app.ts                      # Elysia app with all module routers
│   ├── auth/
│   │   └── desktop-auth.service.ts # Simplified auth (local JWT, no OAuth)
│   ├── setup/
│   │   └── first-run.ts            # First-launch wizard: create org + admin user
│   └── static/                     # Serves built desktop-ui assets
├── package.json
└── tsconfig.json
```

### 2.2 — Unified Router

```typescript
// packages/desktop-api/src/app.ts
import { Elysia } from 'elysia'
import { createRepositories } from 'dal'
import { openDatabase } from 'dal-sqlite'
import { DesktopAuthService } from './auth/desktop-auth.service'

// Import all controllers (reuse from existing *-api packages)
import { accountController } from 'accounting-api/controllers'
import { invoiceController } from 'invoicing-api/controllers'
// ... all 8 modules

const db = openDatabase('~/LGR/data/lgr.db')
const repos = createRepositories('sqlite', { db })

export const app = new Elysia()
  .use(DesktopAuthService)
  .use(accountController(repos))
  .use(invoiceController(repos))
  .use(warehouseController(repos))
  // ... all module controllers
  .listen(4000)
```

### 2.3 — Simplified Desktop Auth

```typescript
// packages/desktop-api/src/auth/desktop-auth.service.ts
// No OAuth, no Stripe. Just local username/password with a long-lived JWT.
export const DesktopAuthService = new Elysia({ name: 'desktop-auth' })
  .derive(async ({ cookie, headers }) => {
    // Same JWT validation as cloud, but token never expires (or 1-year expiry)
    // No external provider calls
  })
  .macro({
    isSignIn: () => ({ /* same macro as cloud */ }),
  })
```

### 2.4 — First-Run Wizard

On first launch (no `lgr.db` file exists):
1. Prompt for org name, admin username, password
2. Create org + admin user in SQLite
3. Run all migrations
4. Issue local JWT
5. Redirect to app

### 2.5 — Integration Tests: Desktop API

```typescript
// packages/tests/src/desktop/api.test.ts
describe('Desktop API', () => {
  test('first-run creates org and admin user', () => { ... })
  test('all 8 module routers are registered', () => { ... })
  test('auth works with local JWT', () => { ... })
  test('CRUD operations work against SQLite', () => { ... })
  test('aggregation (product ledger) works against SQLite', () => { ... })
})
```

---

## Phase 3: Desktop UI (Unified Vue SPA)

**Goal**: Single Vue 3 SPA with all 8 module UIs, plus desktop-specific features.

### 3.1 — Package Structure

```
packages/desktop-ui/
├── src/
│   ├── main.ts                     # Vue app entry
│   ├── App.vue                     # Root component with sidebar
│   ├── router/
│   │   └── index.ts                # All module routes under prefixes
│   ├── stores/
│   │   └── index.ts                # All module Pinia stores
│   ├── views/
│   │   ├── desktop/                # Desktop-specific views
│   │   │   ├── SetupWizard.vue     # First-run setup
│   │   │   ├── SyncSettings.vue    # Sync configuration
│   │   │   ├── ArchiveManager.vue  # Archive management
│   │   │   ├── UpdateSettings.vue  # Auto-update preferences
│   │   │   └── SyncStatus.vue      # Sync status dashboard
│   │   └── ...                     # Reuse existing module views
│   ├── composables/
│   │   ├── useSyncStatus.ts        # Reactive sync state
│   │   ├── useDesktopSettings.ts   # Desktop settings store
│   │   └── useAutoUpdate.ts        # Auto-update composable
│   └── components/
│       ├── SyncIndicator.vue       # Toolbar sync status icon
│       ├── ConflictResolver.vue    # UI for resolving sync conflicts
│       └── ArchiveDialog.vue       # Archive creation dialog
├── vite.config.ts
├── package.json
└── tsconfig.json
```

### 3.2 — What Changes from Cloud UI

| Feature | Cloud UI | Desktop UI |
|---------|----------|-----------|
| Auth | OAuth + email login | Local username/password only |
| Billing | Stripe subscription | Removed |
| App hub | Grid of separate apps | Sidebar with all modules |
| API base URL | Per-app ports (4010, 4020...) | Single `http://localhost:4000` |
| Sync status | N/A | Toolbar indicator |
| Settings | Cloud settings | + Sync, Archive, Update settings |

### 3.3 — E2E Tests: Desktop UI

```
packages/e2e/tests/desktop/
├── setup-wizard.spec.ts            # First-run flow
├── module-navigation.spec.ts       # Navigate between all modules
├── offline-crud.spec.ts            # CRUD without internet
├── sync-settings.spec.ts           # Configure sync peers
├── archive-manager.spec.ts         # Create/restore archives
├── update-settings.spec.ts         # Configure auto-updates
└── conflict-resolver.spec.ts       # Resolve sync conflicts
```

---

## Phase 4: Tauri Desktop Shell

**Goal**: Package the desktop API + UI into an installable desktop app.

### 4.1 — Package Structure

```
packages/desktop/
├── src-tauri/
│   ├── Cargo.toml                  # Rust dependencies
│   ├── tauri.conf.json             # Tauri config (window, sidecar, updater)
│   ├── src/
│   │   ├── main.rs                 # Tauri entry point
│   │   ├── sidecar.rs              # Bun sidecar lifecycle management
│   │   ├── archive.rs              # SQLite backup + zstd compression
│   │   ├── tray.rs                 # System tray icon + menu
│   │   └── updater.rs              # Auto-update check + install logic
│   ├── icons/                      # App icons (all platforms)
│   └── binaries/                   # Bundled Bun runtime
├── package.json
└── README.md
```

### 4.2 — Bun Sidecar Management

```rust
// src-tauri/src/sidecar.rs
use tauri::api::process::{Command, CommandEvent};

pub fn start_bun_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path_resolver().app_data_dir().unwrap();
    let db_path = data_dir.join("data/lgr.db");

    let (mut rx, child) = Command::new_sidecar("bun")?
        .args(&["run", "packages/desktop-api/src/index.ts"])
        .envs(vec![
            ("LGR_MODE", "desktop"),
            ("LGR_DB_PATH", db_path.to_str().unwrap()),
            ("PORT", "4000"),
        ])
        .spawn()?;

    // Monitor sidecar health
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::info!("[bun] {}", line),
                CommandEvent::Stderr(line) => log::error!("[bun] {}", line),
                CommandEvent::Error(err) => log::error!("[bun] error: {}", err),
                CommandEvent::Terminated(payload) => {
                    log::warn!("[bun] terminated: {:?}", payload);
                    // Optionally restart
                }
                _ => {}
            }
        }
    });

    Ok(())
}
```

### 4.3 — Auto-Updater

```json
// src-tauri/tauri.conf.json (updater section)
{
  "updater": {
    "active": true,
    "dialog": false,
    "endpoints": ["https://releases.lgrai.app/{{target}}/{{arch}}/{{current_version}}"],
    "pubkey": "..."
  }
}
```

**Update flow:**
1. On app start (if enabled in settings), check endpoint for new version
2. If available, show notification in system tray
3. User clicks "Update" → download in background → show progress
4. On completion, prompt to restart (or auto-restart if setting enabled)
5. Settings options:
   - `autoCheck`: boolean (default: true)
   - `autoInstall`: boolean (default: false — requires user confirmation)
   - `checkInterval`: 'daily' | 'weekly' | 'on_start' (default: 'on_start')
   - `channel`: 'stable' | 'beta' (default: 'stable')

### 4.4 — Installer Configuration

| Platform | Format | Notes |
|----------|--------|-------|
| Windows | MSI + NSIS | Silent install option (`/S` flag) |
| macOS | DMG | Drag to Applications |
| Linux | AppImage + .deb | AppImage is universal, .deb for Ubuntu/Debian |

**Installer includes:**
- Tauri app binary (~2-5 MB)
- Bundled Bun runtime (~50 MB)
- Desktop API + UI built artifacts (~20 MB)
- Total: ~75-80 MB installer

### 4.5 — CI/CD Pipeline

```yaml
# .github/workflows/desktop-release.yml
name: Desktop Release
on:
  push:
    tags: ['desktop-v*']

jobs:
  build:
    strategy:
      matrix:
        platform: [ubuntu-22.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: dtolnay/rust-toolchain@stable
      - run: bun install
      - run: bun run build:desktop-ui
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
        with:
          tagName: desktop-v__VERSION__
          releaseName: 'LGR Desktop v__VERSION__'
          releaseBody: 'See CHANGELOG.md for details'
```

### 4.6 — E2E Tests: Desktop App

```
packages/e2e/tests/desktop/
├── install-launch.spec.ts          # App launches, sidecar starts, WebView loads
├── first-run-wizard.spec.ts        # Setup wizard creates org + admin
├── system-tray.spec.ts             # Tray icon, menu items
├── auto-update.spec.ts             # Update check, download, install flow
└── graceful-shutdown.spec.ts       # Sidecar shuts down cleanly on app close
```

---

## Phase 5: Sync Engine

**Goal**: Bidirectional sync between desktop machines (SQLite ↔ SQLite) and cloud ↔ desktop migration (MongoDB ↔ SQLite).

### 5.1 — Package Structure

```
packages/sync/
├── src/
│   ├── index.ts                    # Public API
│   ├── change-tracker/
│   │   ├── triggers.ts             # SQLite trigger definitions for change tracking
│   │   ├── change-log.ts           # Read/write _changes table
│   │   └── types.ts                # ChangeEntry, SyncState, DeviceInfo
│   ├── protocol/
│   │   ├── handshake.ts            # Peer handshake (exchange device IDs, last seq)
│   │   ├── delta-stream.ts         # Stream unsynced changes
│   │   ├── ack.ts                  # Acknowledge received changes
│   │   └── messages.ts             # WebSocket message types
│   ├── conflict/
│   │   ├── resolver.ts             # Conflict resolution strategies
│   │   ├── lww.ts                  # Last-write-wins per field
│   │   ├── additive.ts             # Additive merge for counters
│   │   └── conflict-log.ts         # Log conflicts for manual review
│   ├── transport/
│   │   ├── ws-server.ts            # WebSocket server (each desktop is a server)
│   │   ├── ws-client.ts            # WebSocket client (connect to peer)
│   │   ├── lan-discovery.ts        # mDNS/Bonjour peer discovery
│   │   └── wan-relay.ts            # Optional WAN relay client
│   ├── migration/
│   │   ├── mongo-to-sqlite.ts      # Full export: MongoDB → SQLite
│   │   ├── sqlite-to-mongo.ts      # Full export: SQLite → MongoDB
│   │   ├── incremental-sync.ts     # Incremental: MongoDB ↔ SQLite (change-based)
│   │   └── id-mapper.ts            # ObjectId ↔ UUID bidirectional mapping
│   └── scheduler/
│       └── sync-scheduler.ts       # Periodic sync (configurable interval)
├── package.json
└── tsconfig.json
```

### 5.2 — Change Tracking (SQLite Triggers)

Every table gets INSERT/UPDATE/DELETE triggers that log to `_changes`:

```sql
-- packages/dal-sqlite/src/schema/sync.schema.ts

CREATE TABLE _changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  data TEXT,                          -- JSON: full row for INSERT, changed fields for UPDATE, null for DELETE
  old_data TEXT,                      -- JSON: previous values for UPDATE (for conflict detection)
  timestamp TEXT NOT NULL,            -- ISO 8601 with microseconds
  device_id TEXT NOT NULL,
  synced INTEGER DEFAULT 0,           -- 0=pending, 1=synced to all known peers
  UNIQUE(table_name, row_id, timestamp, device_id)
);

CREATE TABLE _sync_state (
  peer_device_id TEXT PRIMARY KEY,
  last_received_seq INTEGER DEFAULT 0,
  last_sent_seq INTEGER DEFAULT 0,
  last_sync_at TEXT,
  peer_name TEXT,
  peer_address TEXT
);

CREATE TABLE _device_info (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE _conflict_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_data TEXT NOT NULL,            -- JSON
  remote_data TEXT NOT NULL,           -- JSON
  resolution TEXT,                     -- 'local_wins' | 'remote_wins' | 'merged' | 'pending'
  resolved_data TEXT,                  -- JSON (final merged result)
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- ID mapping for MongoDB ↔ SQLite sync
CREATE TABLE _id_map (
  sqlite_id TEXT NOT NULL,
  mongo_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (table_name, sqlite_id),
  UNIQUE (table_name, mongo_id)
);
```

**Trigger generation** (auto-generated for each table):

```typescript
// packages/sync/src/change-tracker/triggers.ts
export function generateTriggers(tableName: string, columns: string[]): string[] {
  const deviceIdExpr = `(SELECT device_id FROM _device_info LIMIT 1)`

  return [
    // INSERT trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_insert
     AFTER INSERT ON ${tableName}
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, data, timestamp, device_id)
       VALUES ('${tableName}', NEW.id, 'INSERT',
         json_object(${columns.map(c => `'${c}', NEW.${c}`).join(', ')}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END;`,

    // UPDATE trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_update
     AFTER UPDATE ON ${tableName}
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, data, old_data, timestamp, device_id)
       VALUES ('${tableName}', NEW.id, 'UPDATE',
         json_object(${columns.map(c => `'${c}', NEW.${c}`).join(', ')}),
         json_object(${columns.map(c => `'${c}', OLD.${c}`).join(', ')}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END;`,

    // DELETE trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_delete
     AFTER DELETE ON ${tableName}
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, old_data, timestamp, device_id)
       VALUES ('${tableName}', OLD.id, 'DELETE',
         json_object(${columns.map(c => `'${c}', OLD.${c}`).join(', ')}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END;`,
  ]
}
```

### 5.3 — Sync Protocol (Desktop ↔ Desktop)

**WebSocket message types:**

```typescript
// packages/sync/src/protocol/messages.ts
type SyncMessage =
  | { type: 'handshake'; deviceId: string; deviceName: string; lastSeq: number }
  | { type: 'handshake_ack'; deviceId: string; lastSeq: number }
  | { type: 'changes'; changes: ChangeEntry[]; batchSeq: number }
  | { type: 'changes_ack'; lastProcessedSeq: number }
  | { type: 'conflict'; conflict: ConflictEntry }
  | { type: 'conflict_resolution'; conflictId: string; resolution: 'local' | 'remote' | 'merged'; data?: any }
  | { type: 'sync_complete' }
  | { type: 'error'; message: string }
```

**Sync flow:**

```
Machine A (initiator)              Machine B (responder)
─────────────────────              ─────────────────────
                    ── handshake ──►
                    ◄── handshake_ack ──

  (A knows B's lastSeq,
   B knows A's lastSeq)

  Query _changes WHERE
  seq > B's lastSeq
                    ── changes (batch 1) ──►
                                            Apply changes
                                            Detect conflicts
                    ◄── changes_ack ──
                    ◄── conflict (if any) ──
  Resolve conflict
                    ── conflict_resolution ──►

                    ◄── changes (B's pending) ──
  Apply changes
                    ── changes_ack ──►

                    ── sync_complete ──►
                    ◄── sync_complete ──
```

### 5.4 — Conflict Resolution

**Strategy per data type:**

| Data type | Strategy | Rationale |
|-----------|----------|-----------|
| **Most fields** | Last-Write-Wins (LWW) per field | Simple, predictable |
| **Stock quantities** | Additive merge | Both warehouses adjust stock independently → sum deltas |
| **Account balances** | Additive merge | Same reasoning as stock |
| **Invoice status** | State machine merge | Status transitions are ordered; take the furthest state |
| **Embedded arrays** | Element-level LWW | Compare by sub-document ID, merge arrays |
| **Counters** (invoice number) | Max + 1 | Take the higher number to avoid duplicates |

```typescript
// packages/sync/src/conflict/resolver.ts
export class ConflictResolver {
  private strategies: Map<string, ConflictStrategy> = new Map()

  constructor() {
    // Register per-table strategies
    this.strategies.set('stock_levels', new AdditiveStrategy(['quantity', 'available_quantity']))
    this.strategies.set('accounts', new AdditiveStrategy(['balance']))
    this.strategies.set('invoices', new StateMachineStrategy('status', INVOICE_STATUS_ORDER))
    // Everything else defaults to LWW
  }

  resolve(tableName: string, local: any, remote: any, localTimestamp: string, remoteTimestamp: string): ResolvedConflict {
    const strategy = this.strategies.get(tableName) || new LWWStrategy()
    return strategy.resolve(local, remote, localTimestamp, remoteTimestamp)
  }
}
```

### 5.5 — MongoDB ↔ SQLite Migration

**Cloud → Desktop (initial setup):**

```typescript
// packages/sync/src/migration/mongo-to-sqlite.ts
export async function migrateMongoToSQLite(
  mongoRepos: RepositoryRegistry,
  sqliteRepos: RepositoryRegistry,
  orgId: string,
  options: { onProgress?: (table: string, count: number, total: number) => void } = {},
): Promise<MigrationResult> {
  const tables = getMigrationOrder()  // Respects FK dependencies
  const idMap = new IdMapper()
  const result: MigrationResult = { tables: {}, totalRows: 0, errors: [] }

  for (const table of tables) {
    const mongoRepo = mongoRepos[table.repoKey]
    const sqliteRepo = sqliteRepos[table.repoKey]

    // Fetch all records for this org from MongoDB
    const { items } = await mongoRepo.findAll({ orgId }, { page: 0, size: 0 })

    for (const item of items) {
      // Map MongoDB ObjectId → SQLite UUID
      const sqliteId = crypto.randomUUID()
      idMap.set(table.name, item.id, sqliteId)

      // Remap all foreign key IDs
      const mapped = idMap.remapEntity(table.name, item)
      mapped.id = sqliteId

      await sqliteRepo.create(mapped)
    }

    result.tables[table.name] = items.length
    result.totalRows += items.length
    options.onProgress?.(table.name, items.length, result.totalRows)
  }

  // Persist ID map for future incremental syncs
  idMap.persistToSQLite(sqliteRepos)

  return result
}
```

**Migration order** (respects FK dependencies):

```typescript
function getMigrationOrder(): TableMeta[] {
  return [
    // Independent tables first
    { name: 'orgs', repoKey: 'orgs' },
    { name: 'users', repoKey: 'users' },
    { name: 'departments', repoKey: 'departments' },
    { name: 'warehouses', repoKey: 'warehouses' },
    { name: 'accounts', repoKey: 'accounts' },
    { name: 'contacts', repoKey: 'contacts' },
    { name: 'products', repoKey: 'products' },
    { name: 'leave_types', repoKey: 'leaveTypes' },
    { name: 'pipelines', repoKey: 'pipelines' },
    { name: 'fiscal_years', repoKey: 'fiscalYears' },
    // Dependent tables
    { name: 'fiscal_periods', repoKey: 'fiscalPeriods' },
    { name: 'employees', repoKey: 'employees' },
    { name: 'stock_levels', repoKey: 'stockLevels' },
    { name: 'bank_accounts', repoKey: 'bankAccounts' },
    { name: 'price_lists', repoKey: 'priceLists' },
    { name: 'bill_of_materials', repoKey: 'billOfMaterials' },
    // Highly dependent tables last
    { name: 'invoices', repoKey: 'invoices' },
    { name: 'journal_entries', repoKey: 'journalEntries' },
    { name: 'stock_movements', repoKey: 'stockMovements' },
    { name: 'payroll_runs', repoKey: 'payrollRuns' },
    { name: 'production_orders', repoKey: 'productionOrders' },
    // ... remaining tables
  ]
}
```

**Desktop → Cloud (reverse migration):**

Same process in reverse, using the persisted `_id_map` table to restore original MongoDB ObjectIds where possible, or generating new ones.

**ID Mapper:**

```typescript
// packages/sync/src/migration/id-mapper.ts
export class IdMapper {
  private map = new Map<string, Map<string, string>>()  // table → mongoId → sqliteId

  set(table: string, mongoId: string, sqliteId: string): void { ... }
  getMongoId(table: string, sqliteId: string): string | undefined { ... }
  getSqliteId(table: string, mongoId: string): string | undefined { ... }

  remapEntity(table: string, entity: any): any {
    // Walk all fields, replace known IDs using the map
    // Handles nested objects and arrays
  }

  persistToSQLite(repos: RepositoryRegistry): void {
    // Save to _id_map table
  }

  loadFromSQLite(db: Database): void {
    // Load from _id_map table
  }
}
```

### 5.6 — LAN Peer Discovery

```typescript
// packages/sync/src/transport/lan-discovery.ts
// Uses mDNS (Bonjour) to discover other LGR instances on the LAN
import { createMDNSService, browseMDNS } from './mdns-wrapper'

export class LANDiscovery {
  private serviceType = '_lgr-sync._tcp'

  async advertise(port: number, deviceName: string): Promise<void> {
    await createMDNSService({
      type: this.serviceType,
      port,
      name: deviceName,
      txt: { version: '1', orgId: '...' },
    })
  }

  async discover(): Promise<Peer[]> {
    const services = await browseMDNS(this.serviceType)
    return services
      .filter(s => s.txt?.orgId === currentOrgId)  // Only discover same org
      .map(s => ({ address: s.address, port: s.port, name: s.name }))
  }
}
```

### 5.7 — Integration Tests: Sync Engine

```
packages/tests/src/sync/
├── change-tracker.test.ts          # Triggers fire correctly, _changes populated
├── sync-protocol.test.ts           # Handshake, delta streaming, ack
├── conflict-lww.test.ts            # Last-write-wins resolution
├── conflict-additive.test.ts       # Additive merge for stock/balances
├── conflict-state-machine.test.ts  # Invoice status transitions
├── mongo-to-sqlite.test.ts         # Full migration with ID remapping
├── sqlite-to-mongo.test.ts         # Reverse migration
├── incremental-sync.test.ts        # Change-based incremental sync
├── id-mapper.test.ts               # Bidirectional ID mapping
├── concurrent-edits.test.ts        # Two machines edit same record
├── network-partition.test.ts       # Sync after disconnection
├── large-dataset.test.ts           # Performance with 10k+ records
└── helpers/
    ├── dual-db-setup.ts            # Create two SQLite DBs for sync testing
    └── mock-ws.ts                  # In-process WebSocket mock
```

**Key sync test scenarios:**

```typescript
// packages/tests/src/sync/concurrent-edits.test.ts
describe('Concurrent Edits', () => {
  test('two machines edit different fields of same invoice → merge both', async () => {
    // Machine A changes invoice.notes
    // Machine B changes invoice.status
    // After sync: both changes present
  })

  test('two machines edit same field of same invoice → LWW wins', async () => {
    // Machine A sets notes="A" at T1
    // Machine B sets notes="B" at T2 (T2 > T1)
    // After sync: notes="B" on both machines
  })

  test('two machines adjust stock in same warehouse → additive merge', async () => {
    // Initial stock: 100
    // Machine A: receipt +20 → local stock 120
    // Machine B: dispatch -10 → local stock 90
    // After sync: stock = 100 + 20 - 10 = 110 on both machines
  })

  test('two machines create invoices → no conflict, both preserved', async () => {
    // Machine A creates INV-001
    // Machine B creates INV-002
    // After sync: both invoices exist on both machines
  })

  test('conflict logged for manual review when resolution is ambiguous', async () => {
    // Machine A voids invoice (status → voided)
    // Machine B records payment (status → paid, adds payment)
    // Conflict logged, admin reviews
  })
})
```

### 5.8 — E2E Tests: Sync

```
packages/e2e/tests/sync/
├── lan-sync.spec.ts                # Two desktop instances sync over LAN
├── initial-migration.spec.ts       # Cloud → Desktop data migration
├── conflict-ui.spec.ts             # Conflict resolver UI flow
└── sync-indicator.spec.ts          # Toolbar sync status updates
```

---

## Phase 6: Archive System

**Goal**: Automatic daily backups + manual archives + selective export + restore.

### 6.1 — Archive Manager (Rust side)

```rust
// src-tauri/src/archive.rs
use std::path::PathBuf;
use zstd::stream::Encoder;

#[tauri::command]
pub fn create_archive(
    db_path: String,
    archive_dir: String,
    name: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(&db_path);
    let dest_dir = PathBuf::from(&archive_dir);

    // Use SQLite backup API for consistent snapshot
    let backup_path = dest_dir.join(format!(
        "{}_{}.db",
        chrono::Local::now().format("%Y-%m-%d_%H%M%S"),
        name.unwrap_or_else(|| "auto".to_string())
    ));

    // SQLite online backup
    let src_conn = rusqlite::Connection::open(&src).map_err(|e| e.to_string())?;
    let mut dst_conn = rusqlite::Connection::open(&backup_path).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(&src_conn, &mut dst_conn).map_err(|e| e.to_string())?;
    backup.run_to_completion(100, std::time::Duration::from_millis(50), None).map_err(|e| e.to_string())?;
    drop(dst_conn);
    drop(src_conn);

    // Compress with zstd
    let compressed_path = format!("{}.zst", backup_path.display());
    let input = std::fs::read(&backup_path).map_err(|e| e.to_string())?;
    let mut encoder = Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
    std::io::copy(&mut input.as_slice(), &mut encoder).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;
    std::fs::write(&compressed_path, compressed).map_err(|e| e.to_string())?;
    std::fs::remove_file(&backup_path).ok(); // Remove uncompressed

    Ok(compressed_path)
}

#[tauri::command]
pub fn restore_archive(archive_path: String, db_path: String) -> Result<(), String> {
    // Decompress zstd → restore SQLite
    // ...
}

#[tauri::command]
pub fn list_archives(archive_dir: String) -> Result<Vec<ArchiveInfo>, String> {
    // List .db.zst files with metadata
    // ...
}
```

### 6.2 — Archive Scheduler

```rust
// src-tauri/src/main.rs
fn setup_archive_scheduler(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Check settings for schedule (default: daily at 02:00)
            let settings = load_settings(&handle);
            if settings.archive.auto_enabled {
                let now = chrono::Local::now();
                let target = /* next scheduled time */;
                let delay = (target - now).to_std().unwrap_or(Duration::from_secs(3600));
                tokio::time::sleep(delay).await;

                if let Err(e) = create_archive(
                    settings.db_path.clone(),
                    settings.archive.directory.clone(),
                    Some("daily".to_string()),
                ) {
                    log::error!("Auto-archive failed: {}", e);
                }

                // Retention: delete archives older than N days
                cleanup_old_archives(&settings.archive).ok();
            } else {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
    });
}
```

### 6.3 — Desktop Settings Model

```typescript
// packages/desktop-api/src/settings.ts
export interface DesktopSettings {
  general: {
    deviceName: string
    dataDirectory: string              // default: ~/LGR/data
    language: string
  }
  sync: {
    enabled: boolean
    mode: 'lan' | 'wan' | 'both'
    autoSync: boolean                   // default: true
    syncIntervalMinutes: number         // default: 5
    manualPeers: { name: string; address: string; port: number }[]
    conflictResolution: 'auto' | 'manual'  // default: 'auto'
  }
  archive: {
    autoEnabled: boolean                // default: true
    scheduleTime: string                // default: '02:00'
    retentionDays: number              // default: 30
    directory: string                   // default: ~/LGR/archives
    includeAttachments: boolean        // default: true
  }
  updates: {
    autoCheck: boolean                  // default: true
    autoInstall: boolean                // default: false
    checkInterval: 'on_start' | 'daily' | 'weekly'  // default: 'on_start'
    channel: 'stable' | 'beta'         // default: 'stable'
  }
}
```

### 6.4 — Integration Tests: Archive

```typescript
// packages/tests/src/archive/
describe('Archive System', () => {
  test('creates compressed archive from active DB', () => { ... })
  test('archive is a valid SQLite database after decompression', () => { ... })
  test('restore replaces active DB without corruption', () => { ... })
  test('selective export filters by date range', () => { ... })
  test('retention policy deletes archives older than N days', () => { ... })
  test('archive during active writes produces consistent snapshot', () => { ... })
})
```

---

## Phase 7: Documentation

### 7.1 — Documentation Structure

```
docs/
├── architecture/
│   ├── overview.md                  # System architecture (cloud + desktop)
│   ├── dal.md                       # Data Abstraction Layer design
│   ├── sync.md                      # Sync protocol specification
│   └── desktop.md                   # Desktop app architecture
├── models/
│   ├── README.md                    # Model index with links
│   ├── core/                        # Core entity docs
│   │   ├── org.md                   # Org: MongoDB schema + SQLite DDL + field descriptions
│   │   ├── user.md
│   │   └── ...
│   ├── accounting/
│   │   ├── account.md
│   │   ├── journal-entry.md
│   │   └── ...
│   ├── invoicing/
│   ├── warehouse/
│   ├── payroll/
│   ├── hr/
│   ├── crm/
│   └── erp/
├── guides/
│   ├── cloud-setup.md              # Deploying cloud version
│   ├── desktop-install.md          # Installing desktop app
│   ├── cloud-to-desktop.md         # Migrating from cloud → desktop
│   ├── desktop-to-cloud.md         # Migrating from desktop → cloud
│   ├── sync-setup.md               # Setting up multi-machine sync
│   ├── archive-management.md       # Backup & restore guide
│   └── auto-updates.md             # Configuring auto-updates
├── api/
│   ├── cloud-api.md                # Cloud API reference (8 services)
│   └── desktop-api.md              # Desktop API reference (unified)
└── development/
    ├── contributing.md              # Development setup guide
    ├── testing.md                   # Test strategy (parity tests, sync tests)
    └── releasing.md                 # Release process (cloud + desktop)
```

### 7.2 — Model Documentation Format

Each model doc includes:

```markdown
# Invoice

## Entity Interface
(TypeScript interface from packages/dal/src/entities/invoicing.ts)

## MongoDB Schema
(Mongoose schema with indexes from packages/db/src/models/invoice.model.ts)

## SQLite Schema
(CREATE TABLE + child tables from packages/dal-sqlite/src/schema/invoicing.schema.ts)

## Field Reference
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | auto | UUID/ObjectId | ... |
| orgId | string | yes | - | Tenant ID |
| ... |

## Indexes
| Name | Fields | Type | Notes |
|------|--------|------|-------|
| Primary | id | Unique | ... |
| orgId_invoiceNumber | orgId, invoiceNumber | Unique | ... |

## Relationships
- belongsTo Contact (contactId)
- hasMany InvoiceLine (embedded in Mongo, child table in SQLite)
- hasMany InvoicePayment (embedded in Mongo, child table in SQLite)
- belongsTo JournalEntry (journalEntryId, optional)

## API Endpoints
- GET /api/org/:orgId/invoicing/invoices
- POST /api/org/:orgId/invoicing/invoices
- GET /api/org/:orgId/invoicing/invoices/:id
- PUT /api/org/:orgId/invoicing/invoices/:id
- DELETE /api/org/:orgId/invoicing/invoices/:id
```

---

## Implementation Order & Dependencies

```
Phase 0: DAL Foundation ──────────────────────────── [Weeks 1-4]
  ├── 0.1 Core DAL types                             [Week 1]
  ├── 0.2 Extract entity interfaces (48 entities)     [Week 1-2]
  ├── 0.3 MongoDB repository implementation            [Week 2-3]
  ├── 0.4 SQLite schema + repository implementation    [Week 2-3]
  ├── 0.5 Refactor services to use DAL                 [Week 3-4]
  ├── 0.6 Runtime mode detection                       [Week 1]
  └── 0.7 DAL parity tests (~200 tests)               [Week 3-4]

Phase 1: SQLite Schema + Migrations ──────────────── [Week 2-3]
  ├── 1.1 Schema definitions (~78 tables)              [Week 2]
  ├── 1.2 Migration system                             [Week 2]
  ├── 1.3 SQLite connection manager                    [Week 2]
  └── 1.4 Schema tests                                 [Week 3]

Phase 2: Desktop API ────────────────────────────── [Week 4-5]
  ├── 2.1 Package structure                            [Week 4]
  ├── 2.2 Unified router                               [Week 4]
  ├── 2.3 Desktop auth                                 [Week 4]
  ├── 2.4 First-run wizard                             [Week 5]
  └── 2.5 Desktop API tests                            [Week 5]

Phase 3: Desktop UI ─────────────────────────────── [Week 5-6]
  ├── 3.1 Package structure                            [Week 5]
  ├── 3.2 Desktop-specific views                       [Week 5-6]
  └── 3.3 Desktop UI E2E tests                         [Week 6]

Phase 4: Tauri Shell ─────────────────────────────── [Week 6-8]
  ├── 4.1 Tauri project setup                          [Week 6]
  ├── 4.2 Bun sidecar                                  [Week 6-7]
  ├── 4.3 Auto-updater                                 [Week 7]
  ├── 4.4 Installer config                             [Week 7]
  ├── 4.5 CI/CD pipeline                               [Week 8]
  └── 4.6 Desktop app E2E tests                        [Week 8]

Phase 5: Sync Engine ─────────────────────────────── [Week 7-10]
  ├── 5.1 Change tracking (triggers)                   [Week 7]
  ├── 5.2 Sync protocol (WebSocket)                    [Week 7-8]
  ├── 5.3 Conflict resolution                          [Week 8-9]
  ├── 5.4 MongoDB ↔ SQLite migration                  [Week 9]
  ├── 5.5 LAN peer discovery                           [Week 9]
  ├── 5.6 Sync integration tests                       [Week 9-10]
  └── 5.7 Sync E2E tests                               [Week 10]

Phase 6: Archive System ──────────────────────────── [Week 9-10]
  ├── 6.1 Archive manager (Rust)                       [Week 9]
  ├── 6.2 Archive scheduler                            [Week 9]
  ├── 6.3 Desktop settings                             [Week 9]
  └── 6.4 Archive tests                                [Week 10]

Phase 7: Documentation ──────────────────────────── [Week 10-11]
  ├── 7.1 Architecture docs                            [Week 10]
  ├── 7.2 Model docs (48 entities)                     [Week 10-11]
  └── 7.3 User guides                                  [Week 11]
```

**Critical path**: Phase 0 → Phase 1 → Phase 2 → Phase 4
**Parallelizable**: Phase 3 || Phase 5 || Phase 6 (after Phase 1 completes)

---

## Test Summary

| Test Suite | Count (est.) | Backend | Coverage |
|-----------|-------------|---------|----------|
| DAL parity tests (Mongo + SQLite) | ~200 | Both | All 48 entities CRUD + edge cases |
| Service tests (via DAL) | ~100 | Both | All business logic |
| Desktop API tests | ~30 | SQLite | Auth, routing, first-run |
| Sync: change tracking | ~20 | SQLite | Triggers for all tables |
| Sync: protocol | ~15 | SQLite | Handshake, delta, ack |
| Sync: conflict resolution | ~20 | SQLite | LWW, additive, state machine |
| Sync: migration | ~15 | Both | Mongo→SQLite, SQLite→Mongo |
| Sync: concurrent edits | ~10 | SQLite | Multi-machine scenarios |
| Archive tests | ~10 | SQLite | Backup, restore, retention |
| Desktop E2E | ~15 | SQLite | Full desktop workflows |
| Sync E2E | ~5 | SQLite | LAN sync, conflict UI |
| **Total** | **~440** | | |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| DAL abstraction incomplete — some Mongoose patterns don't translate | **HIGH** | Parity tests catch gaps early; start with simplest entities |
| SQLite schema for 78 tables (48 parent + 30 child) has FK errors | **HIGH** | Auto-validate FK integrity in schema tests; use migration runner |
| Aggregation pipeline (product-ledger) SQL translation is complex | **MEDIUM** | Hand-write the SQL equivalent; validate with identical test data |
| Tauri + Bun sidecar fails on Windows | **MEDIUM** | Test early on Windows CI; have Electron fallback plan |
| Sync conflict resolution loses data | **HIGH** | Log ALL conflicts; default to manual review for ambiguous cases |
| mDNS discovery blocked by corporate firewalls | **MEDIUM** | Manual peer IP entry as fallback |
| SQLite performance degrades with >100k rows per table | **LOW** | Index coverage + WAL mode; benchmark with realistic data |
| Auto-updater code signing costs money per platform | **LOW** | Free for open-source (Apple Developer Program exception, signtool is free) |

---

**WAITING FOR CONFIRMATION**: Proceed with this plan? (yes / no / modify)
