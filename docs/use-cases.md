# Use Cases

## User Roles & Permissions

```mermaid
graph LR
    subgraph Roles
        ADM["admin"]
        MGR["manager"]
        ACCT["accountant"]
        HRM["hr_manager"]
        WHM["warehouse_manager"]
        SALES["sales"]
        MEM["member"]
    end

    subgraph Permissions
        ACC_R["accounting.read"]
        ACC_W["accounting.write"]
        ACC_P["accounting.post"]
        INV_R["invoicing.read"]
        INV_W["invoicing.write"]
        INV_S["invoicing.send"]
        WH_R["warehouse.read"]
        WH_W["warehouse.write"]
        WH_A["warehouse.adjust"]
        PAY_R["payroll.read"]
        PAY_W["payroll.write"]
        PAY_A["payroll.approve"]
        HR_R["hr.read"]
        HR_W["hr.write"]
        HR_AL["hr.approve_leave"]
        CRM_R["crm.read"]
        CRM_W["crm.write"]
        ERP_R["erp.read"]
        ERP_W["erp.write"]
        ADM_U["admin.users"]
        ADM_S["admin.settings"]
    end

    ADM --> ACC_R & ACC_W & ACC_P & INV_R & INV_W & INV_S & WH_R & WH_W & WH_A & PAY_R & PAY_W & PAY_A & HR_R & HR_W & HR_AL & CRM_R & CRM_W & ERP_R & ERP_W & ADM_U & ADM_S
    MGR --> ACC_R & ACC_W & ACC_P & INV_R & INV_W & INV_S & WH_R & WH_W & WH_A & PAY_R & PAY_W & HR_R & HR_W & HR_AL & CRM_R & CRM_W & ERP_R & ERP_W
    ACCT --> ACC_R & ACC_W & ACC_P & INV_R & INV_W & INV_S
    HRM --> HR_R & HR_W & HR_AL & PAY_R & PAY_W & PAY_A
    WHM --> WH_R & WH_W & WH_A
    SALES --> CRM_R & CRM_W & INV_R & INV_W
    MEM --> ACC_R & INV_R & WH_R & PAY_R & HR_R & CRM_R & ERP_R

    style ADM fill:#d32f2f,color:#fff
    style MGR fill:#e65100,color:#fff
    style ACCT fill:#1976d2,color:#fff
    style HRM fill:#4caf50,color:#fff
    style WHM fill:#ff9800,color:#fff
    style SALES fill:#9c27b0,color:#fff
    style MEM fill:#78909c,color:#fff
```

### Permission Matrix

| Resource | admin | manager | accountant | hr_manager | warehouse_manager | sales | member |
|----------|-------|---------|------------|------------|-------------------|-------|--------|
| **Accounting** | read, write, post | read, write, post | read, write, post | — | — | — | read |
| **Invoicing** | read, write, send | read, write, send | read, write, send | — | — | read, write | read |
| **Warehouse** | read, write, adjust | read, write, adjust | — | — | read, write, adjust | — | read |
| **Payroll** | read, write, approve | read, write | — | read, write, approve | — | — | read |
| **HR** | read, write, approve_leave | read, write, approve_leave | — | read, write, approve_leave | — | — | read |
| **CRM** | read, write | read, write | — | — | — | read, write | read |
| **ERP** | read, write | read, write | — | — | — | — | read |
| **Admin** | users, settings | — | — | — | — | — | — |

## Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant A as Elysia API
    participant DB as MongoDB

    U->>B: Enter orgSlug, username, password
    B->>A: POST /auth/login
    A->>DB: Find Org by slug (case-insensitive)
    A->>DB: Find User by username + orgId
    A->>A: Verify password (Bun.password.verify)
    A->>A: Generate JWT { id, email, role, orgId, permissions }
    A-->>B: 200 { token, user }
    B->>B: Store token in localStorage
    B->>B: Redirect to /dashboard
    Note over B,A: Subsequent requests include<br/>Authorization: Bearer {token}
    B->>A: GET /auth/me
    A->>A: Derive user from JWT
    A-->>B: { user, org }
```

## Module Workflows

### Invoice Lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft : Create
    draft --> sent : Send
    sent --> partially_paid : Partial Payment
    sent --> paid : Full Payment
    sent --> overdue : Past Due Date
    partially_paid --> paid : Remaining Payment
    partially_paid --> overdue : Past Due Date
    overdue --> partially_paid : Partial Payment
    overdue --> paid : Full Payment
    draft --> cancelled : Cancel
    sent --> voided : Void
```

**Key operations:**
- **Create** — Draft invoice with lines, auto-generated number
- **Send** — Transition draft → sent, records `sentAt`
- **Record Payment** — Updates `amountPaid`, creates payment entry
- **Overdue Check** — Background scan for invoices past `dueDate`
- **Invoice → Journal Entry** — Posts accounting entry on payment

