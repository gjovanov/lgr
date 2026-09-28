# Migrating from Cloud to Desktop

> ⚠ **Retired.** This page describes the 2026-03 desktop prototype's local mode: the
> `desktop-api` sidecar, SQLite and `packages/sync`. On 2026-09-28 local mode was dropped.
> LGR Desktop is now a server-mode client only, specified by [FR-14](../fr/FR-14-lgr-desktop-app-server-mode.md).
> This page is deleted together with the prototype code (FR-14.34). Do not follow the instructions below. Among other things, the prototype ships
> a published default login and signs local tokens with a committed secret.

## Overview

Export your organization's data from MongoDB (cloud) to SQLite (desktop). All records, relationships, and IDs are preserved via a bidirectional ID map.

## Prerequisites

- Access to both cloud MongoDB and desktop SQLite
- The `sync` package installed

## Migration Process

### Programmatic

```typescript
import { createMongoRepositories } from 'dal-mongo'
import { createSQLiteRepositories } from 'dal-sqlite'
import { migrateMongoToSQLite } from 'sync'

const mongoRepos = await createMongoRepositories({ backend: 'mongo' })
const sqliteRepos = await createSQLiteRepositories({ backend: 'sqlite', sqlitePath: './lgr.db' })

const result = await migrateMongoToSQLite(mongoRepos, sqliteRepos, 'your-org-id', {
  onProgress: (table, count, total) => {
    console.log(`Migrated ${table}: ${count} rows (total: ${total})`)
  },
})

console.log(`Migration complete: ${result.totalRows} rows across ${Object.keys(result.tables).length} tables`)
if (result.errors.length > 0) {
  console.warn('Errors:', result.errors)
}
```

### What Gets Migrated

All 48 entity types in FK dependency order:
1. Independent: orgs, users, departments, warehouses, accounts, contacts, products...
2. First-level: fiscal periods, employees, stock levels, bank accounts...
3. Dependent: invoices, journal entries, stock movements, payroll runs...

### ID Mapping

- Each MongoDB ObjectId gets a new UUID for SQLite
- All foreign key references are remapped consistently
- The mapping is persisted in the `_id_map` table for reverse migration

### What to Verify After Migration

1. Record counts match between source and destination
2. Financial totals (account balances, invoice totals) are consistent
3. Embedded arrays (invoice lines, journal entry lines) are present
4. Login with your credentials works on the desktop app
