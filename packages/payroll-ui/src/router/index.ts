import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, portalHref } from 'ui-shared/nav/navigate'
import { hasOrgSession, isPersonOnly } from 'ui-shared/session/session'

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
      { path: 'runs/new', name: 'payroll.runs.new', component: () => import('../views/payroll/PayrollRunFormView.vue') },
      { path: 'runs/:id/edit', name: 'payroll.runs.edit', component: () => import('../views/payroll/PayrollRunFormView.vue') },
      { path: 'payslips', name: 'payroll.payslips', component: () => import('../views/payroll/PayslipsView.vue') },
      { path: 'timesheets', name: 'payroll.timesheets', component: () => import('../views/payroll/TimesheetsView.vue') },
      { path: 'timesheets/new', name: 'payroll.timesheets.new', component: () => import('../views/payroll/TimesheetFormView.vue') },
      { path: 'timesheets/:id/edit', name: 'payroll.timesheets.edit', component: () => import('../views/payroll/TimesheetFormView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  // An org session, in THIS tab. A person signed in without one yet picks an org on the portal.
  if (!hasOrgSession()) {
    window.location.href = portalHref(isPersonOnly() ? '/orgs' : '/')
    return
  }
  next()
})
