# Tag

## Entity Interface

```typescript
interface ITag extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  value: string
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| type | string | Yes | - | Tag category: `product`, `contact`, `warehouse`, `employee`, `invoice`, `lead`, `deal` |
| value | string | Yes | - | Tag value/label text |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

**Unique constraint:** `(orgId, type, value)` -- each tag value is unique within an org and type.

**Allowed types (enum):** `product`, `contact`, `warehouse`, `employee`, `invoice`, `lead`, `deal`

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |

Tags are referenced by value (not by ID) in the `tags[]` array field on domain entities such as Product, Contact, Warehouse, Employee, Invoice, Lead, and Deal. When a tag is renamed, the controller propagates the rename across all matching documents. When a tag is deleted, it is pulled from all matching documents.

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/tags`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId/tags` | List tags (filterable by `type`, searchable by `search`) | Signed in |
| POST | `/api/org/:orgId/tags` | Create tag (returns existing if duplicate) | Signed in |
| PUT | `/api/org/:orgId/tags/:id` | Rename tag (propagates to all tagged entities) | Signed in |
| DELETE | `/api/org/:orgId/tags/:id` | Delete tag (removes from all tagged entities) | Signed in |
