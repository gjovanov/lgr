import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
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

export interface OrgAddress {
  type: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault?: boolean
}

export interface OrgBankDetail {
  bankName: string
  accountNumber?: string
  iban?: string
  swift?: string
  currency?: string
  isDefault?: boolean
}

export interface Organization {
  id: string
  name: string
  slug: string
  baseCurrency?: string
  locale?: string
  taxNumber?: string
  vatNumber?: string
  email?: string
  phone?: string
  website?: string
  addresses?: OrgAddress[]
  bankDetails?: OrgBankDetail[]
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

  /**
   * Finish an OAuth sign-in started in this browser.
   *
   * The same shape as `login()`, deliberately: the callback's response body is the login
   * response body. The credential is the single-use, httpOnly `oauth_handoff` cookie the OAuth
   * callback set — there is nothing to pass in, and nothing was read from the URL. The URL used
   * to carry the JWT, which let anyone sign a visitor into their own account.
   */
  async function completeOAuthLogin() {
    const { data } = await httpClient.post('/auth/oauth-code/redeem')
    applySession(data)
  }

  /**
   * FR-14.14 — finish a DESKTOP OAuth sign-in.
   *
   * ⚠ Both halves are required and neither came from a place an attacker can reach: the code
   * arrived over `lgr://login` and the verifier never left the shell until it put both in this
   * window's URL fragment, which no server and no log sees.
   */
  async function completeDesktopOAuthLogin(code: string, verifier: string) {
    const { data } = await httpClient.post('/auth/desktop-code/redeem', { code, verifier })
    applySession(data)
  }

  /**
   * ⚠ Exactly what `login()` does with its response, in one place. The SPAs treat a browser as
   * signed in only when `localStorage.lgr_token` is set and send it as a bearer header, so a
   * cookie alone leaves the app looking signed out to its own router — which is why both redeem
   * paths mirror the login response rather than inventing a shape.
   */
  function applySession(data: any) {
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
    completeOAuthLogin,
    completeDesktopOAuthLogin,
    logout,
    setTheme,
    toggleTheme,
    setLocale,
    fetchProfile,
    toggleDrawer,
  }
})
