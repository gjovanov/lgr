# Contributing Guide

## Development Setup

```bash
# Prerequisites
# - Bun v1.1+ (https://bun.sh)
# - Docker (for MongoDB)
# - Rust toolchain (for Tauri desktop builds only)

git clone <repo> && cd lgr
bun install
docker compose up -d        # MongoDB on port 27018
cp .env.example .env
bun run seed                # Seed demo data
bun run dev                 # All 8 cloud apps
```

## Project Structure

```
packages/
  config/       Shared config + constants
  dal/          Repository interfaces (touch for new entities)
  dal-mongo/    MongoDB implementations
  dal-sqlite/   SQLite implementations
  db/           Mongoose models (cloud only)
  services/     Business logic
  *-api/        Elysia controllers per module
  *-ui/         Vue 3 frontends per module
  desktop-api/  Unified desktop API
  desktop-ui/   Unified desktop frontend
  desktop/      Tauri shell (Rust)
  sync/         Sync engine
  tests/        Integration tests
  e2e/          Playwright E2E tests
```

## Adding a New Entity

1. **Define interface** in `packages/dal/src/entities/<module>.ts`
2. **Add to registry** in `packages/dal/src/registry.ts`
3. **Create Mongoose model** in `packages/db/src/models/`
4. **Implement MongoDB repo** in `packages/dal-mongo/src/repositories/`
5. **Add SQLite schema** in `packages/dal-sqlite/src/schema/<module>.schema.ts`
6. **Implement SQLite repo** in `packages/dal-sqlite/src/repositories/`
7. **Register in factories** (`dal-mongo/src/index.ts`, `dal-sqlite/src/index.ts`)
8. **Add table to sync registry** in `packages/sync/src/change-tracker/table-registry.ts`
9. **Write parity test** in `packages/tests/src/dal/parity/`
10. **Create controller** in `packages/<module>-api/src/controllers/`
11. **Add to desktop-api** imports if needed

## Code Conventions

- **TypeScript** with strict mode
- **camelCase** for code, **snake_case** for SQLite columns
- **ESM** modules (`"type": "module"` everywhere)
- **No Mongoose imports** in `services/` or `dal/` — only in `dal-mongo/` and `db/`
- **No bun:sqlite imports** outside `dal-sqlite/` and `sync/`
- **Test both backends** — always write parity tests for new entities

## Branching

- `master` — stable, deployable
- Feature branches: `feature/<name>`
- Bug fixes: `fix/<name>`

## Testing

```bash
bun run test                 # All integration tests
bun test packages/tests/src/dal/parity/  # DAL parity only
bun run test:e2e             # All Playwright E2E
```
