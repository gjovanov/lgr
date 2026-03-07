# File

## Entity Interface

```typescript
interface IFile extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  uploadedBy: Types.ObjectId
  originalName: string
  storagePath: string
  storageProvider: string
  mimeType: string
  size: number
  module: string
  entityType?: string
  entityId?: Types.ObjectId
  aiRecognition?: {
    status: string
    extractedData?: object
    confidence?: number
    processedAt?: Date
  }
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  uploaded_by TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  module TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ai_recognition TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_org_module ON files(org_id, module);
CREATE INDEX IF NOT EXISTS idx_files_entity ON files(org_id, entity_type, entity_id);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string (ObjectId) | Yes | - | References the parent Org (tenant scope) |
| uploadedBy | string (ObjectId) | Yes | - | References the User who uploaded the file |
| originalName | string | Yes | - | Original filename as uploaded |
| storagePath | string | Yes | - | Path or key in the storage backend |
| storageProvider | string | Yes | `'local'` | Storage backend: `local`, `googleDrive`, `onedrive`, `dropbox` |
| mimeType | string | Yes | - | MIME type (e.g., `application/pdf`, `image/png`) |
| size | number | Yes | - | File size in bytes |
| module | string | Yes | - | Module this file belongs to (e.g., `invoicing`, `hr`) |
| entityType | string | No | - | Type of entity this file is attached to (e.g., `Invoice`) |
| entityId | string (ObjectId) | No | - | ID of the entity this file is attached to |
| aiRecognition | JSON | No | - | AI document recognition results |
| aiRecognition.status | string | - | - | Recognition status: `pending`, `processing`, `completed`, `failed` |
| aiRecognition.extractedData | object | - | - | Structured data extracted by AI |
| aiRecognition.confidence | number | - | - | Confidence score (0-1) |
| aiRecognition.processedAt | Date | - | - | When AI processing completed |
| tags | string[] (JSON) | No | `[]` | File tags for categorization |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| belongsTo | Org | The organization scope (`orgId`) |
| belongsTo | User | The user who uploaded the file (`uploadedBy`) |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId/file`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId/file` | List files (paginated, filterable by module/entityType/entityId) | Signed in |
| POST | `/api/org/:orgId/file` | Upload/register a file | Signed in |
| GET | `/api/org/:orgId/file/:id` | Get file metadata by ID | Signed in |
| DELETE | `/api/org/:orgId/file/:id` | Delete file | Signed in |
