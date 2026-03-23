import { coreSchema } from './core.schema.js'
import { accountingSchema } from './accounting.schema.js'
import { invoicingSchema } from './invoicing.schema.js'
import { warehouseSchema } from './warehouse.schema.js'
import { payrollSchema } from './payroll.schema.js'
import { erpSchema } from './erp.schema.js'
import { permissionSetSchema } from './permission-set.schema.js'
import { syncSchema } from './sync.schema.js'

/** All schema DDL statements in dependency order */
export const allSchemas = [
  coreSchema,            // orgs, users first (referenced by all)
  accountingSchema,      // accounts (referenced by invoicing, payroll)
  invoicingSchema,       // contacts (referenced by invoicing)
  warehouseSchema,       // products, warehouses
  payrollSchema,         // employees, payroll runs, payslips
  erpSchema,             // POS sessions, POS transactions, fiscal devices, workstations
  permissionSetSchema,   // permission sets (references users + orgs)
  syncSchema,            // sync tables last (no external dependencies)
]

export {
  coreSchema,
  accountingSchema,
  invoicingSchema,
  warehouseSchema,
  payrollSchema,
  erpSchema,
  permissionSetSchema,
  syncSchema,
}
