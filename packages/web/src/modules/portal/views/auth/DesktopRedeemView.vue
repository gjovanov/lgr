<template>
  <v-card elevation="8" class="pa-6 text-center">
    <v-progress-circular v-if="!error" indeterminate color="primary" size="64" />
    <div v-if="!error" class="mt-4 text-body-1">Completing sign-in…</div>
    <v-alert v-if="error" type="error" class="mt-4">
      {{ error }}
      <template #append>
        <v-btn variant="text" to="/auth/login">Back to login</v-btn>
      </template>
    </v-alert>
  </v-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'

/**
 * FR-14.14 — where `lgr-web` lands after an OAuth sign-in that ran in the system browser.
 *
 * ⚠ Both values arrive in the URL **fragment**, never the query. A fragment is not sent to a
 * server and does not appear in an access log, which is the entire reason the verifier rides
 * there: it is the half of the credential that makes the one-time code redeemable, and the code
 * came over `lgr://`, a scheme any program on the machine can register.
 *
 * ⚠ The fragment is cleared with `history.replaceState` before the POST, so it cannot survive
 * into a bookmark, a back-button entry or a screenshot of the address bar.
 *
 * ⚠ No `?token=` anywhere, and none is ever to be added (FR-14.24). The token only ever exists
 * in the POST response body.
 */

const router = useRouter()
const appStore = useAppStore()
const error = ref('')

function readFragment(): { code: string; verifier: string } {
  // `location.hash` includes the leading `#`.
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return {
    code: params.get('code') || '',
    verifier: params.get('verifier') || '',
  }
}

onMounted(async () => {
  const { code, verifier } = readFragment()

  // Clear FIRST, before any await. A failed redeem must not leave the pair sitting in the
  // address bar while an error message is on screen.
  try {
    window.history.replaceState(null, '', window.location.pathname)
  } catch {
    /* a webview that refuses replaceState still gets the redeem below */
  }

  if (!code || !verifier) {
    error.value = 'This sign-in link is incomplete. Please try signing in again.'
    return
  }

  try {
    await appStore.completeDesktopOAuthLogin(code, verifier)
    // FR-14.16 — the desktop's assigned start page is applied by the shell when it opens the
    // window; from here the portal's own landing page is the right default.
    router.push('/dashboard')
  } catch (e: any) {
    // The server answers 400 with ONE message for every refusal — unknown code, expired,
    // already used, wrong verifier, revoked desktop — so there is nothing here to tell them
    // apart with, by design. A stack trace would be worse than useless on a till.
    error.value = e?.response?.data?.message || 'Could not complete sign-in. Please try again.'
    appStore.logout()
  }
})
</script>
