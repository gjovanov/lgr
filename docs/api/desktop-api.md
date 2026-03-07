# Desktop API Reference

The Desktop API runs on port 4080 (localhost only) and serves all modules in a single process.

## Desktop-Specific Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with orgSlug, username, password |
| POST | `/api/auth/logout` | Clear auth cookie |
| GET | `/api/auth/me` | Get current user profile |

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get all desktop settings |
| PUT | `/api/settings` | Update all settings |
| PATCH | `/api/settings/:section` | Update a settings section (general, sync, archive, updates) |

## Domain Endpoints

All domain endpoints are identical to the cloud APIs, mounted under `/api/org/:orgId/`:

- `/api/org/:orgId/accounting/*` — 10 controllers
- `/api/org/:orgId/invoicing/*` — 4 controllers
- `/api/org/:orgId/warehouse/*` — 7 controllers
- `/api/org/:orgId/payroll/*` — 4 controllers
- `/api/org/:orgId/hr/*` — 6 controllers
- `/api/org/:orgId/crm/*` — 4 controllers
- `/api/org/:orgId/erp/*` — 4 controllers

See [cloud-api.md](cloud-api.md) for the full endpoint list — all endpoints work identically on desktop.

## Swagger

Interactive API docs available at `http://127.0.0.1:4080/swagger` when running in development.

## Differences from Cloud

| Aspect | Cloud | Desktop |
|--------|-------|---------|
| Auth | JWT issued by Portal | JWT issued locally by DesktopAuthService |
| Database | MongoDB | SQLite (bun:sqlite) |
| Process | 8 separate APIs | 1 unified API |
| Port | 4001-4070 | 4080 |
| Hostname | 0.0.0.0 | 127.0.0.1 (localhost only) |
| Settings | Per-org in DB | Local settings.json |
| OAuth | Supported | Not available |
