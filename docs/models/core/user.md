# User

## Entity Interface

```typescript
interface IOAuthProvider {
  provider: string
  providerId: string
  accessToken?: string
  refreshToken?: string
}

interface IUser extends Document {
  _id: Types.ObjectId
  email: string
  username: string
  password?: string
  firstName: string
  lastName: string
  roleId?: Types.ObjectId        // the person's one role in this org (FR-27)
  orgId: Types.ObjectId
  identityId?: Types.ObjectId   // the person behind this membership (Identity)
  avatar?: string
  isActive: boolean
  preferences: {
    locale?: string
    theme?: string
    dashboard?: object
  }
  oauthProviders: IOAuthProvider[]
  lastLoginAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| identityId | string (ObjectId) | No | - | The [Identity](identity.md) (person) this user is the org membership of. Set by `scripts/migrate-identities.ts`; unique with `orgId` |
| email | string | Yes | - | User email address (unique per org) |
| username | string | Yes | - | Login username (unique per org) |
| password | string | No | - | Bcrypt-hashed password. Optional for OAuth-only users |
| firstName | string | Yes | - | First name |
| lastName | string | Yes | - | Last name |
| roleId | string (ObjectId) | No | - | The person's one [role](../../fr/FR-27-one-access-model.md) in this org: what they may do. The legacy `role` key, `permissions` and `permissionSetIds` are gone (FR-27 P3-9, migrations 0017 and 0020) |
| avatar | string | No | - | URL or path to avatar image |
| isActive | boolean | Yes | `true` | Whether the user can log in |
| preferences | JSON | Yes | `{}` | User preferences (locale, theme, dashboard layout) |
| oauthProviders | JSON array | Yes | `[]` | Linked OAuth providers with tokens |
| lastLoginAt | Date | No | - | Timestamp of last successful login |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization this user belongs to (`orgId`) |
| belongsTo | Identity | The person; one membership per org (`identityId`) |
| hasMany | Invite | Invites created by this user (`inviterId`) |
| hasMany | AuditLog | Audit entries for this user's actions |
| hasMany | Notification | Notifications addressed to this user |
| hasMany | BackgroundTask | Background tasks initiated by this user |
| hasMany | File | Files uploaded by this user |
| hasMany | Code | Activation/verification codes for this user |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/user`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId/user` | List users (paginated) | Signed in |
| POST | `/api/org/:orgId/user` | Create user | Admin only |
| GET | `/api/org/:orgId/user/:userId` | Get user by ID | Signed in |
| PUT | `/api/org/:orgId/user/:userId` | Update user | Admin only |
| DELETE | `/api/org/:orgId/user/:userId` | Delete user | Admin only |
