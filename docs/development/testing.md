# Testing Strategy

## Test Pyramid

```
         ┌──────────┐
         │   E2E    │  Playwright (browser)
         │  ~30     │
        ┌┴──────────┴┐
        │ Integration │  Bun test (mongodb-memory-server + SQLite)
        │  ~750+      │
       ┌┴─────────────┴┐
       │  DAL Parity    │  Same tests × 2 backends
       │  132 (×2=264)  │
       └────────────────┘
```

## DAL Parity Tests

Ensure MongoDB and SQLite produce identical results for all CRUD operations.

```bash
bun test packages/tests/src/dal/parity/ --env-file=.env.test --timeout 120000
```

**Location**: `packages/tests/src/dal/parity/`

**Pattern**: Each test file runs against both backends:

```typescript
const backends: [string, () => Promise<RepositoryRegistry>][] = [
  ['mongo', setupMongoRepos],
  ['sqlite', setupSQLiteRepos],
]

for (const [name, setup] of backends) {
  describe(`Invoice [${name}]`, () => {
    // tests run identically on both
  })
}
```

**Current coverage**: 9 entity files, 132 tests, 502 assertions.

## Integration Tests

Business logic and service tests using real databases.

```bash
bun run test                    # All tests
bun test packages/tests/src/integration/auth.flow.test.ts  # Single file
```

**Setup**: `mongodb-memory-server` for isolated MongoDB per run.

## E2E Tests

Playwright browser tests against running APIs.

```bash
bun run test:e2e                # All E2E
cd packages/e2e && bunx playwright test tests/warehouse.spec.ts  # Single
```

**Vuetify selectors**: Use `getByRole('combobox', { name: /label/i })` for v-select (not `getByLabel`).

## Sync Tests (Planned)

```
packages/tests/src/sync/
├── change-tracker.test.ts     Trigger → _changes verification
├── conflict-lww.test.ts       Last-write-wins per field
├── conflict-additive.test.ts  Stock/balance delta merging
├── conflict-state-machine.test.ts  Status transition ordering
├── mongo-to-sqlite.test.ts    Full migration with ID remapping
├── sqlite-to-mongo.test.ts    Reverse migration
├── concurrent-edits.test.ts   Two-machine conflict scenarios
└── id-mapper.test.ts          Bidirectional ID mapping
```

## Writing Tests

### Parity Test Template

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { setupMongoRepos, setupSQLiteRepos, teardown } from '../helpers/dal-test-setup'
import { fakeObjectId } from '../helpers/dal-test-setup'

const backends = [['mongo', setupMongoRepos], ['sqlite', setupSQLiteRepos]] as const

for (const [name, setup] of backends) {
  describe(`MyEntity [${name}]`, () => {
    let repos: RepositoryRegistry

    beforeAll(async () => { repos = await setup() })
    afterAll(teardown)

    test('creates and retrieves', async () => {
      const created = await repos.myEntities.create({ orgId: fakeObjectId(), ... })
      expect(created.id).toBeDefined()
      const found = await repos.myEntities.findById(created.id)
      expect(found).toEqual(created)
    })
  })
}
```
