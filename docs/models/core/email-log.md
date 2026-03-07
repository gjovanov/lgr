# EmailLog

## Entity Interface

```typescript
interface IEmailLog extends Document {
  _id: Types.ObjectId
  creatorId?: Types.ObjectId
  orgId?: Types.ObjectId
  from: string
  to: string
  subject: string
  body: string
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS email_logs (
  id TEXT PRIMARY KEY,
  creator_id TEXT,
  org_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_logs_to ON email_logs("to", created_at DESC);
```

Note: `"from"` and `"to"` are quoted in SQLite because they are reserved SQL keywords.

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| creatorId | string (ObjectId) | No | - | References the User who triggered this email (if any) |
| orgId | string (ObjectId) | No | - | References the Org context (if any). Not a tenant-scoped FK |
| from | string | Yes | - | Sender email address |
| to | string | Yes | - | Recipient email address |
| subject | string | Yes | - | Email subject line |
| body | string | Yes | - | Email body content (HTML or plain text) |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | User | The user who triggered this email (`creatorId`, optional) |
| belongsTo | Org | The organization context (`orgId`, optional) |

Note: EmailLog is a BaseEntity -- both `creatorId` and `orgId` are optional. System-generated emails (e.g., activation codes) may have no creator or org context.

## API Endpoints

Email logs are created internally by the email service. There are no direct CRUD endpoints exposed for email logs.
