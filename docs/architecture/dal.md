# Data Abstraction Layer (DAL)

## Purpose

The DAL decouples business logic from storage backends. Services import repository interfaces from `packages/dal` and never reference Mongoose or bun:sqlite directly.

## Packages

| Package | Role | Dependencies |
|---------|------|-------------|
| `dal` | Interfaces, types, entity definitions | `config` |
| `dal-mongo` | MongoDB/Mongoose repository implementations | `dal`, `db` |
| `dal-sqlite` | SQLite repository implementations (`bun:sqlite`) | `dal`, `config` |

## Core Types

### Repository Interface

```typescript
interface IRepository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>
  findAll(filter: Filter<T>, page: PageRequest): Promise<PageResult<T>>
  findOne(filter: Filter<T>): Promise<T | null>
  create(data: Partial<T>): Promise<T>
  update(id: string, data: Partial<T>): Promise<T | null>
  delete(id: string): Promise<boolean>
  count(filter: Filter<T>): Promise<number>
}

interface IBatchRepository<T extends BaseEntity> extends IRepository<T> {
  createMany(data: Partial<T>[]): Promise<T[]>
  updateMany(filter: Filter<T>, data: Partial<T>): Promise<number>
  deleteMany(filter: Filter<T>): Promise<number>
}
```

### RepositoryRegistry

All 48 entity repositories in a single typed object:

```typescript
interface RepositoryRegistry {
  orgs: IBatchRepository<IOrg>
  users: IBatchRepository<IUser>
  accounts: IBatchRepository<IAccount>
  invoices: IBatchRepository<IInvoice>
  products: IBatchRepository<IProduct>
  // ... 43 more
}
```

### Filter System

```typescript
type Filter<T> = {
  [K in keyof T]?: T[K] | FilterOperator<T[K]>
}

interface FilterOperator<V> {
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
}
```

## Entity Mapping

### MongoDB (`dal-mongo`)
- `_id` (ObjectId) ↔ `id` (string)
- camelCase fields match Mongoose schemas directly
- Embedded arrays stored as sub-documents

### SQLite (`dal-sqlite`)
- `id` (TEXT PRIMARY KEY, UUID)
- camelCase ↔ snake_case conversion in entity mapper
- Embedded arrays → child tables (e.g., `invoice_lines`, `journal_entry_lines`)
- JSON columns for small embedded objects (settings, addresses)
- Boolean: `is_active` INTEGER (0/1) ↔ `isActive` boolean

## Usage in Services

```typescript
// packages/services/src/biz/warehouse.service.ts
import type { RepositoryRegistry } from 'dal'

export function createWarehouseService(repos: RepositoryRegistry) {
  return {
    async adjustStock(orgId: string, productId: string, warehouseId: string, qty: number) {
      const level = await repos.stockLevels.findOne({ orgId, productId, warehouseId })
      if (!level) throw new Error('Stock level not found')
      return repos.stockLevels.update(level.id, {
        quantity: level.quantity + qty,
        availableQuantity: level.availableQuantity + qty,
      })
    },
  }
}
```

## Initialization

```typescript
// Cloud
import { createMongoRepositories } from 'dal-mongo'
const repos = await createMongoRepositories({ backend: 'mongo' })

// Desktop
import { createSQLiteRepositories } from 'dal-sqlite'
const repos = await createSQLiteRepositories({ backend: 'sqlite', sqlitePath: './lgr.db' })
```

## Parity Tests

132 tests across 9 entity files ensure both backends produce identical results:

```bash
bun test packages/tests/src/dal/parity/ --env-file=.env.test --timeout 120000
```
