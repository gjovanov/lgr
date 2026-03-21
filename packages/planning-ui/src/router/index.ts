import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'planning.shifts' } },
      { path: 'shifts', name: 'planning.shifts', component: () => import('../views/planning/ShiftsView.vue') },
      { path: 'templates', name: 'planning.templates', component: () => import('../views/planning/ShiftTemplatesView.vue') },
      { path: 'appointments', name: 'planning.appointments', component: () => import('../views/planning/AppointmentsView.vue') },
      { path: 'appointments/new', name: 'planning.appointments.new', component: () => import('../views/planning/AppointmentFormView.vue') },
      { path: 'appointments/:id', name: 'planning.appointments.edit', component: () => import('../views/planning/AppointmentFormView.vue') },
      { path: 'appointment-types', name: 'planning.appointmentTypes', component: () => import('../views/planning/AppointmentTypesView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to, _from, next) => {
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
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
