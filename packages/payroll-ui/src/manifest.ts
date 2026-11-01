import type { ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the payroll module as data. Paths are relative to the module (`/payroll`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 */
export const manifest: ModuleManifest = {
  id: 'payroll',
  base: '/payroll',
  titleKey: 'apps.payroll',
  pendingChanges: true,
  menu: [
  { labelKey: 'payroll.employees', icon: 'mdi-account-multiple', to: '/employees' },
  { labelKey: 'payroll.payrollRuns', icon: 'mdi-cash-register', to: '/runs' },
  { labelKey: 'payroll.payslips', icon: 'mdi-file-document-outline', to: '/payslips' },
  { labelKey: 'payroll.timesheets', icon: 'mdi-clock-outline', to: '/timesheets' },
],
  routes: [
      { path: '', redirect: { name: 'payroll.employees' } },
      { path: 'employees', name: 'payroll.employees', component: () => import('./views/payroll/EmployeesView.vue') },
      { path: 'employees/new', name: 'payroll.employee-new', component: () => import('./views/payroll/EmployeeFormView.vue') },
      { path: 'employees/:id/edit', name: 'payroll.employee-edit', component: () => import('./views/payroll/EmployeeFormView.vue') },
      { path: 'runs', name: 'payroll.runs', component: () => import('./views/payroll/PayrollRunsView.vue') },
      { path: 'runs/new', name: 'payroll.runs.new', component: () => import('./views/payroll/PayrollRunFormView.vue') },
      { path: 'runs/:id/edit', name: 'payroll.runs.edit', component: () => import('./views/payroll/PayrollRunFormView.vue') },
      { path: 'payslips', name: 'payroll.payslips', component: () => import('./views/payroll/PayslipsView.vue') },
      { path: 'timesheets', name: 'payroll.timesheets', component: () => import('./views/payroll/TimesheetsView.vue') },
      { path: 'timesheets/new', name: 'payroll.timesheets.new', component: () => import('./views/payroll/TimesheetFormView.vue') },
      { path: 'timesheets/:id/edit', name: 'payroll.timesheets.edit', component: () => import('./views/payroll/TimesheetFormView.vue') },
    ],
}
