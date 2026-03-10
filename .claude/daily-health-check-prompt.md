# DAILY AUTOMATED HEALTH CHECK — LGR ERP

Run date: {{ date +"%Y-%m-%d %H:%M:%S %Z" }}

You are an autonomous senior full-stack engineer performing a scheduled daily
health check on the LGR application. You have full permissions to read, write,
run commands, fix bugs, write tests, and commit changes.

Execute every action without asking for confirmation. Think step by step,
log your reasoning, and produce a structured final report.

## Configuration

- **App repo**: /home/gjovanov/lgr
- **Deploy repo**: https://github.com/gjovanov/lgr-deploy (clone to /tmp/lgr-deploy)
- **Production URL**: https://lgrai.app
- **Test credentials**: acme-corp / admin / test123

═══════════════════════════════════════════════════════════════════════════════
## PHASE 0 — SELF-ORIENTATION
═══════════════════════════════════════════════════════════════════════════════

1. Read CLAUDE.md — extract known issues, last health check, architecture decisions.
2. Read .claude/skills/ if it exists — load domain-specific patterns.
3. Run: `git log --oneline -20` — identify changes since last health check.
4. Run: `git stash list` — stash any uncommitted work before proceeding.

Print an ORIENTATION SUMMARY with stack versions, last health check date,
key recent changes, and risk areas.

═══════════════════════════════════════════════════════════════════════════════
## PHASE 1 — ENVIRONMENT & DEPENDENCY AUDIT
═══════════════════════════════════════════════════════════════════════════════

a) Check outdated deps: `bun outdated 2>&1 | head -40`
b) Check vulnerabilities: `bun audit 2>&1 | head -40`
c) Check Rust deps if Cargo.toml exists: `cd packages/desktop/src-tauri && cargo audit`
d) Scan for TODO/FIXME/HACK/SECURITY comments in *.ts and *.vue files
e) Scan for hardcoded secrets in *.ts, *.vue, *.env* files
f) Check Dockerfile base image version against pinned version in CLAUDE.md

Severity guide:
- CRITICAL: Known HIGH/CRITICAL CVE, hardcoded secrets
- HIGH: Dependency >2 major versions behind
- MEDIUM: Stale TODOs (>30 days via git blame)
- LOW: Minor version updates available

═══════════════════════════════════════════════════════════════════════════════
## PHASE 2 — STATIC ANALYSIS & TYPE SAFETY
═══════════════════════════════════════════════════════════════════════════════

a) Build all UIs: `bun run build:ui` (TypeScript + Vite)
b) Scan Elysia controllers for missing `isSignIn` auth, missing body schemas
c) Scan for N+1 query patterns (await inside for/forEach/map loops in services)
d) Scan for missing `.lean()` on read-only Mongoose queries
e) Scan Vue SFCs for unhandled async errors, v-for without :key

Severity guide:
- CRITICAL: Type errors, missing auth on sensitive routes
- HIGH: N+1 queries, missing input validation
- MEDIUM: Missing indexes, v-for without stable key

═══════════════════════════════════════════════════════════════════════════════
## PHASE 3 — INTEGRATION TESTS (localhost)
═══════════════════════════════════════════════════════════════════════════════

1. Ensure MongoDB is running: `docker compose up -d`
2. Run integration tests: `bun run test`
3. Collect: total passed/failed/skipped, failure details, slowest tests
4. Identify flaky tests (external API dependencies like VerifyVAT)

═══════════════════════════════════════════════════════════════════════════════
## PHASE 4 — DEPLOYED E2E TESTS (lgrai.app)
═══════════════════════════════════════════════════════════════════════════════

This phase tests the LIVE deployed application at https://lgrai.app.

### STEP 4A — Verify deployment health

```bash
# Health check
curl -sf https://lgrai.app/api/health

# Verify login works
curl -sf -X POST https://lgrai.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"orgSlug":"acme-corp","username":"admin","password":"test123"}'
```

If health check fails, report as CRITICAL and skip remaining E2E steps.

### STEP 4B — Seed test data (optional, if data is stale)

Run the API-based seed script from the deploy repo:
```bash
cd /tmp/lgr-deploy
./scripts/seed-via-api.sh https://lgrai.app
```

This creates E2E-prefixed test data in all modules:
- Warehouse: 1 warehouse + 3 products
- Invoicing: 2 contacts
- Accounting: 1 journal entry
- HR: 1 department
- CRM: 1 lead

### STEP 4C — Run Playwright E2E tests against deployed version

```bash
PW_CLI="/home/gjovanov/lgr/node_modules/.bun/playwright@1.58.2/node_modules/playwright/cli.js"

# Install browsers if needed
node "$PW_CLI" install chromium --with-deps

# Run all E2E tests against lgrai.app
cd /home/gjovanov/lgr/packages/e2e
CI=true BASE_URL=https://lgrai.app node "$PW_CLI" test \
  --config=playwright.config.ts \
  --reporter=list \
  --workers=2
```

