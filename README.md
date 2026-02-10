# LGR (Ledger)

Multi-tenant ERP system built as a Bun monorepo with Elysia.js, MongoDB, Vue 3, and Vuetify 3.

## Features

- **7 ERP Modules** — Accounting, Invoicing, Warehouse, Payroll, HR, CRM, ERP (Manufacturing + POS)
- **Multi-Tenancy** — Organization-based data isolation with automatic `orgId` scoping
- **Role-Based Access** — 7 roles (admin, manager, accountant, hr_manager, warehouse_manager, sales, member) with 20 granular permissions
- **48 Data Models** — Comprehensive business entities with full CRUD and workflow operations
- **Excel & PDF Export** — Financial reports, invoices, payslips via ExcelJS and md-to-pdf
- **AI Document Recognition** — Invoice/receipt extraction via Anthropic Claude
- **Cloud Storage** — Google Drive, OneDrive, Dropbox integration
- **Internationalization** — English, German, Macedonian with Vuetify locale support
- **Dark/Light Theme** — Persistent theme preference
- **JWT Authentication** — httpOnly cookie + Bearer token with org-scoped login
- **Real-time Updates** — WebSocket notifications and background task tracking

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Bun |
| **Backend** | Elysia.js, Mongoose |
| **Database** | MongoDB 7 |
| **Frontend** | Vue 3, Vuetify 3, Pinia, Vue Router |
| **Reporting** | ExcelJS, md-to-pdf |
| **Build** | Bun monorepo, Vite 7 |
| **Testing** | Bun test, mongodb-memory-server, Playwright |
| **Infrastructure** | Docker Compose |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Docker](https://www.docker.com/) (for MongoDB)

### Setup

```bash
# Clone the repo
git clone <repo-url> && cd lgr

# Install dependencies
bun install

# Start MongoDB
docker compose up -d

# Seed the database
bun run seed

# Start development servers
bun run dev:api   # API on http://localhost:4001
bun run dev:ui    # UI on http://localhost:4000
```

### Login

Open `http://localhost:4000` and sign in:

| Field | Value |
|-------|-------|
| Organization | `acme-corp` |
| Username | `admin` |
| Password | `test123` |

## Project Structure

```
lgr/
├── packages/
│   ├── config/       # Shared config (env vars) + constants (roles, permissions, modules)
│   ├── db/           # Mongoose models (48) + tenant plugin + connection management
│   ├── services/     # Business logic (biz/), DAOs (dao/), logger, AI recognition
│   ├── api/          # Elysia controllers (35) + JWT auth + WebSocket + tenant middleware
│   ├── reporting/    # Excel (ExcelJS) + PDF (md-to-pdf) export generators
│   ├── ui/           # Vue 3 + Vuetify 3 frontend (11 Pinia stores, 48 views)
│   ├── tests/        # Integration tests with mongodb-memory-server
│   └── e2e/          # Playwright E2E tests
├── docker-compose.yml
├── Dockerfile
├── package.json
└── docs/
```

### Package Dependency Flow

```
config ← db ← services ← api (+ reporting)
ui → HTTP → api
tests → services
e2e → Playwright → api
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev:api` | Start API with watch mode (port 4001) |
| `bun run dev:ui` | Start Vite dev server (port 4000) |
| `bun run build:ui` | Production UI build |
| `bun run start` | Production API (serves built UI) |
| `bun run seed` | Seed database (Acme Corp + Beta Inc) |
| `bun run test` | Run all integration tests |
| `bun run test:e2e` | Run Playwright E2E tests |

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview, package graph, request flow |
| [Data Model](docs/data-model.md) | ER diagram, entity fields and relationships |
| [API Reference](docs/api.md) | All REST endpoints with methods and parameters |
| [Frontend (UI)](docs/ui.md) | Views, routes, Pinia stores, composables |
| [Use Cases](docs/use-cases.md) | Roles, permissions, module workflows |
| [Export & Reporting](docs/export.md) | Excel and PDF generation details |
| [Testing](docs/testing.md) | Test suites, coverage, how to run |
| [Deployment](docs/deployment.md) | Docker, environment variables, seed data, i18n |

## License

ISC
