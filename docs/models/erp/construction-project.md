# ConstructionProject

## Entity Interface

```typescript
interface IProjectAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

interface IProjectBudget {
  estimated: number
  currency: string
  approved: number
  spent: number
  remaining: number
}

interface IProjectTask {
  name: string
  assignedTo?: Types.ObjectId
  status: string           // 'pending' | 'in_progress' | 'completed'
  dueDate?: Date
  completedAt?: Date
}

interface IProjectPhase {
  name: string
  order: number
  status: string           // 'pending' | 'in_progress' | 'completed'
  startDate?: Date
  endDate?: Date
  budget: number
  spent: number
  tasks: IProjectTask[]
}

interface IProjectTeamMember {
  employeeId: Types.ObjectId
  role: string
  startDate: Date
  endDate?: Date
}

interface IProjectMaterial {
  productId: Types.ObjectId
  quantity: number
  unitCost: number
  totalCost: number
  deliveryDate?: Date
  status: string           // 'ordered' | 'delivered' | 'installed'
  movementId?: Types.ObjectId
}

export interface IConstructionProject extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  projectNumber: string
  name: string
  clientId: Types.ObjectId
  address?: IProjectAddress
  status: string           // 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'
  startDate: Date
  expectedEndDate: Date
  actualEndDate?: Date
  budget: IProjectBudget
  phases: IProjectPhase[]
  team: IProjectTeamMember[]
  materials: IProjectMaterial[]
  totalInvoiced: number
  totalPaid: number
  margin: number
  documents: Types.ObjectId[]
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS construction_projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  project_number TEXT NOT NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','on_hold','completed','cancelled')),
  start_date TEXT NOT NULL,
  expected_end_date TEXT NOT NULL,
  actual_end_date TEXT,
  budget TEXT NOT NULL DEFAULT '{}',
  total_invoiced REAL NOT NULL DEFAULT 0,
  total_paid REAL NOT NULL DEFAULT 0,
  margin REAL NOT NULL DEFAULT 0,
  documents TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, project_number)
);
CREATE INDEX IF NOT EXISTS idx_cp_org_client ON construction_projects(org_id, client_id);
CREATE INDEX IF NOT EXISTS idx_cp_org_status ON construction_projects(org_id, status);

CREATE TABLE IF NOT EXISTS construction_phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  start_date TEXT,
  end_date TEXT,
  budget REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_phase_tasks (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES construction_phases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assigned_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  due_date TEXT,
  completed_at TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_team_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  role TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','delivered','installed')),
  movement_id TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| projectNumber | string | Yes | - | Unique project number within the organization |
| name | string | Yes | - | Project name |
| clientId | ObjectId | Yes | - | References the Contact who is the client |
| address | JSON (IProjectAddress) | No | - | Project site address (street, city, state, postalCode, country) |
| status | string | Yes | `'planning'` | Project status: `planning`, `active`, `on_hold`, `completed`, `cancelled` |
| startDate | Date | Yes | - | Project start date |
| expectedEndDate | Date | Yes | - | Expected completion date |
| actualEndDate | Date | No | - | Actual completion date |
| budget | JSON (IProjectBudget) | Yes | `{}` | Budget details (estimated, currency, approved, spent, remaining) |
| phases | IProjectPhase[] | No | `[]` | Project phases with tasks (child tables: `construction_phases`, `construction_phase_tasks`) |
| team | IProjectTeamMember[] | No | `[]` | Team members assigned to the project (child table: `construction_team_members`) |
| materials | IProjectMaterial[] | No | `[]` | Materials used in the project (child table: `construction_materials`) |
| totalInvoiced | number | Yes | `0` | Total amount invoiced to the client |
| totalPaid | number | Yes | `0` | Total amount paid by the client |
| margin | number | Yes | `0` | Profit margin |
| documents | ObjectId[] | No | `[]` | References to File records |
| notes | string | No | - | Free-text notes |
| createdBy | ObjectId | Yes | - | User who created the project |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **References**: `clientId` -> `Contact`, `createdBy` -> `User`, `documents[]` -> `File`, `team[].employeeId` -> `Employee`, `phases[].tasks[].assignedTo` -> `Employee`, `materials[].productId` -> `Product`, `materials[].movementId` -> `StockMovement`
- **Referenced by**: `Timesheet.projectId`

## Indexes

- `(orgId, projectNumber)` -- unique
- `(orgId, clientId)`
- `(orgId, status)`

## API Endpoints (prefix: `/api/org/:orgId/erp/construction-project`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List construction projects (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`, `status`. |
| POST | `/` | Yes | Create construction project. |
| GET | `/:id` | Yes | Get single construction project by ID. |
| PUT | `/:id` | Yes | Update construction project (phases, team, materials, status). |
| DELETE | `/:id` | Yes | Delete construction project. |
