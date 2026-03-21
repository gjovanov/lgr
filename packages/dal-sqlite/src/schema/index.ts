import { coreSchema } from './core.schema.js'
import { accountingSchema } from './accounting.schema.js'
import { invoicingSchema } from './invoicing.schema.js'
import { warehouseSchema } from './warehouse.schema.js'
import { salesSchema } from './sales.schema.js'
import { purchaseSchema } from './purchase.schema.js'
import { subscriptionsSchema } from './subscriptions.schema.js'
import { payrollSchema } from './payroll.schema.js'
import { hrSchema } from './hr.schema.js'
import { recruitmentSchema } from './recruitment.schema.js'
import { crmSchema } from './crm.schema.js'
import { erpSchema } from './erp.schema.js'
import { manufacturingSchema } from './manufacturing.schema.js'
import { posRestaurantSchema } from './pos-restaurant.schema.js'
import { projectSchema } from './project.schema.js'
import { helpdeskSchema } from './helpdesk.schema.js'
import { documentsSchema } from './documents.schema.js'
import { knowledgeSchema } from './knowledge.schema.js'
import { planningSchema } from './planning.schema.js'
import { fieldServiceSchema } from './field-service.schema.js'
import { fleetSchema } from './fleet.schema.js'
import { maintenanceSchema } from './maintenance.schema.js'
import { approvalsSchema } from './approvals.schema.js'
import { syncSchema } from './sync.schema.js'

/** All schema DDL statements in dependency order */
export const allSchemas = [
  coreSchema,            // orgs, users first (referenced by all)
  accountingSchema,      // accounts (referenced by invoicing, payroll)
  invoicingSchema,       // contacts (referenced by CRM deals, sales, purchase)
  warehouseSchema,       // products, warehouses (referenced by ERP, sales, purchase)
  salesSchema,           // sales orders (referenced by subscriptions, projects)
  purchaseSchema,        // purchase orders, blanket orders, reorder rules
  subscriptionsSchema,   // recurring subscriptions
  payrollSchema,         // employees (referenced by HR, recruitment)
  hrSchema,
  recruitmentSchema,     // job positions, applicants, appraisals
  crmSchema,
  erpSchema,             // BOM, production, construction, POS
  manufacturingSchema,   // work centers, routings, ECOs
  posRestaurantSchema,   // restaurant floors, kitchen orders
  projectSchema,         // projects, tasks, milestones, timesheets
  helpdeskSchema,        // tickets, teams, SLA policies
  documentsSchema,       // workspaces, documents, signature requests
  knowledgeSchema,       // knowledge articles
  planningSchema,        // shifts, appointments
  fieldServiceSchema,    // field service tasks
  fleetSchema,           // vehicles, vehicle costs
  maintenanceSchema,     // equipment, maintenance requests
  approvalsSchema,       // approval types + requests (cross-module)
  syncSchema,            // sync tables last (no external dependencies)
]

export {
  coreSchema,
  accountingSchema,
  invoicingSchema,
  warehouseSchema,
  salesSchema,
  purchaseSchema,
  subscriptionsSchema,
  payrollSchema,
  hrSchema,
  recruitmentSchema,
  crmSchema,
  erpSchema,
  manufacturingSchema,
  posRestaurantSchema,
  projectSchema,
  helpdeskSchema,
  documentsSchema,
  knowledgeSchema,
  planningSchema,
  fieldServiceSchema,
  fleetSchema,
  maintenanceSchema,
  approvalsSchema,
  syncSchema,
}
