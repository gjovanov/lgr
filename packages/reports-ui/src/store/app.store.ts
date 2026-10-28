import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { getOrg, getToken, logoutEverywhere, updateOrg } from 'ui-shared/session/session'
import { portalHref } from 'ui-shared/nav/navigate'
import { getI18n, getVuetify } from 'ui-shared/plugins'

export interface User {
  _id: string
  id: string
  username: string
  email: string
  firstName: string
  lastName: string
  role: string
  orgId: string
  permissions: string[]
}

export interface Organization {
  id: string
  name: string
  slug: string
  baseCurrency?: string
  locale?: string
}

export const useAppStore = defineStore('app', () => {
  // Auth state
  // This tab's session (multi-org: each tab keeps its own org, see ui-shared/session).
  const token = ref(getToken())
  const user = ref<User | null>(null)
  const currentOrg = ref<Organization | null>(getOrg<Organization>())

  // UI state
  const leftDrawer = ref(true)
  const locale = ref(localStorage.getItem('lgr_locale') || 'en')
  const theme = ref(localStorage.getItem('lgr_theme') || 'light')

  // Getters
  const isAuth = computed(() => !!token.value)
  const isDark = computed(() => theme.value === 'dark')
  const orgId = computed(() => currentOrg.value?.id || '')
  const fullName = computed(() => {
    if (!user.value) return ''
    return `${user.value.firstName} ${user.value.lastName}`.trim()
  })
  const initials = computed(() => {
    if (!user.value) return ''
    return `${user.value.firstName?.[0] || ''}${user.value.lastName?.[0] || ''}`
  })

  function orgUrl() {
    return `/org/${currentOrg.value?.id}`
  }

  // Actions
  async function logout() {
    // Every tab where this person is signed in signs out with this one.
    await logoutEverywhere(() => httpClient.post('/auth/logout'))
    token.value = ''
    user.value = null
    currentOrg.value = null
    window.location.href = portalHref('/auth/login')
  }

  function setTheme(newTheme: string) {
    theme.value = newTheme
    localStorage.setItem('lgr_theme', newTheme)
    getVuetify().theme.global.name.value = newTheme
  }

  function toggleTheme() {
    setTheme(theme.value === 'light' ? 'dark' : 'light')
  }

  function setLocale(newLocale: string) {
    locale.value = newLocale
    getI18n().global.locale.value = newLocale
    localStorage.setItem('lgr_locale', newLocale)
  }

  async function fetchProfile() {
    // Fetch from Portal API
    try {
      const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
      const { data } = await httpClient.get(`${portalBase}/auth/me`)
      user.value = data.user
      currentOrg.value = data.org
      if (data.org) updateOrg(data.org)
    } catch {
      // A 401 has already signed this tab out (useHttpClient). Anything else (offline, a 5xx) is
      // no reason to sign the person out of every tab.
      if (!getToken()) window.location.href = portalHref('/')
    }
  }

  function toggleDrawer() {
    leftDrawer.value = !leftDrawer.value
  }

  return {
    // State
    token,
    user,
    currentOrg,
    leftDrawer,
    locale,
    theme,
    // Getters
    isAuth,
    isDark,
    orgId,
    fullName,
    initials,
    // Helpers
    orgUrl,
    // Actions
    logout,
    setTheme,
    toggleTheme,
    setLocale,
    fetchProfile,
    toggleDrawer,
  }
})
