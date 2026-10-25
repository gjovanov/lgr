<template>
  <v-card elevation="8">
    <v-card-title class="text-h6 pt-6 text-center">{{ $t('idp.signingIn') }}</v-card-title>
    <v-card-text class="px-6 pb-6">
      <v-progress-linear v-if="!error" indeterminate />
      <template v-else>
        <v-alert type="error" variant="tonal" class="mb-4" data-test="idp-desktop-error">{{ error }}</v-alert>
        <v-btn block color="primary" :to="{ name: 'auth.login' }">{{ $t('idp.backToSignIn') }}</v-btn>
      </template>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'

/**
 * FR-20.39 (plan step P2-4b) — where the desktop shell sends `lgr-web` to finish a master's "Sign in
 * with LGR" that ran in the system browser: the code came back over `lgr://login`, and the shell
 * kept the verifier. Both arrive in the URL FRAGMENT, which no server and no log ever receives,
 * exactly as `DesktopRedeemView` does for an OAuth sign-in (FR-14.14).
 *
 * ⚠ The fragment is cleared before anything is awaited. The code was issued for `lgr://login`, so
 * that is the redirect the server redeems it with.
 */

const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const error = ref('')

onMounted(async () => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const code = params.get('code') || ''
  const verifier = params.get('verifier') || ''
  try {
    window.history.replaceState(null, '', window.location.pathname)
  } catch {
    /* a webview that refuses replaceState still gets the redeem below */
  }
  if (!code || !verifier) {
    error.value = t('idp.notStartedHere')
    return
  }
  try {
    const answer = await appStore.completeLgrSignIn(code, verifier, 'lgr://login')
    router.replace(answer.needsOrgChoice ? { name: 'orgs' } : '/dashboard')
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  }
})
</script>