Collect results:
- Total tests: passed / failed / skipped per project (portal, accounting, etc.)
- Screenshot artifacts for failures
- Timing per test suite

### STEP 4D — Cleanup test data

```bash
cd /tmp/lgr-deploy
./scripts/cleanup-e2e-data.sh --all https://lgrai.app
```

This removes all records with "E2E-" prefixed names across all modules.

### STEP 4E — Verify API endpoints per module

For each module, verify at least one list endpoint returns data:
```bash
TOKEN=$(curl -sf -X POST https://lgrai.app/api/auth/login ...)
ORG_ID=<from login response>

# Accounting
curl -sf "https://lgrai.app/api/org/$ORG_ID/accounting/account" -H "Authorization: Bearer $TOKEN"

# Invoicing
curl -sf "https://lgrai.app/api/org/$ORG_ID/invoicing/contact" -H "Authorization: Bearer $TOKEN"

# Warehouse
curl -sf "https://lgrai.app/api/org/$ORG_ID/warehouse/product" -H "Authorization: Bearer $TOKEN"

# Payroll
curl -sf "https://lgrai.app/api/org/$ORG_ID/payroll/employee" -H "Authorization: Bearer $TOKEN"

# HR
curl -sf "https://lgrai.app/api/org/$ORG_ID/hr/department" -H "Authorization: Bearer $TOKEN"

# CRM
curl -sf "https://lgrai.app/api/org/$ORG_ID/crm/lead" -H "Authorization: Bearer $TOKEN"

# ERP
curl -sf "https://lgrai.app/api/org/$ORG_ID/erp/bom" -H "Authorization: Bearer $TOKEN"
```

Each endpoint must return HTTP 200 with valid JSON containing a `total` field.
Flag as CRITICAL if any module's API is unreachable (502/503/504).

═══════════════════════════════════════════════════════════════════════════════
## PHASE 5 — BUG TRIAGE & AUTO-FIX
═══════════════════════════════════════════════════════════════════════════════

Compile ALL issues from Phases 1–4 into a prioritized list.

AUTO-FIX DECISION TREE:
- Isolated fix < 50 lines → Fix now, run tests, commit
- Requires DB migration → Generate migration script, test on copy
- Changes public API → Check all callers, update them

For each fix:
1. Run the specific module's test suite
2. Run full test suite for regression check
3. Commit: `fix([module]): [description] — resolves health-check [date]`

For unfixed issues: log in CLAUDE.md under "## Known Issues"

═══════════════════════════════════════════════════════════════════════════════
## PHASE 6 — LEARNING & MEMORY UPDATE
═══════════════════════════════════════════════════════════════════════════════

Update CLAUDE.md with:
- `## Last Health Check` — date, result, summary
- `## Known Issues` — append new, mark resolved old
- `## Architecture Decisions Log` — if new decisions were made

Update `.claude/skills/` files:
- `performance-patterns.md` — new optimizations discovered
- `security-patterns.md` — new security findings
- `bug-patterns.md` — new bug patterns fixed

Commit: `docs(claude): health-check learnings [date]`

═══════════════════════════════════════════════════════════════════════════════
## PHASE 7 — FINAL REPORT
═══════════════════════════════════════════════════════════════════════════════

Print structured report:

```
╔══════════════════════════════════════════════════════════════════════════════╗
║           DAILY HEALTH CHECK REPORT — {date}                               ║
╠══════════════════════════════════════════════════════════════════════════════╣
║ OVERALL STATUS: HEALTHY | DEGRADED | CRITICAL                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

## ISSUES FOUND
### CRITICAL ({n})
### HIGH ({n})
### MEDIUM ({n})
### LOW ({n})

## INTEGRATION TEST RESULTS (localhost)
- Total: {n} passed / {n} failed / {n} skipped
- Duration: {n}s

## E2E TEST RESULTS (lgrai.app)
- Portal: {n}/{n} passed
- Accounting: {n}/{n} passed
- Invoicing: {n}/{n} passed
- Warehouse: {n}/{n} passed
- Payroll: {n}/{n} passed
- HR: {n}/{n} passed
- CRM: {n}/{n} passed
- ERP: {n}/{n} passed
- Total: {n} passed / {n} failed

## API ENDPOINT HEALTH (lgrai.app)
- Accounting: {status} ({records} records)
- Invoicing: {status} ({records} records)
- Warehouse: {status} ({records} records)
- Payroll: {status} ({records} records)
- HR: {status} ({records} records)
- CRM: {status} ({records} records)
- ERP: {status} ({records} records)

## FIXES APPLIED
[List of fixes with commit hashes]

## NEXT RUN FOCUS
1. [area 1]
2. [area 2]
3. [area 3]
```
