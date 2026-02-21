import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/payroll/employees' },
      // Payroll routes
      { path: 'payroll/employees', name: 'payroll.employees', component: () => import('../views/payroll/EmployeesView.vue') },
      { path: 'payroll/employees/new', name: 'payroll.employee-new', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/employees/:id/edit', name: 'payroll.employee-edit', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/runs', name: 'payroll.runs', component: () => import('../views/payroll/PayrollRunsView.vue') },
      { path: 'payroll/payslips', name: 'payroll.payslips', component: () => import('../views/payroll/PayslipsView.vue') },
      { path: 'payroll/timesheets', name: 'payroll.timesheets', component: () => import('../views/payroll/TimesheetsView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('lgr_token')
  if (!token) {
    // Redirect to Portal for login
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
