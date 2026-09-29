# Code

## Entity Interface

```typescript
type CodeType = 'user_activation'

interface ICode extends Document {
  _id: Types.ObjectId
  userId: Types.ObjectId
  orgId: Types.ObjectId
  token: string
  type: CodeType
  validTo: Date
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| userId | string (ObjectId) | Yes | - | References the User this code belongs to |
| token | string | Yes | - | The verification/activation token value |
| type | string | Yes | - | Code type. Currently only `'user_activation'` |
| validTo | Date | Yes | - | Expiration timestamp for this code |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

**MongoDB TTL:** The `validTo` field has a TTL index (`expireAfterSeconds: 3600`) that automatically removes expired codes.

**MongoDB Indexes:**
- `{ userId: 1, type: 1 }` -- lookup codes by user and type

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |
| belongsTo | User | The user this code is for (`userId`) |

## API Endpoints

Codes are managed internally by the auth service (user activation flow). There are no direct CRUD endpoints exposed for codes.
