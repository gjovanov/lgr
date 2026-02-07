# Architecture

## System Overview

```mermaid
graph TB
    subgraph Client["Browser"]
        UI["Vue 3 + Vuetify 3 SPA<br/>:4000"]
    end

    subgraph Server["Bun Runtime"]
        API["Elysia.js API<br/>:4001"]
        RPT["Reporting<br/>ExcelJS / md-to-pdf"]
    end

    DB[("MongoDB 7")]

    UI -->|"HTTP / WebSocket"| API
    API --> DB
    API --> RPT
    RPT --> API

    style UI fill:#42b883,color:#fff
    style API fill:#e65100,color:#fff
    style DB fill:#4caf50,color:#fff
    style RPT fill:#1976d2,color:#fff
```

The frontend is a Vue 3 single-page application served by the Elysia.js API in production. During development, Vite serves the frontend on port 4000 and proxies API requests to port 4001.

## Monorepo Package Graph

```mermaid
graph LR
    config["config"]
    db["db"]
    services["services"]
    api["api"]
    reporting["reporting"]
    ui["ui"]
    tests["tests"]
    e2e["e2e"]

    config --> db
    db --> services
    services --> api
    services --> reporting
    reporting --> api
    ui -.->|"HTTP"| api
    tests -.->|"imports"| services
    e2e -.->|"Playwright"| api

    style config fill:#78909c,color:#fff
    style db fill:#4caf50,color:#fff
    style services fill:#ff9800,color:#fff
    style api fill:#e65100,color:#fff
    style reporting fill:#1976d2,color:#fff
    style ui fill:#42b883,color:#fff
    style tests fill:#9c27b0,color:#fff
    style e2e fill:#9c27b0,color:#fff
```

### Package Responsibilities

| Package | Purpose | Key Dependencies |
|---------|---------|-----------------|
| **config** | Environment variables, constants (roles, permissions, modules, enums) | — |
| **db** | Mongoose models (48), tenant plugin, connection management | config, mongoose |
| **services** | Business logic (biz/), DAOs (dao/), logger, AI recognition | db, pino, @anthropic-ai/sdk |
| **api** | Elysia controllers (35), JWT auth plugin, WebSocket, tenant middleware | services, elysia, @elysiajs/jwt |
| **reporting** | Excel (ExcelJS) and PDF (md-to-pdf) export generators | services, exceljs, md-to-pdf |
| **ui** | Vue 3 + Vuetify 3 frontend with 11 Pinia stores and 48 views | vue, vuetify, pinia, vue-router, axios |
| **tests** | Integration tests with mongodb-memory-server | services, mongodb-memory-server |
| **e2e** | Playwright browser tests against running API | @playwright/test |

## Request Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as Elysia API
    participant J as JWT Derive
    participant C as Controller
    participant S as Service / DAO
    participant M as MongoDB

    B->>A: GET /api/org/:orgId/warehouse/product
    A->>J: Extract JWT from cookie / Authorization header
    J-->>A: { id, email, role, orgId, permissions }
    A->>C: Route to ProductController
    C->>S: productDao.findByOrgId(orgId)
    S->>M: Product.find({ orgId })
    M-->>S: documents[]
    S-->>C: { products, total, page, pageSize }
    C-->>B: 200 JSON response
```

All API requests follow this pattern:
1. JWT token is extracted from the `Authorization: Bearer` header or httpOnly cookie
2. The `isSignIn` macro validates the user is authenticated
3. The controller delegates to a DAO or business service
4. The tenant plugin on each model auto-filters queries by `orgId`

## Backend Layers

```mermaid
graph TB
    subgraph API["API Layer (Elysia)"]
        AUTH["Auth Plugin<br/>JWT derive + isSignIn macro"]
        CTRL["Controllers (35)<br/>Route handlers"]
    end

    subgraph BIZ["Service Layer"]
        SVC["Business Services (12)<br/>Workflows, calculations, state transitions"]
        DAO["DAOs (41)<br/>BaseDao CRUD + custom queries"]
    end

    subgraph DATA["Data Layer (Mongoose)"]
        MDL["Models (48)<br/>Schema + tenantPlugin"]
        DB[("MongoDB 7")]
    end

    AUTH --> CTRL
    CTRL --> SVC
    CTRL --> DAO
    SVC --> DAO
    DAO --> MDL
    MDL --> DB

    style AUTH fill:#e65100,color:#fff
    style CTRL fill:#e65100,color:#fff
    style SVC fill:#ff9800,color:#fff
    style DAO fill:#ff9800,color:#fff
    style MDL fill:#4caf50,color:#fff
    style DB fill:#4caf50,color:#fff
```

### Business Services

| Service | Module | Key Operations |
|---------|--------|---------------|
| `auth.service` | Core | Register (org + user), login, tokenize |
| `accounting.service` | Accounting | Post/void journal entries, trial balance, P&L |
| `invoicing.service` | Invoicing | Record payments, send invoices, overdue checks |
| `warehouse.service` | Warehouse | Confirm movements, adjust stock, stock valuation |
| `payroll.service` | Payroll | Calculate payroll, approve and generate payslips |
| `hr.service` | HR | Submit/approve/reject leave requests |
| `crm.service` | CRM | Convert leads, move deal stages, pipeline summary |
| `erp.service` | ERP | Start/complete production, POS sessions and transactions |
| `currency.service` | Accounting | Exchange rate lookups, amount conversion |
| `file.service` | Core | Upload/delete files with org-scoped storage |
| `ai-recognition.service` | Core | Document recognition via Anthropic Claude |
| `cloud-storage.service` | Core | Google Drive, Dropbox, OneDrive adapters |

## Frontend Layers

```mermaid
graph TB
    subgraph Views["Views (48)"]
        DASH["Dashboard"]
        MOD["Module Views<br/>Accounting, Invoicing, Warehouse,<br/>Payroll, HR, CRM, ERP"]
        AUTH["Auth<br/>Login / Register"]
        SET["Settings / Admin"]
    end

    subgraph State["Pinia Stores (11)"]
        APP["appStore<br/>auth, theme, locale"]
        ACC["accountingStore"]
        INV["invoicingStore"]
        WH["warehouseStore"]
        PAY["payrollStore"]
        HR["hrStore"]
        CRM["crmStore"]
        ERP["erpStore"]
        NOT["notificationStore"]
    end

    subgraph HTTP["HTTP Client"]
        AX["Axios + JWT interceptor"]
    end

    Views --> State
    State --> HTTP
    HTTP -->|"REST API"| API["Elysia API :4001"]

    style DASH fill:#42b883,color:#fff
    style MOD fill:#42b883,color:#fff
    style AUTH fill:#78909c,color:#fff
    style SET fill:#78909c,color:#fff
    style APP fill:#ff9800,color:#fff
    style ACC fill:#ff9800,color:#fff
    style INV fill:#ff9800,color:#fff
    style WH fill:#ff9800,color:#fff
    style AX fill:#1976d2,color:#fff
    style API fill:#e65100,color:#fff
```

The `httpClient` (Axios) automatically:
- Injects the JWT token from `localStorage` into every request
- Redirects to `/auth/login` on 401 responses
- Prefixes all URLs with `/api`

See [Data Model](data-model.md) for entity details, [API Reference](api.md) for endpoints, and [UI](ui.md) for frontend specifics.
