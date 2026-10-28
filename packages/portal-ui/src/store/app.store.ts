import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import {
  getOrg,
  getToken,
  lastOrgId,
  logoutEverywhere,
  setSession,
  updateOrg,
} from 'ui-shared/session/session'
import type { OrgChoice } from 'ui-shared/session/useOrgSession'
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

/** Who is signed in, as a person (from `/auth/me` or a sign-in that has not chosen an org). */
export interface Person {
  id: string
  email: string
  firstName: string
  lastName: string
  emailVerified?: boolean
  hasPassword?: boolean
  passwordSetBy?: 'self' | 'admin' | 'legacy' | null
  providers?: { provider: string; verified: boolean }[]
  /** FR-20.42: on a linked master, the lgrai.app where the person's name, email and password are changed. */
  manageOn?: string | null
}

/** What `/auth/login` and the OAuth redeem answer. */
export interface SignInAnswer {
  token: string
  needsOrgChoice: boolean
  user?: User
  org?: Organization
  orgs?: OrgChoice[]
  identity?: Person
}

export const useAppStore = defineStore('app', () => {
  // Auth state: this tab's session (multi-org: each tab keeps its own org, see ui-shared/session).
  const token = ref(getToken())
  const user = ref<User | null>(null)
  const currentOrg = ref<Organization | null>(getOrg<Organization>())
  /** The signed-in person, when known (a linked account). */
  const person = ref<Person | null>(null)

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
  /**
   * Sign in with a username or an email. `orgSlug` is optional: without it the person lands in
   * the org this browser was last in, or one they chose before, or chooses (`needsOrgChoice`).
   */
  async function login(username: string, password: string, orgSlug?: string): Promise<SignInAnswer> {
    const body: Record<string, string> = { username, password }
    if (orgSlug?.trim()) body.orgSlug = orgSlug.trim()
    const preferred = lastOrgId()
    if (preferred) body.preferredOrgId = preferred
    const { data } = await httpClient.post('/auth/login', body)
    applySession(data)
    return data
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
    // ⚠ A password registration does NOT sign anyone in. The account is created inactive and is
    // activated from the emailed link (S-06), so there is no token to store. This used to write
    // `data.token` regardless, which stored the string "undefined" as the session: the router then
    // believed the visitor was signed in, and the first API call bounced them out with a 401.
    const { data } = await httpClient.post('/auth/register', payload)
    return data as { message: string; userId: string; org: { id: string; name: string; slug: string } }
  }

  /** S-06 — ask for a new activation link. The server answers the same for every address. */
  async function resendActivation(email: string): Promise<string> {
    const { data } = await httpClient.post('/auth/activate/resend', { email })
    return data.message as string
  }

  /** S-06 — redeem the code from an activation link. */
  async function activate(userId: string, code: string): Promise<void> {
    await httpClient.post('/auth/activate', { userId, token: code })
  }

  /**
   * Who is signing up, for the register form's prefill, after the OAuth callback (register mode)
   * sent the browser to `/auth/register?oauth=1`.
   *
   * The identity comes from the httpOnly `oauth_pending` cookie the callback set, read on the
   * server — never from the URL, which used to carry it as a JWT (security review S-19). Rejects
   * with a 400 when no sign-up is in progress in this browser.
   */
  async function fetchOAuthSignup(): Promise<{ provider: string; email: string; name: string }> {
    const { data } = await httpClient.get('/oauth/pending')
    return data
  }

  /**
   * Finish an OAuth sign-up. The body says what to create; WHO it is for is the `oauth_pending`
   * cookie's business, so there is no token to pass in.
   */
  async function registerOAuth(payload: {
    orgName: string
    orgSlug: string
    username: string
  }) {
    const { data } = await httpClient.post('/oauth/pending/register', payload)
    applySession(data)
  }

  /**
   * Finish an OAuth sign-in started in this browser.
   *
   * The same shape as `login()`, deliberately: the callback's response body is the login
   * response body. The credential is the single-use, httpOnly `oauth_handoff` cookie the OAuth
   * callback set — there is nothing to pass in, and nothing was read from the URL. The URL used
   * to carry the JWT, which let anyone sign a visitor into their own account.
   */
  async function completeOAuthLogin(): Promise<SignInAnswer> {
    const { data } = await httpClient.post('/auth/oauth-code/redeem')
    applySession(data)
    return data
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

  /** FR-20.39: on a master, the code lgrai.app sent the person back with, redeemed by the server. */
  async function completeLgrSignIn(code: string, codeVerifier: string, redirectUri: string): Promise<SignInAnswer> {
    const { data } = await httpClient.post('/auth/idp/redeem', { code, codeVerifier, redirectUri })
    applySession(data)
    return data
  }

  /**
   * ⚠ Every sign-in answer becomes this tab's session here, in one place. The SPAs treat a tab as
   * signed in only when it holds a session token and send it as a bearer header, so a cookie
   * alone leaves the app looking signed out to its own router. That is why both redeem paths
   * mirror the login response rather than inventing a shape.
   *
   * A person who has not chosen an org yet (`needsOrgChoice`) holds an identity-only token: it
   * reaches their org list and the switch, nothing else, and the router sends them to the picker.
   */
  function applySession(data: SignInAnswer) {
    token.value = data.token
    if (data.needsOrgChoice) {
      setSession(data.token, null)
      user.value = null
      currentOrg.value = null
      person.value = data.identity ?? null
      return
    }
    setSession(data.token, data.org ?? null)
    user.value = data.user ?? null
    currentOrg.value = data.org ?? null
  }

  /** Sign out of this tab and of every other tab where the same person is signed in. */
  async function logout() {
    await logoutEverywhere(() => httpClient.post('/auth/logout'))
    token.value = ''
    user.value = null
    currentOrg.value = null
    person.value = null
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
    person.value = data.identity ?? null
    if (data.org) updateOrg(data.org)
  }

  /** This tab's session after a password change: the server ended every other one. */
  function replaceToken(next: string) {
    setSession(next, currentOrg.value)
    token.value = next
  }

  function toggleDrawer() {
    leftDrawer.value = !leftDrawer.value
  }

  return {
    // State
    token,
    user,
    currentOrg,
    person,
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
    resendActivation,
    activate,
    fetchOAuthSignup,
    registerOAuth,
    completeOAuthLogin,
    completeDesktopOAuthLogin,
    completeLgrSignIn,
    applySession,
    replaceToken,
    logout,
    setTheme,
    toggleTheme,
    setLocale,
    fetchProfile,
    toggleDrawer,
  }
})
