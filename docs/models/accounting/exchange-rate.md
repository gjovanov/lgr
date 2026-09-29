# ExchangeRate

## Entity Interface

```typescript
export interface IExchangeRate extends Document {
  _id: Types.ObjectId
  orgId?: Types.ObjectId
  fromCurrency: string
  toCurrency: string
  rate: number
  date: Date
  source: string        // 'manual' | 'api'
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| fromCurrency | string | Yes | - | Source currency code (e.g., `USD`) |
| toCurrency | string | Yes | - | Target currency code (e.g., `EUR`) |
| rate | number | Yes | - | Conversion rate (1 unit of fromCurrency = rate units of toCurrency) |
| date | Date | No | `Date.now` | Date the rate is effective for |
| source | string | Yes | `manual` | How the rate was obtained: `manual` (user-entered) or `api` (fetched from external service) |
| orgId | ObjectId | No | - | Tenant organization ID. Optional -- rates can be global (shared across orgs) or org-specific. |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- None. ExchangeRate is a standalone reference entity.

## Notes

- Unlike other accounting models, ExchangeRate does **not** use the `tenantPlugin`. The `orgId` field is optional and managed manually, allowing for global exchange rates shared across organizations.
- The latest rate for a currency pair is found by querying with `date DESC`.

## Indexes

- `(orgId, fromCurrency, toCurrency, date)` -- descending date for efficient latest-rate lookup

## API Endpoints (prefix: `/api/org/:orgId/accounting/exchange-rate`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List exchange rates (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create exchange rate. |
| GET | `/:id` | Yes | Get single exchange rate by ID. |
| PUT | `/:id` | Yes | Update exchange rate. |
| DELETE | `/:id` | Yes | Delete exchange rate. |
