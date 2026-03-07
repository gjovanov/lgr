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
  role: string
  orgId: Types.ObjectId
  avatar?: string
  isActive: boolean
  permissions: string[]
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

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  avatar TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '[]',
  preferences TEXT NOT NULL DEFAULT '{}',
  oauth_providers TEXT NOT NULL DEFAULT '[]',
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, email),
  UNIQUE(org_id, username)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| email | string | Yes | - | User email address (unique per org) |
| username | string | Yes | - | Login username (unique per org) |
| password | string | No | - | Bcrypt-hashed password. Optional for OAuth-only users |
| firstName | string | Yes | - | First name |
| lastName | string | Yes | - | Last name |
| role | string | Yes | `'member'` | Role: admin, manager, accountant, hr_manager, warehouse_manager, sales, member |
| avatar | string | No | - | URL or path to avatar image |
| isActive | boolean | Yes | `true` | Whether the user can log in |
| permissions | string[] (JSON) | Yes | `[]` | Granular permission strings (e.g., `accounting.read`) |
| preferences | JSON | Yes | `{}` | User preferences (locale, theme, dashboard layout) |
| oauthProviders | JSON array | Yes | `[]` | Linked OAuth providers with tokens |
| lastLoginAt | Date | No | - | Timestamp of last successful login |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization this user belongs to (`orgId`) |
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
