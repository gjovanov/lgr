import type { TableMeta } from './types.js'

/**
 * Registry of all SQLite tables with their columns.
 * Used to generate change-tracking triggers.
 * System tables (prefixed with _) and FTS virtual tables are excluded.
 */
export const TABLE_REGISTRY: TableMeta[] = [
  // ── Core ──
  {
    name: 'orgs', repoKey: 'orgs', isChild: false,
    columns: ['id', 'name', 'slug', 'description', 'logo', 'owner_id', 'settings', 'subscription', 'created_at', 'updated_at'],
  },
  {
    name: 'users', repoKey: 'users', isChild: false,
    columns: ['id', 'org_id', 'email', 'username', 'password', 'first_name', 'last_name', 'role', 'avatar', 'is_active', 'permissions', 'preferences', 'oauth_providers', 'last_login_at', 'created_at', 'updated_at'],
  },
  {
    name: 'invites', repoKey: 'invites', isChild: false,
    columns: ['id', 'org_id', 'code', 'inviter_id', 'target_email', 'max_uses', 'use_count', 'status', 'assign_role', 'expires_at', 'created_at', 'updated_at'],
  },
  {
    name: 'codes', repoKey: 'codes', isChild: false,
    columns: ['id', 'org_id', 'user_id', 'token', 'type', 'valid_to', 'created_at', 'updated_at'],
  },
  {
    name: 'email_logs', repoKey: 'emailLogs', isChild: false,
    columns: ['id', 'creator_id', 'org_id', '"from"', '"to"', 'subject', 'body', 'created_at', 'updated_at'],
  },
  {
    name: 'audit_logs', repoKey: 'auditLogs', isChild: false,
    columns: ['id', 'org_id', 'user_id', 'action', 'module', 'entity_type', 'entity_id', 'changes', 'ip_address', 'user_agent', 'timestamp', 'created_at', 'updated_at'],
  },
  {
    name: 'files', repoKey: 'files', isChild: false,
    columns: ['id', 'org_id', 'uploaded_by', 'original_name', 'storage_path', 'storage_provider', 'mime_type', 'size', 'module', 'entity_type', 'entity_id', 'ai_recognition', 'tags', 'created_at', 'updated_at'],
  },
  {
    name: 'notifications', repoKey: 'notifications', isChild: false,
    columns: ['id', 'org_id', 'user_id', 'type', 'title', 'message', 'module', 'entity_type', 'entity_id', 'read', 'read_at', 'created_at', 'updated_at'],
  },
  {
    name: 'background_tasks', repoKey: 'backgroundTasks', isChild: false,
    columns: ['id', 'org_id', 'user_id', 'type', 'status', 'params', 'result', 'progress', 'logs', 'error', 'started_at', 'completed_at', 'created_at', 'updated_at'],
  },
  {
    name: 'org_apps', repoKey: 'orgApps', isChild: false,
    columns: ['id', 'org_id', 'app_id', 'enabled', 'activated_at', 'activated_by', 'created_at', 'updated_at'],
  },
  {
    name: 'tags', repoKey: 'tags', isChild: false,
    columns: ['id', 'org_id', 'type', 'value', 'created_at', 'updated_at'],
  },

  // ── Accounting ──
  {
    name: 'accounts', repoKey: 'accounts', isChild: false,
    columns: ['id', 'org_id', 'code', 'name', 'type', 'sub_type', 'parent_id', 'currency', 'description', 'is_system', 'is_active', 'balance', 'tags', 'created_at', 'updated_at'],
  },
  {
    name: 'fiscal_years', repoKey: 'fiscalYears', isChild: false,
    columns: ['id', 'org_id', 'name', 'start_date', 'end_date', 'status', 'closing_entry_id', 'created_at', 'updated_at'],
  },
  {
    name: 'fiscal_periods', repoKey: 'fiscalPeriods', isChild: false,
    columns: ['id', 'org_id', 'fiscal_year_id', 'name', 'number', 'start_date', 'end_date', 'status', 'created_at', 'updated_at'],
  },
  {
    name: 'journal_entries', repoKey: 'journalEntries', isChild: false,
    columns: ['id', 'org_id', 'entry_number', 'date', 'fiscal_period_id', 'description', 'reference', 'type', 'status', 'total_debit', 'total_credit', 'attachments', 'source_module', 'source_id', 'created_by', 'posted_by', 'posted_at', 'created_at', 'updated_at'],
  },
  {
    name: 'journal_entry_lines', repoKey: '', isChild: true, parentTable: 'journal_entries', parentFk: 'journal_entry_id',
    columns: ['id', 'journal_entry_id', 'account_id', 'description', 'debit', 'credit', 'currency', 'exchange_rate', 'base_debit', 'base_credit', 'contact_id', 'project_id', 'cost_center_id', 'tags', 'sort_order'],
  },
  {
    name: 'fixed_assets', repoKey: 'fixedAssets', isChild: false,
    columns: ['id', 'org_id', 'code', 'name', 'description', 'category', 'account_id', 'depreciation_account_id', 'accumulated_dep_account_id', 'purchase_date', 'purchase_price', 'currency', 'salvage_value', 'useful_life_months', 'depreciation_method', 'current_value', 'status', 'disposal_date', 'disposal_price', 'location', 'assigned_to', 'created_at', 'updated_at'],
  },
  {
    name: 'fixed_asset_depreciation', repoKey: '', isChild: true, parentTable: 'fixed_assets', parentFk: 'fixed_asset_id',
    columns: ['id', 'fixed_asset_id', 'date', 'amount', 'accumulated_amount', 'book_value', 'journal_entry_id', 'sort_order'],
  },
  {
    name: 'bank_accounts', repoKey: 'bankAccounts', isChild: false,
    columns: ['id', 'org_id', 'name', 'bank_name', 'account_number', 'iban', 'swift', 'currency', 'account_id', 'balance', 'is_default', 'is_active', 'last_reconciled_date', 'created_at', 'updated_at'],
  },
  {
    name: 'bank_reconciliations', repoKey: 'bankReconciliations', isChild: false,
    columns: ['id', 'org_id', 'bank_account_id', 'statement_date', 'statement_balance', 'book_balance', 'difference', 'status', 'reconciled_by', 'reconciled_at', 'created_at', 'updated_at'],
  },
  {
    name: 'bank_reconciliation_items', repoKey: '', isChild: true, parentTable: 'bank_reconciliations', parentFk: 'reconciliation_id',
    columns: ['id', 'reconciliation_id', 'date', 'description', 'amount', 'type', 'matched', 'journal_entry_id', 'bank_reference', 'sort_order'],
  },
  {
    name: 'tax_returns', repoKey: 'taxReturns', isChild: false,
    columns: ['id', 'org_id', 'type', 'period_from', 'period_to', 'status', 'total_tax', 'total_input', 'total_output', 'net_payable', 'filed_at', 'filed_by', 'attachments', 'created_at', 'updated_at'],
  },
  {
    name: 'tax_return_lines', repoKey: '', isChild: true, parentTable: 'tax_returns', parentFk: 'tax_return_id',
    columns: ['id', 'tax_return_id', 'description', 'taxable_amount', 'tax_rate', 'tax_amount', 'account_id', 'sort_order'],
  },
  {
    name: 'exchange_rates', repoKey: 'exchangeRates', isChild: false,
    columns: ['id', 'org_id', 'from_currency', 'to_currency', 'rate', 'date', 'source', 'created_at', 'updated_at'],
  },

  // ── Invoicing ──
  {
    name: 'contacts', repoKey: 'contacts', isChild: false,
    columns: ['id', 'org_id', 'type', 'company_name', 'first_name', 'last_name', 'email', 'phone', 'mobile', 'website', 'tax_id', 'registration_number', 'currency', 'payment_terms_days', 'credit_limit', 'discount', 'notes', 'tags', 'account_receivable_id', 'account_payable_id', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'contact_addresses', repoKey: '', isChild: true, parentTable: 'contacts', parentFk: 'contact_id',
    columns: ['id', 'contact_id', 'type', 'street', 'street2', 'city', 'state', 'postal_code', 'country', 'is_default', 'sort_order'],
  },
  {
    name: 'contact_bank_details', repoKey: '', isChild: true, parentTable: 'contacts', parentFk: 'contact_id',
    columns: ['id', 'contact_id', 'bank_name', 'account_number', 'iban', 'swift', 'currency', 'is_default', 'sort_order'],
  },
  {
    name: 'invoices', repoKey: 'invoices', isChild: false,
    columns: ['id', 'org_id', 'invoice_number', 'type', 'direction', 'status', 'contact_id', 'issue_date', 'due_date', 'currency', 'exchange_rate', 'subtotal', 'discount_total', 'tax_total', 'total', 'total_base', 'amount_paid', 'amount_due', 'notes', 'terms', 'footer', 'billing_address', 'shipping_address', 'related_invoice_id', 'converted_invoice_id', 'proforma_id', 'journal_entry_id', 'recurring_config', 'attachments', 'sent_at', 'paid_at', 'tags', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'invoice_lines', repoKey: '', isChild: true, parentTable: 'invoices', parentFk: 'invoice_id',
    columns: ['id', 'invoice_id', 'product_id', 'description', 'quantity', 'unit', 'unit_price', 'discount', 'tax_rate', 'tax_amount', 'line_total', 'account_id', 'warehouse_id', 'sort_order'],
  },
  {
    name: 'invoice_payments', repoKey: '', isChild: true, parentTable: 'invoices', parentFk: 'invoice_id',
    columns: ['id', 'invoice_id', 'date', 'amount', 'method', 'reference', 'bank_account_id', 'journal_entry_id', 'sort_order'],
  },
  {
    name: 'payment_orders', repoKey: 'paymentOrders', isChild: false,
    columns: ['id', 'org_id', 'order_number', 'type', 'contact_id', 'bank_account_id', 'amount', 'currency', 'exchange_rate', 'invoice_ids', 'reference', 'description', 'status', 'executed_at', 'journal_entry_id', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'cash_orders', repoKey: 'cashOrders', isChild: false,
    columns: ['id', 'org_id', 'order_number', 'type', 'contact_id', 'amount', 'currency', 'description', 'account_id', 'counter_account_id', 'journal_entry_id', 'created_by', 'created_at', 'updated_at'],
  },

  // ── Warehouse ──
  {
    name: 'products', repoKey: 'products', isChild: false,
    columns: ['id', 'org_id', 'sku', 'barcode', 'name', 'description', 'category', 'type', 'unit', 'purchase_price', 'selling_price', 'currency', 'tax_rate', 'revenue_account_id', 'expense_account_id', 'inventory_account_id', 'track_inventory', 'min_stock_level', 'max_stock_level', 'weight', 'dimensions', 'images', 'tags', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'product_custom_prices', repoKey: '', isChild: true, parentTable: 'products', parentFk: 'product_id',
    columns: ['id', 'product_id', 'contact_id', 'price', 'min_quantity', 'valid_from', 'valid_to', 'sort_order'],
  },
  {
    name: 'product_variants', repoKey: '', isChild: true, parentTable: 'products', parentFk: 'product_id',
    columns: ['id', 'product_id', 'name', 'options', 'sort_order'],
  },
  {
    name: 'warehouses', repoKey: 'warehouses', isChild: false,
    columns: ['id', 'org_id', 'name', 'code', 'address', 'type', 'manager', 'manager_id', 'is_default', 'is_active', 'tags', 'created_at', 'updated_at'],
  },
  {
    name: 'stock_levels', repoKey: 'stockLevels', isChild: false,
    columns: ['id', 'org_id', 'product_id', 'warehouse_id', 'quantity', 'reserved_quantity', 'available_quantity', 'avg_cost', 'last_count_date', 'created_at', 'updated_at'],
  },
  {
    name: 'stock_movements', repoKey: 'stockMovements', isChild: false,
    columns: ['id', 'org_id', 'movement_number', 'type', 'status', 'date', 'from_warehouse_id', 'to_warehouse_id', 'contact_id', 'invoice_id', 'production_order_id', 'total_amount', 'notes', 'journal_entry_id', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'stock_movement_lines', repoKey: '', isChild: true, parentTable: 'stock_movements', parentFk: 'movement_id',
    columns: ['id', 'movement_id', 'product_id', 'quantity', 'unit_cost', 'total_cost', 'batch_number', 'expiry_date', 'serial_numbers', 'sort_order'],
  },
  {
    name: 'inventory_counts', repoKey: 'inventoryCounts', isChild: false,
    columns: ['id', 'org_id', 'count_number', 'warehouse_id', 'date', 'status', 'type', 'adjustment_movement_id', 'completed_by', 'completed_at', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'inventory_count_lines', repoKey: '', isChild: true, parentTable: 'inventory_counts', parentFk: 'inventory_count_id',
    columns: ['id', 'inventory_count_id', 'product_id', 'system_quantity', 'counted_quantity', 'variance', 'variance_cost', 'notes', 'sort_order'],
  },
  {
    name: 'price_lists', repoKey: 'priceLists', isChild: false,
    columns: ['id', 'org_id', 'name', 'currency', 'is_default', 'valid_from', 'valid_to', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'price_list_items', repoKey: '', isChild: true, parentTable: 'price_lists', parentFk: 'price_list_id',
    columns: ['id', 'price_list_id', 'product_id', 'price', 'min_quantity', 'discount', 'sort_order'],
  },

  // ── Payroll ──
  {
    name: 'employees', repoKey: 'employees', isChild: false,
    columns: ['id', 'org_id', 'user_id', 'employee_number', 'first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'gender', 'national_id', 'tax_id', 'address', 'department', 'position', 'manager_id', 'employment_type', 'contract_start_date', 'contract_end_date', 'probation_end_date', 'status', 'termination_date', 'termination_reason', 'salary', 'documents', 'emergency_contact', 'notes', 'tags', 'created_at', 'updated_at'],
  },
  {
    name: 'employee_deductions', repoKey: '', isChild: true, parentTable: 'employees', parentFk: 'employee_id',
    columns: ['id', 'employee_id', 'type', 'name', 'amount', 'percentage', 'account_id', 'sort_order'],
  },
  {
    name: 'employee_benefits', repoKey: '', isChild: true, parentTable: 'employees', parentFk: 'employee_id',
    columns: ['id', 'employee_id', 'type', 'name', 'value', 'sort_order'],
  },
  {
    name: 'payroll_runs', repoKey: 'payrollRuns', isChild: false,
    columns: ['id', 'org_id', 'name', 'period_from', 'period_to', 'status', 'currency', 'totals', 'journal_entry_id', 'approved_by', 'approved_at', 'paid_at', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'payroll_run_items', repoKey: '', isChild: true, parentTable: 'payroll_runs', parentFk: 'payroll_run_id',
    columns: ['id', 'payroll_run_id', 'employee_id', 'base_salary', 'overtime_hours', 'overtime_pay', 'bonuses', 'allowances', 'gross_pay', 'deductions', 'total_deductions', 'net_pay', 'employer_contributions', 'total_employer_cost', 'sort_order'],
  },
  {
    name: 'payslips', repoKey: 'payslips', isChild: false,
    columns: ['id', 'org_id', 'payroll_run_id', 'employee_id', 'period_from', 'period_to', 'gross_pay', 'total_deductions', 'net_pay', 'year_to_date', 'payment_method', 'payment_reference', 'status', 'sent_at', 'paid_at', 'created_at', 'updated_at'],
  },
  {
    name: 'payslip_earnings', repoKey: '', isChild: true, parentTable: 'payslips', parentFk: 'payslip_id',
    columns: ['id', 'payslip_id', 'type', 'description', 'amount', 'hours', 'rate', 'sort_order'],
  },
  {
    name: 'payslip_deductions', repoKey: '', isChild: true, parentTable: 'payslips', parentFk: 'payslip_id',
    columns: ['id', 'payslip_id', 'type', 'description', 'amount', 'sort_order'],
  },
  {
    name: 'timesheets', repoKey: 'timesheets', isChild: false,
    columns: ['id', 'org_id', 'employee_id', 'date', 'hours_worked', 'overtime_hours', 'type', 'project_id', 'description', 'status', 'approved_by', 'created_at', 'updated_at'],
  },

  // ── HR ──
  {
    name: 'departments', repoKey: 'departments', isChild: false,
    columns: ['id', 'org_id', 'name', 'code', 'parent_id', 'head_id', 'description', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'leave_types', repoKey: 'leaveTypes', isChild: false,
    columns: ['id', 'org_id', 'name', 'code', 'default_days', 'is_paid', 'requires_approval', 'color', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'leave_requests', repoKey: 'leaveRequests', isChild: false,
    columns: ['id', 'org_id', 'employee_id', 'leave_type_id', 'start_date', 'end_date', 'days', 'half_day', 'reason', 'status', 'approved_by', 'approved_at', 'rejection_reason', 'attachments', 'created_at', 'updated_at'],
  },
  {
    name: 'leave_balances', repoKey: 'leaveBalances', isChild: false,
    columns: ['id', 'org_id', 'employee_id', 'leave_type_id', 'year', 'entitled', 'taken', 'pending', 'remaining', 'carried_over', 'created_at', 'updated_at'],
  },
  {
    name: 'business_trips', repoKey: 'businessTrips', isChild: false,
    columns: ['id', 'org_id', 'employee_id', 'destination', 'purpose', 'start_date', 'end_date', 'status', 'total_expenses', 'per_diem', 'advance_amount', 'settlement_amount', 'approved_by', 'created_at', 'updated_at'],
  },
  {
    name: 'business_trip_expenses', repoKey: '', isChild: true, parentTable: 'business_trips', parentFk: 'trip_id',
    columns: ['id', 'trip_id', 'date', 'category', 'description', 'amount', 'currency', 'receipt', 'sort_order'],
  },
  {
    name: 'employee_documents', repoKey: 'employeeDocuments', isChild: false,
    columns: ['id', 'org_id', 'employee_id', 'type', 'title', 'description', 'file_id', 'valid_from', 'valid_to', 'is_confidential', 'created_by', 'created_at', 'updated_at'],
  },

  // ── CRM ──
  {
    name: 'leads', repoKey: 'leads', isChild: false,
    columns: ['id', 'org_id', 'source', 'status', 'company_name', 'contact_name', 'email', 'phone', 'website', 'industry', 'estimated_value', 'currency', 'notes', 'assigned_to', 'converted_to_contact_id', 'converted_to_deal_id', 'converted_at', 'tags', 'custom_fields', 'created_at', 'updated_at'],
  },
  {
    name: 'pipelines', repoKey: 'pipelines', isChild: false,
    columns: ['id', 'org_id', 'name', 'is_default', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'pipeline_stages', repoKey: '', isChild: true, parentTable: 'pipelines', parentFk: 'pipeline_id',
    columns: ['id', 'pipeline_id', 'name', '"order"', 'probability', 'color', 'sort_order'],
  },
  {
    name: 'deals', repoKey: 'deals', isChild: false,
    columns: ['id', 'org_id', 'name', 'contact_id', 'stage', 'pipeline_id', 'value', 'currency', 'probability', 'expected_close_date', 'actual_close_date', 'status', 'lost_reason', 'assigned_to', 'notes', 'tags', 'custom_fields', 'created_at', 'updated_at'],
  },
  {
    name: 'deal_products', repoKey: '', isChild: true, parentTable: 'deals', parentFk: 'deal_id',
    columns: ['id', 'deal_id', 'product_id', 'quantity', 'unit_price', 'discount', 'total', 'sort_order'],
  },
  {
    name: 'activities', repoKey: 'activities', isChild: false,
    columns: ['id', 'org_id', 'type', 'subject', 'description', 'contact_id', 'deal_id', 'lead_id', 'assigned_to', 'due_date', 'completed_at', 'status', 'priority', 'duration', 'outcome', 'created_at', 'updated_at'],
  },

  // ── ERP ──
  {
    name: 'bill_of_materials', repoKey: 'billOfMaterials', isChild: false,
    columns: ['id', 'org_id', 'product_id', 'name', 'version', 'status', 'labor_hours', 'labor_cost_per_hour', 'overhead_cost', 'total_material_cost', 'total_cost', 'instructions', 'created_at', 'updated_at'],
  },
  {
    name: 'bom_materials', repoKey: '', isChild: true, parentTable: 'bill_of_materials', parentFk: 'bom_id',
    columns: ['id', 'bom_id', 'product_id', 'quantity', 'unit', 'wastage_percent', 'cost', 'notes', 'sort_order'],
  },
  {
    name: 'production_orders', repoKey: 'productionOrders', isChild: false,
    columns: ['id', 'org_id', 'order_number', 'bom_id', 'product_id', 'quantity', 'warehouse_id', 'output_warehouse_id', 'status', 'priority', 'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'quantity_produced', 'quantity_defective', 'total_cost', 'cost_per_unit', 'notes', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'production_stages', repoKey: '', isChild: true, parentTable: 'production_orders', parentFk: 'production_order_id',
    columns: ['id', 'production_order_id', 'name', '"order"', 'status', 'planned_duration', 'actual_duration', 'assigned_to', 'started_at', 'completed_at', 'notes', 'quality_checks', 'sort_order'],
  },
  {
    name: 'materials_consumed', repoKey: '', isChild: true, parentTable: 'production_orders', parentFk: 'production_order_id',
    columns: ['id', 'production_order_id', 'product_id', 'planned_quantity', 'actual_quantity', 'wastage', 'movement_id', 'sort_order'],
  },
  {
    name: 'construction_projects', repoKey: 'constructionProjects', isChild: false,
    columns: ['id', 'org_id', 'project_number', 'name', 'client_id', 'address', 'status', 'start_date', 'expected_end_date', 'actual_end_date', 'budget', 'total_invoiced', 'total_paid', 'margin', 'documents', 'notes', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'construction_phases', repoKey: '', isChild: true, parentTable: 'construction_projects', parentFk: 'project_id',
    columns: ['id', 'project_id', 'name', '"order"', 'status', 'start_date', 'end_date', 'budget', 'spent', 'sort_order'],
  },
  {
    name: 'construction_phase_tasks', repoKey: '', isChild: true, parentTable: 'construction_phases', parentFk: 'phase_id',
    columns: ['id', 'phase_id', 'name', 'assigned_to', 'status', 'due_date', 'completed_at', 'sort_order'],
  },
  {
    name: 'construction_team_members', repoKey: '', isChild: true, parentTable: 'construction_projects', parentFk: 'project_id',
    columns: ['id', 'project_id', 'employee_id', 'role', 'start_date', 'end_date', 'sort_order'],
  },
  {
    name: 'construction_materials', repoKey: '', isChild: true, parentTable: 'construction_projects', parentFk: 'project_id',
    columns: ['id', 'project_id', 'product_id', 'quantity', 'unit_cost', 'total_cost', 'delivery_date', 'status', 'movement_id', 'sort_order'],
  },
  {
    name: 'pos_sessions', repoKey: 'posSessions', isChild: false,
    columns: ['id', 'org_id', 'warehouse_id', 'cashier_id', 'session_number', 'opened_at', 'closed_at', 'status', 'opening_balance', 'closing_balance', 'expected_balance', 'difference', 'currency', 'total_sales', 'total_returns', 'total_cash', 'total_card', 'transaction_count', 'created_at', 'updated_at'],
  },
  {
    name: 'pos_transactions', repoKey: 'posTransactions', isChild: false,
    columns: ['id', 'org_id', 'session_id', 'transaction_number', 'type', 'customer_id', 'subtotal', 'discount_total', 'tax_total', 'total', 'change_due', 'invoice_id', 'movement_id', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'pos_transaction_lines', repoKey: '', isChild: true, parentTable: 'pos_transactions', parentFk: 'transaction_id',
    columns: ['id', 'transaction_id', 'product_id', 'name', 'quantity', 'unit_price', 'discount', 'tax_rate', 'tax_amount', 'line_total', 'sort_order'],
  },
  {
    name: 'pos_transaction_payments', repoKey: '', isChild: true, parentTable: 'pos_transactions', parentFk: 'transaction_id',
    columns: ['id', 'transaction_id', 'method', 'amount', 'reference', 'sort_order'],
  },
]

/** Get only parent (non-child) tables */
export function getParentTables(): TableMeta[] {
  return TABLE_REGISTRY.filter(t => !t.isChild)
}

/** Get only child tables */
export function getChildTables(): TableMeta[] {
  return TABLE_REGISTRY.filter(t => t.isChild)
}

/** Get all trackable tables (excludes system tables prefixed with _) */
export function getTrackableTables(): TableMeta[] {
  return TABLE_REGISTRY
}

/** Map repoKey to table name */
export function getTableByRepoKey(repoKey: string): TableMeta | undefined {
  return TABLE_REGISTRY.find(t => t.repoKey === repoKey)
}
