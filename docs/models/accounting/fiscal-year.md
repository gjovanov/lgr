# FiscalYear

## Entity Interface

```typescript
export interface IFiscalYear extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  startDate: Date
  endDate: Date
  status: string        // 'open' | 'closed' | 'locked'
  closingEntryId?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Display name (e.g., "FY 2025") |
| startDate | Date | Yes | - | First day of the fiscal year |
| endDate | Date | Yes | - | Last day of the fiscal year |
| status | string | Yes | `open` | Lifecycle state: `open` (active), `closed` (year-end completed), `locked` (no further changes) |
| closingEntryId | ObjectId | No | - | Reference to the closing journal entry created at year-end |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `closingEntryId` -> `JournalEntry`
- **Referenced by**: `FiscalPeriod.fiscalYearId`

## Indexes

- `(orgId, startDate)` -- unique

## API Endpoints (prefix: `/api/org/:orgId/accounting/fiscal-year`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List fiscal years (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create fiscal year. |
| GET | `/:id` | Yes | Get single fiscal year by ID. |
| PUT | `/:id` | Yes | Update fiscal year. |
| DELETE | `/:id` | Yes | Delete fiscal year. |
