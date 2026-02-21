import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/hr/departments' },
      // HR routes
      { path: 'hr/departments', name: 'hr.departments', component: () => import('../views/hr/DepartmentsView.vue') },
      { path: 'hr/leave', name: 'hr.leave', component: () => import('../views/hr/LeaveManagementView.vue') },
      { path: 'hr/business-trips', name: 'hr.business-trips', component: () => import('../views/hr/BusinessTripsView.vue') },
      { path: 'hr/documents', name: 'hr.documents', component: () => import('../views/hr/EmployeeDocumentsView.vue') },
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
