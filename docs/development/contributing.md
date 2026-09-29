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
  db/           Mongoose models (cloud only)
  services/     Business logic
  *-api/        Elysia controllers per module
  *-ui/         Vue 3 frontends per module
  desktop-ui/   The desktop shell's own pages
  desktop/      Tauri shell (Rust) - opens the cloud app
  tests/        Integration tests
  e2e/          Playwright E2E tests
```

## Adding a New Entity

1. **Define interface** in `packages/dal/src/entities/<module>.ts`
2. **Add to registry** in `packages/dal/src/registry.ts`
3. **Create Mongoose model** in `packages/db/src/models/`
4. **Implement MongoDB repo** in `packages/dal-mongo/src/repositories/`
5. **Register in the factory** (`dal-mongo/src/index.ts`)
6. **Write a repository test** in `packages/tests/src/dal/repos/`
7. **Create controller** in `packages/<module>-api/src/controllers/`

## Code Conventions

- **TypeScript** with strict mode
- **camelCase** throughout
- **ESM** modules (`"type": "module"` everywhere)
- **No Mongoose imports** in `services/` or `dal/` — only in `dal-mongo/` and `db/`
- **Test through the DAL interface** - add a repository test for a new entity

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
