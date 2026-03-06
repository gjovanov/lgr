import { coreSchema } from './core.schema.js'
import { accountingSchema } from './accounting.schema.js'
import { invoicingSchema } from './invoicing.schema.js'
import { warehouseSchema } from './warehouse.schema.js'
import { payrollSchema } from './payroll.schema.js'
import { hrSchema } from './hr.schema.js'
import { crmSchema } from './crm.schema.js'
import { erpSchema } from './erp.schema.js'
import { syncSchema } from './sync.schema.js'

/** All schema DDL statements in dependency order */
export const allSchemas = [
  coreSchema,       // orgs, users first (referenced by all)
  accountingSchema, // accounts (referenced by invoicing, payroll)
  invoicingSchema,  // contacts (referenced by CRM deals)
  warehouseSchema,  // products, warehouses (referenced by ERP)
  payrollSchema,    // employees (referenced by HR)
  hrSchema,
  crmSchema,
  erpSchema,
  syncSchema,       // sync tables last (no external dependencies)
]

export {
  coreSchema,
  accountingSchema,
  invoicingSchema,
  warehouseSchema,
  payrollSchema,
  hrSchema,
  crmSchema,
  erpSchema,
  syncSchema,
}
