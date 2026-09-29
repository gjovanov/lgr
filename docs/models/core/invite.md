# Invite

## Entity Interface

```typescript
type InviteStatus = 'active' | 'expired' | 'revoked' | 'exhausted'

interface IInvite extends Document {
  _id: Types.ObjectId
  code: string
  orgId: Types.ObjectId
  inviterId: Types.ObjectId
  targetEmail?: string
  maxUses?: number
  useCount: number
  status: InviteStatus
  assignRole: string
  expiresAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| code | string | Yes (unique) | - | Unique invite code used in invite links |
| inviterId | string (ObjectId) | Yes | - | References the User who created this invite |
| targetEmail | string | No | - | If set, restricts the invite to this specific email |
| maxUses | number | No | - | Maximum number of times this invite can be used. Null = unlimited |
| useCount | number | Yes | `0` | Number of times this invite has been used |
| status | string | Yes | `'active'` | Invite status: active, expired, revoked, exhausted |
| assignRole | string | Yes | `'member'` | Role assigned to users who register via this invite |
| expiresAt | Date | No | - | Expiration timestamp. Null = no expiration |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization this invite is for (`orgId`) |
| belongsTo | User | The user who created this invite (`inviterId`) |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/invite` and `/api/invite/:code`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/invite/:code` | Get invite info by code (public) | None |
| GET | `/api/org/:orgId/invite` | List org invites (paginated) | Admin only |
| POST | `/api/org/:orgId/invite` | Create invite | Admin only |
| DELETE | `/api/org/:orgId/invite/:inviteId` | Revoke invite | Admin only |
