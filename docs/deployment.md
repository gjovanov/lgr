# Deployment

## Docker

Start the infrastructure with Docker Compose:

```bash
# Start MongoDB
docker compose up -d

# Start MongoDB and application
docker compose --profile app up -d
```

### Docker Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| **mongo** | `mongo:7` | 27018 | MongoDB 7 (no authentication, dev only) |
| **app** | Built from Dockerfile | 3001 | Elysia API + built UI |

### Dockerfile

```dockerfile
FROM oven/bun:canary-slim AS base
ENV HOST=0.0.0.0
ENV PORT=3001
COPY . /app
WORKDIR /app
RUN bun install && cd /app/packages/ui && bun run build
EXPOSE 3001/tcp
WORKDIR /app/packages/api
CMD ["bun", "run", "start"]
```

The production build serves the Vue 3 SPA from the Elysia API on port 3001.

### Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `mongo-data` | `/data/db` | Persistent MongoDB storage |
| `uploads` | `/app/uploads` | File upload storage |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `4001` | API server port |
| `MONGODB_URI` | `mongodb://localhost:27018/lgr` | MongoDB connection string |
| `JWT_SECRET` | `lgr-dev-secret` | JWT signing secret (change in production) |
| `UPLOAD_DIR` | `./uploads` | File upload directory |
| `MAX_FILE_SIZE` | `50000000` (50MB) | Maximum upload size |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for AI document recognition |
| `GOOGLE_CLIENT_ID` | — | Google Drive OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google Drive OAuth client secret |
| `GOOGLE_REDIRECT_URI` | — | Google Drive OAuth redirect URI |
| `DROPBOX_APP_KEY` | — | Dropbox application key |
| `DROPBOX_APP_SECRET` | — | Dropbox application secret |
| `ONEDRIVE_CLIENT_ID` | — | OneDrive client ID |
| `ONEDRIVE_CLIENT_SECRET` | — | OneDrive client secret |
| `EXCHANGE_RATE_API_KEY` | — | External exchange rate API key |

## Environment Files

| File | Purpose |
|------|---------|
| `.env` | Development (MongoDB at `localhost:27018/lgr`, no auth) |
| `.env.test` | Testing (overridden by mongodb-memory-server at runtime) |

API scripts load the root env file: `--env-file=../../.env`

## Seed Data

Populate the database with sample data for development:

```bash
bun run seed
```

### Seeded Entities

| Entity | Acme Corp | Beta Inc |
|--------|-----------|----------|
| **Organization** | slug: `acme-corp` | slug: `beta-inc` |
| **Admin User** | `admin` / `test123` | `admin` / `test123` |
| **Manager User** | `manager` / `test123` | — |
| **Accountant User** | `accountant` / `test123` | — |
| **Sales User** | `sales` / `test123` | — |
| **Member User** | `member` / `test123` | — |
| **Chart of Accounts** | Default account tree | Default account tree |
| **Products** | Sample products with SKUs | — |
| **Warehouses** | Main warehouse + store | — |
| **Contacts** | Sample customers/suppliers | — |
| **Departments** | Engineering, Sales, HR, Finance | — |
| **Employees** | Linked to seeded users | — |
| **Pipeline** | Default sales pipeline with stages | — |
| **Fiscal Year** | Current year with monthly periods | — |

### Login Credentials

| Organization | Username | Password | Role |
|-------------|----------|----------|------|
| `acme-corp` | `admin` | `test123` | admin |
| `acme-corp` | `manager` | `test123` | manager |
| `acme-corp` | `accountant` | `test123` | accountant |
| `acme-corp` | `sales` | `test123` | sales |
| `acme-corp` | `member` | `test123` | member |
| `beta-inc` | `admin` | `test123` | admin |

## Internationalization

### Supported Locales

| Code | Language | Coverage |
|------|----------|----------|
| `en` | English | Full |
| `de` | German | Full |
| `mk` | Macedonian | Full (Vuetify uses EN fallback) |

### Adding a New Locale

1. Create `packages/ui/src/locales/{code}.json` with all translation keys
2. Import and register in `packages/ui/src/plugins/i18n.ts`
3. Add the locale code to the supported locales array
4. Add Vuetify locale import from `vuetify/lib/locale/{code}` (if available)

### Locale Resolution

1. Check `localStorage` for `lgr_locale`
2. Fall back to browser language (`navigator.language`)
3. Default to `en`

## Production Build

```bash
# Build the UI
bun run build:ui

# Start the production server
bun run start
```

The production server:
- Builds the Vue 3 SPA into `packages/ui/dist/`
- Elysia serves the static files and API on port 3001 (or `PORT` env var)
- API routes are prefixed with `/api`
- All other routes serve `index.html` for SPA routing

## Cloud Storage Integrations

### Google Drive

1. Create OAuth 2.0 credentials in Google Cloud Console
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
3. Users authorize via Settings → Cloud Storage → Google Drive

### OneDrive

1. Register app in Azure AD portal
2. Set `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`
3. Users authorize via Settings → Cloud Storage → OneDrive

### Dropbox

1. Create app in Dropbox App Console
2. Set `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`
3. Users authorize via Settings → Cloud Storage → Dropbox

## Logging

The application uses **Pino** for structured logging:

| Environment | Format | Default Level |
|-------------|--------|--------------|
| Development | `pino-pretty` (colorized) | `debug` |
| Test | `pino-pretty` (colorized) | `warn` |
| Production | JSON | `info` |

Set the `LOG_LEVEL` environment variable to override.

See [Architecture](architecture.md) for the system overview and [Testing](testing.md) for test environment setup.
