# Migrating from Desktop to Cloud

> ⚠ **Superseded.** This page describes the 2026-03 desktop prototype (desktop v0.1.x,
> `packages/sync`). It is kept only until the revival replaces it: the revived desktop is
> specified by [FR-14 … FR-18](../fr/README.md#lgr-desktop), and its sync architecture is
> [`sync.md`](../architecture/sync.md). Do not follow the instructions below on a production machine.
> Among other things, the prototype ships a published default login and signs local tokens
> with a committed secret (FR-14 §1.2).

## Overview

Export your organization's data from SQLite (desktop) back to MongoDB (cloud). Uses the persisted `_id_map` to restore original MongoDB ObjectIds where possible.

## Migration Process

```typescript
import { createMongoRepositories } from 'dal-mongo'
import { createSQLiteRepositories } from 'dal-sqlite'
import { migrateSQLiteToMongo } from 'sync'
import { getDatabase } from 'dal-sqlite'

const sqliteRepos = await createSQLiteRepositories({ backend: 'sqlite', sqlitePath: './lgr.db' })
const mongoRepos = await createMongoRepositories({ backend: 'mongo' })
const db = getDatabase()

const result = await migrateSQLiteToMongo(sqliteRepos, mongoRepos, 'your-org-id', db, {
  onProgress: (table, count, total) => {
    console.log(`Migrated ${table}: ${count} rows (total: ${total})`)
  },
})
```

## ID Restoration

- Records that were originally migrated from cloud have their original ObjectIds restored
- Records created on desktop get new 24-character hex IDs (MongoDB ObjectId format)
- The updated ID map is persisted back to SQLite for future migrations

## Considerations

- **Deduplicate** before migration if the cloud already has data
- **Back up** both databases before starting
- Review `result.errors` for any failed records
