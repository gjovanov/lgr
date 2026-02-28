import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from '../composables/useHttpClient'
import { vuetify } from '../plugins/vuetify'
import { i18n } from '../plugins/i18n'

export interface User {
  _id: string
  username: string
  email: string
  firstName: string
  lastName: string
  role: string
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
  const token = ref(localStorage.getItem('lgr_token') || '')
  const user = ref<User | null>(null)
  const currentOrg = ref<Organization | null>(
    JSON.parse(localStorage.getItem('lgr_org') || 'null')
  )

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
  async function login(username: string, password: string, orgSlug: string) {
    const { data } = await httpClient.post('/auth/login', { username, password, orgSlug })
    token.value = data.token
    user.value = data.user
    currentOrg.value = data.org
    localStorage.setItem('lgr_token', data.token)
    localStorage.setItem('lgr_org', JSON.stringify(data.org))
  }

  async function register(payload: {
    orgName: string
    orgSlug: string
    email: string
    username: string
    password: string
    firstName: string
    lastName: string
    baseCurrency: string
    locale: string
  }) {
    const { data } = await httpClient.post('/auth/register', payload)
    token.value = data.token
    user.value = data.user
    currentOrg.value = data.org
    localStorage.setItem('lgr_token', data.token)
    localStorage.setItem('lgr_org', JSON.stringify(data.org))
  }

  async function registerOAuth(payload: {
    oauthToken: string
    orgName: string
    orgSlug: string
    username: string
  }) {
    const { data } = await httpClient.post('/oauth/register-oauth', payload)
    token.value = data.token
    user.value = data.user
    currentOrg.value = data.org
    localStorage.setItem('lgr_token', data.token)
    localStorage.setItem('lgr_org', JSON.stringify(data.org))
  }

  function logout() {
    token.value = ''
    user.value = null
    currentOrg.value = null
    localStorage.removeItem('lgr_token')
    localStorage.removeItem('lgr_org')
  }

  function setTheme(newTheme: string) {
    theme.value = newTheme
    localStorage.setItem('lgr_theme', newTheme)
    vuetify.theme.global.name.value = newTheme
  }

  function toggleTheme() {
    setTheme(theme.value === 'light' ? 'dark' : 'light')
  }

  function setLocale(newLocale: string) {
    locale.value = newLocale
    i18n.global.locale.value = newLocale
    localStorage.setItem('lgr_locale', newLocale)
  }

  async function fetchProfile() {
    const { data } = await httpClient.get('/auth/me')
    user.value = data.user
    currentOrg.value = data.org
    if (data.org) {
      localStorage.setItem('lgr_org', JSON.stringify(data.org))
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
    login,
    register,
    registerOAuth,
    logout,
    setTheme,
    toggleTheme,
    setLocale,
    fetchProfile,
    toggleDrawer,
  }
})
