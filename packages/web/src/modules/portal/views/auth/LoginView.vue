<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.signInTitle') }}</v-card-title>
    <v-card-text class="px-6">
      <v-alert v-if="notice" type="info" variant="tonal" density="compact" class="mb-4">{{ notice }}</v-alert>
      <!-- FR-20.39: on a linked server, the person's lgrai.app account first; the local password is for outages. -->
      <template v-if="lgr">
        <v-btn block color="primary" size="large" prepend-icon="mdi-shield-account" data-test="sign-in-with-lgr" class="mb-3" @click="lgrSignIn(lgr)">{{ $t('idp.signInWithLgr') }}</v-btn>
        <div class="text-center text-body-2 text-medium-emphasis mb-3">{{ $t('idp.orLocal') }}</div>
      </template>
      <v-form @submit.prevent="handleLogin">
        <v-text-field
          v-model="form.username"
          :label="$t('auth.usernameOrEmail')"
          prepend-inner-icon="mdi-account"
          autocomplete="username"
          required
          class="mb-2"
        />
        <v-text-field
          v-model="form.password"
          :label="$t('auth.password')"
          prepend-inner-icon="mdi-lock"
          :type="showPassword ? 'text' : 'password'"
          :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="current-password"
          required
          class="mb-2"
          @click:append-inner="showPassword = !showPassword"
        />
        <!--
          The org is optional: a person signs in once and lands in their last org, or picks one.
          It is revealed by a LINK (not a second "sign in" button, which tests and screen readers
          would confuse with the real one), or by the server when a username is ambiguous.
        -->
        <v-expand-transition>
          <v-text-field
            v-if="showOrg"
            v-model="form.orgSlug"
            :label="$t('auth.organization')"
            :hint="$t('auth.organizationHint')"
            persistent-hint
            prepend-inner-icon="mdi-domain"
            class="mb-4"
          />
        </v-expand-transition>
        <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>
        <v-btn type="submit" color="primary" block size="large" :loading="loading">{{ $t('auth.login') }}</v-btn>
      </v-form>
      <div class="d-flex flex-wrap justify-space-between ga-2 mt-3 text-body-2">
        <a v-if="!showOrg" href="#" @click.prevent="showOrg = true">{{ $t('auth.specificOrg') }}</a>
        <span v-else />
        <router-link :to="{ name: 'auth.forgot-password' }">{{ $t('auth.forgotPassword') }}</router-link>
      </div>
      <!-- S-06: the only way to finish a registration is its email, so a lost one must be recoverable. -->
      <div class="text-right mt-1">
        <router-link to="/auth/activate" class="text-body-2">{{ $t('auth.activation.missingEmail') }}</router-link>
      </div>
    </v-card-text>
    <template v-if="providers.length">
      <v-divider class="mx-6" />
      <v-card-text class="text-center pb-2 text-body-2">{{ $t('auth.orLoginWith') }}</v-card-text>
      <div class="d-flex flex-wrap justify-center ga-2 px-6 pb-4">
        <v-btn
          v-for="p in providers"
          :key="p.name"
          :color="p.color"
          variant="outlined"
          size="small"
          @click="oauthLogin(p.name)"
        >
          <v-icon start>{{ p.icon }}</v-icon>
          {{ p.label }}
        </v-btn>
      </div>
    </template>
    <v-card-actions class="justify-center pb-6">
      <span class="text-body-2">{{ $t('auth.noAccount') }}</span>
      <router-link to="/auth/register" class="ml-1">{{ $t('auth.register') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore, type SignInAnswer } from '../../store/app.store'
import { useOAuthProviders } from 'ui-shared/composables/useOAuthProviders'
import { lastOrgId } from 'ui-shared/session/session'
import { signInErrorMessage } from './sign-in-errors'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { rememberReturnPath, safeReturnPath } from 'ui-shared/nav/return-path'
import { startLgrSignIn, takeIdpResume } from './idp'

/**
 * Sign in once, as a person (multi-org sign-in, Phase 3): a username or an email and a password,
 * or a provider. No org is needed; the server lands the person in the org this browser was last
 * in, one they chose before, or the only one they have, and otherwise they pick (`/orgs`).
 */

const appStore = useAppStore()
const router = useRouter()
const route = useRoute()
const { t, te } = useI18n()
const { providers, load: loadProviders } = useOAuthProviders()

const loading = ref(false)
const error = ref('')
const notice = ref('')
const showPassword = ref(false)
const showOrg = ref(false)
const form = reactive({ orgSlug: '', username: '', password: '' })
/** A linked master offers "Sign in with LGR" (FR-20.39); lgrai.app answers 404. */
const lgr = ref<{ server: string; clientId: string } | null>(null)
/**
 * FR-22.53: the page the person was on when their session ended (a 401, or a bookmark opened in a
 * tab whose session had expired). Signing in goes back there. Only a path `safeReturnPath` would
 * follow survives: this parameter is whatever the link says.
 */
const next = safeReturnPath(route.query.next)

onMounted(() => {
  const invite = route.query.invite as string
  if (invite) sessionStorage.setItem('lgr_invite_code', invite)
  if (typeof route.query.org === 'string' && route.query.org) {
    form.orgSlug = route.query.org
    showOrg.value = true
  }
  // An OAuth sign-in that did not work comes back here with a CODE, never a message: a crafted
  // link must not be able to put arbitrary text on our sign-in page.
  if (typeof route.query.error === 'string' && route.query.error) {
    error.value = signInErrorMessage(route.query.error, t, te)
  }
  if (route.query.reset === 'done') notice.value = t('auth.reset.done')
  else if (next) notice.value = t('auth.continueAfterSignIn')
  loadProviders()
  httpClient.get('/auth/idp/config').then(({ data }) => { if (data?.enabled) lgr.value = { server: data.server, clientId: data.clientId } }).catch(() => {})
})

/**
 * Where a provider sign-in lands: the org typed here (the old, org-scoped path), else wherever
 * the person is let in; `prefer` names the org this browser was last in. A pending invitation is
 * NOT sent along: the person signs in as themselves first, and the callback page takes them to
 * the invitation, where joining is their explicit choice.
 */
function oauthLogin(provider: string) {
  const params = new URLSearchParams()
  if (showOrg.value && form.orgSlug.trim()) params.set('org_slug', form.orgSlug.trim())
  else if (lastOrgId()) params.set('prefer', lastOrgId())
  const query = params.toString()
  // The provider hands back no query, so the page to return to waits in this tab.
  rememberReturnPath(next)
  window.location.href = `/api/oauth/${provider}${query ? `?${query}` : ''}`
}

function lgrSignIn(cfg: { server: string; clientId: string }) {
  rememberReturnPath(next)
  startLgrSignIn(cfg)
}

/** After any sign-in: an invitation waiting, the org picker, the page the person came from, or the app. */
function proceed(answer: SignInAnswer) {
  // FR-20.39: a server's "Sign in with LGR" sent the person here to sign in to lgrai.app first.
  const resume = takeIdpResume()
  if (resume) return router.push(resume)
  const invite = sessionStorage.getItem('lgr_invite_code')
  if (invite) router.push({ name: 'invite', params: { code: invite } })
  else if (answer.needsOrgChoice) router.push({ name: 'orgs', query: next ? { next } : undefined })
  // A page load: the page is usually in another app.
  else if (next) window.location.assign(next)
  else router.push('/dashboard')
}

async function handleLogin() {
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    proceed(await appStore.login(form.username, form.password, showOrg.value ? form.orgSlug : undefined))
  } catch (err: any) {
    const code = err?.response?.data?.code
    if (code === 'ambiguous_login') showOrg.value = true
    error.value = code ? signInErrorMessage(code, t, te) : err?.response?.data?.message || t('auth.errors.failed')
  } finally {
    loading.value = false
  }
}
</script>
