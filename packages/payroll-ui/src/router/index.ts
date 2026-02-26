import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'payroll.employees' } },
      { path: 'employees', name: 'payroll.employees', component: () => import('../views/payroll/EmployeesView.vue') },
      { path: 'employees/new', name: 'payroll.employee-new', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'employees/:id/edit', name: 'payroll.employee-edit', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'runs', name: 'payroll.runs', component: () => import('../views/payroll/PayrollRunsView.vue') },
      { path: 'payslips', name: 'payroll.payslips', component: () => import('../views/payroll/PayslipsView.vue') },
      { path: 'timesheets', name: 'payroll.timesheets', component: () => import('../views/payroll/TimesheetsView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept token from URL params (Portal passes it for cross-origin navigation)
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    // Full reload so Pinia store re-initializes with the new localStorage values
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    url.searchParams.delete('org')
    window.location.replace(url.toString())
    return
  }

  const token = localStorage.getItem('lgr_token')
  if (!token) {
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