### Stock Movement Flow

```mermaid
stateDiagram-v2
    [*] --> draft : Create
    draft --> confirmed : Confirm
    confirmed --> completed : Auto
    draft --> cancelled : Cancel

    state confirmed {
        [*] --> update_from : Decrease Source
        update_from --> update_to : Increase Destination
        update_to --> update_cost : Recalculate Avg Cost
    }
```

**Movement types:**
- **Receipt** — Goods arriving at `toWarehouseId`
- **Dispatch** — Goods leaving `fromWarehouseId`
- **Transfer** — Between two warehouses
- **Adjustment** — Inventory corrections
- **Return** — Customer/supplier returns
- **Production In/Out** — Manufacturing material consumption and output

### Payroll Run Workflow

```mermaid
stateDiagram-v2
    [*] --> draft : Create
    draft --> calculated : Calculate
    calculated --> approved : Approve
    approved --> paid : Process Payment
    draft --> cancelled : Cancel
    calculated --> draft : Recalculate

    state calculated {
        [*] --> fetch_employees : Get Active Employees
        fetch_employees --> calc_gross : Calculate Gross Pay
        calc_gross --> apply_deductions : Apply Deductions
        apply_deductions --> calc_employer : Employer Contributions
        calc_employer --> generate_items : Generate Run Items
    }
```

**Key operations:**
- **Calculate** — Generates payroll items for all active employees with base salary, deductions, and employer contributions
- **Approve** — Requires admin/hr_manager role, auto-generates individual payslips
- **Payslip** — Contains earnings breakdown, deductions, net pay, and year-to-date totals

### Leave Request Flow

```mermaid
stateDiagram-v2
    [*] --> pending : Submit
    pending --> approved : Approve
    pending --> rejected : Reject
    pending --> cancelled : Cancel

    state pending {
        [*] --> check_balance : Validate Balance
        check_balance --> increment_pending : Sufficient
        check_balance --> reject_insufficient : Insufficient
    }
```

**Balance tracking:**
- Submit: `pending += days`
- Approve: `pending -= days`, `taken += days`, `remaining -= days`
- Reject/Cancel: `pending -= days` (restore)

### Deal Pipeline

```mermaid
stateDiagram-v2
    [*] --> Lead : Create Lead
    Lead --> Contact : Convert

    state Contact {
        [*] --> Qualified
        Qualified --> Proposal
        Proposal --> Negotiation
        Negotiation --> Won : Close Won
        Negotiation --> Lost : Close Lost
    }
```

**CRM workflow:**
- **Lead** → Created from source (website, referral, cold call, etc.)
- **Convert** → Creates Contact (type: customer) + optional Deal
- **Deal Stages** → Defined by Pipeline with `name`, `order`, `probability`, `color`
- **Pipeline Summary** → Aggregates deals by stage with count, total value, and weighted value

### Production Order

```mermaid
stateDiagram-v2
    [*] --> planned : Create from BOM
    planned --> in_progress : Start
    in_progress --> quality_check : QC
    quality_check --> completed : Pass
    in_progress --> completed : Skip QC
    planned --> cancelled : Cancel

    state completed {
        [*] --> consume_materials : Stock Movement (production_out)
        consume_materials --> output_product : Stock Movement (production_in)
        output_product --> calc_cost : Calculate Cost Per Unit
    }
```

**Key operations:**
- **BOM** defines materials, labor hours, overhead cost
- **Start** transitions planned → in_progress
- **Complete** creates stock movements for material consumption and finished goods output
- **Quality Checks** tracked per production stage

## Multi-Tenant Data Flow

```mermaid
graph TB
    subgraph Tenant1["Acme Corp (orgId: abc123)"]
        T1_INV["Invoices"]
        T1_PROD["Products"]
        T1_EMP["Employees"]
    end

    subgraph Tenant2["Beta Inc (orgId: def456)"]
        T2_INV["Invoices"]
        T2_PROD["Products"]
        T2_EMP["Employees"]
    end

    subgraph DB["MongoDB"]
        COL["Single Collection per Model"]
    end

    T1_INV -->|"orgId: abc123"| COL
    T2_INV -->|"orgId: def456"| COL

    subgraph Plugin["tenantPlugin"]
        FILTER["Auto-filter: { orgId }"]
    end

    COL --> FILTER

    style Tenant1 fill:#1976d2,color:#fff
    style Tenant2 fill:#4caf50,color:#fff
    style FILTER fill:#e65100,color:#fff
```

Every query is automatically scoped by `orgId` through the Mongoose tenant plugin. Users can only access data belonging to their organization. The `orgId` is derived from the JWT token and the `:orgId` URL parameter, with validation ensuring they match.

See [Data Model](data-model.md) for entity schemas and [API Reference](api.md) for endpoint details.
