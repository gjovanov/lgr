# Performance Patterns — LGR

### N+1 Query Pattern in Service Loops — discovered 2026-03-10
**Symptom:** Sequential `findById()` or `findOne()` calls inside `for` loops
**Root cause:** Service functions iterate over line items and query DB for each one
**Fix applied:**
- `accounting.service.ts`: Batch load all accounts with `Promise.all(accountIds.map(...))` before loop
- `invoicing.service.ts`: Batch load stock levels with `findMany({ $in: productIds })`, then use Map for O(1) lookup
**Test added:** Existing tests in `accounting.flow.test.ts` and `product-ledger.flow.test.ts` verify correctness
**Recurrence prevention:** When writing service functions that process line items, always batch-load referenced entities before the loop

### BaseDao Missing .lean() — discovered 2026-03-10
**Symptom:** All DAO read queries return full Mongoose documents with change tracking overhead
**Root cause:** `BaseDao.findById()`, `findOne()`, `findAll()` never call `.lean()`
**Status:** OPEN — requires careful migration since downstream code may rely on document methods
**Recurrence prevention:** New custom DAO queries for read-only use should include `.lean()`

### Compact DAO Controller Pattern — discovered 2026-03-10
**Symptom:** 18 controllers accept any JSON body without validation
**Root cause:** Compact controller scaffold passes `body` directly to `dao.create()`/`dao.update()` without `t.Object()` schema
**Status:** OPEN — each controller needs proper Elysia type schemas added
**Recurrence prevention:** Always add `body: t.Object({...})` schema to POST/PUT routes
