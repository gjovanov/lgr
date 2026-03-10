# Security Patterns — LGR

### Live Secret in Tracked Test Config — discovered 2026-03-10
**Symptom:** `.env.test` contained `VERIFYVAT_TOKEN=sk_live_...` (a live API key)
**Root cause:** Developer copied value from `.env` (gitignored) to `.env.test` (tracked)
**Fix applied:** Replaced with `test-token` placeholder
**Recurrence prevention:** Review `.env.test` diffs before commit; never use `sk_live_*` prefixed values in tracked files

### Missing Input Validation on POST/PUT Routes — discovered 2026-03-10
**Symptom:** 18 controllers accept arbitrary JSON bodies
**Root cause:** Compact DAO controller scaffold skipped `body: t.Object()` schema definition
**Status:** OPEN
**Impact:** Arbitrary field injection possible (e.g., setting `role: 'admin'` or `orgId` to another tenant)
**Recurrence prevention:** All POST/PUT routes must have explicit `body` schema with Elysia `t.Object()`
