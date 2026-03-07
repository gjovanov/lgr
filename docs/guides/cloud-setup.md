# Cloud Setup Guide

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Docker](https://docker.com) (for MongoDB)
- Node.js 20+ (optional, for compatibility)

## Quick Start

```bash
# 1. Clone and install
git clone <repo> && cd lgr
bun install

# 2. Start MongoDB
docker compose up -d    # MongoDB 7, port 27018, no auth

# 3. Configure environment
cp .env.example .env    # Edit if needed (default: localhost:27018)

# 4. Seed demo data
bun run seed            # Creates Acme Corp + Beta Inc orgs

# 5. Start all services
bun run dev             # 8 APIs + 8 UIs
```

## Individual Services

```bash
bun run dev:portal       # Portal (4000/4001)
bun run dev:accounting   # Accounting (4011/4010)
bun run dev:invoicing    # Invoicing (4021/4020)
bun run dev:warehouse    # Warehouse (4031/4030)
bun run dev:payroll      # Payroll (4041/4040)
bun run dev:hr           # HR (4051/4050)
bun run dev:crm          # CRM (4061/4060)
bun run dev:erp          # ERP (4071/4070)
```

## Default Credentials

| Org Slug | Username | Password |
|----------|----------|----------|
| acme-corp | admin | test123 |
| beta-inc | admin | test123 |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGODB_URI` | `mongodb://localhost:27018/lgr` | MongoDB connection string |
| `JWT_SECRET` | (set in .env) | JWT signing secret |
| `OAUTH_BASE_URL` | `http://localhost:4001` | OAuth callback base URL |
| `OAUTH_FRONTEND_URL` | `http://localhost:4000` | Frontend redirect after OAuth |

## Production Build

```bash
bun run build            # Build all UI packages
bun run start            # Start all APIs (serve built UIs)
```
