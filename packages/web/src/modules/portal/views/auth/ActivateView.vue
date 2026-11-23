<template>
  <v-card elevation="8">
    <v-card-title v-if="titleKey" class="text-h5 text-center pt-6">{{ $t(titleKey) }}</v-card-title>
    <v-card-text class="px-6">
      <div v-if="state === 'activating'" class="text-center py-6">
        <v-progress-circular indeterminate color="primary" size="48" />
        <div class="mt-3 text-body-1">{{ $t('auth.activation.activating') }}</div>
      </div>

      <template v-else-if="state === 'activated'">
        <v-alert type="success" variant="tonal" class="mb-4">{{ $t('auth.activation.activatedBody') }}</v-alert>
        <v-btn color="primary" block size="large" to="/auth/login">{{ $t('auth.login') }}</v-btn>
      </template>

      <template v-else>
        <v-alert v-if="state === 'invalid'" type="error" variant="tonal" density="compact" class="mb-4">
          {{ $t('auth.activation.invalidLink') }}
        </v-alert>
        <p class="text-body-2 mb-4">{{ $t('auth.activation.requestHint') }}</p>
        <v-form @submit.prevent="resend">
          <v-text-field
            v-model="email"
            :label="$t('auth.email')"
            type="email"
            prepend-inner-icon="mdi-email"
            class="mb-2"
          />
          <v-alert v-if="resent" type="success" variant="tonal" density="compact" class="mb-4">
            {{ $t('auth.activation.resent') }}
          </v-alert>
          <v-alert v-if="resendError" type="error" variant="tonal" density="compact" class="mb-4">{{ resendError }}</v-alert>
          <v-btn type="submit" color="primary" block :loading="busy" :disabled="!email">
            {{ $t('auth.activation.resend') }}
          </v-btn>
        </v-form>
      </template>
    </v-card-text>
    <v-card-actions v-if="state !== 'activated'" class="justify-center pb-6">
      <router-link to="/auth/login">{{ $t('auth.activation.backToLogin') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../../store/app.store'

/**
 * S-06 — where an activation email lands: `/auth/activate#userId=…&code=…`.
 *
 * ⚠ The code arrives in the URL **fragment**, never the query. A fragment is not sent to a server
 * and does not appear in an access log. It is also not called `token`: every SPA router treats
 * `?token=` as a session handoff (FR-14.24) and would strip it before this page could read it.
 * Same shape as `DesktopRedeemView`.
 *
 * ⚠ The fragment is cleared with `history.replaceState` before the POST, so it cannot survive
 * into a bookmark, a back-button entry or a screenshot of the address bar.
 *
 * Opened with no fragment at all (the "Activation email didn't arrive?" link), it is just the
 * form that asks for a new link.
 */

type State = 'activating' | 'activated' | 'invalid' | 'request'

const appStore = useAppStore()
const state = ref<State>('request')
const email = ref('')
const busy = ref(false)
const resent = ref(false)
const resendError = ref('')

const titleKey = computed(() => {
  if (state.value === 'activated') return 'auth.activation.activatedTitle'
  if (state.value === 'activating') return ''
  return 'auth.activation.requestTitle'
})

function readFragment(): { userId: string; code: string } {
  // `location.hash` includes the leading `#`.
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return { userId: params.get('userId') || '', code: params.get('code') || '' }
}

onMounted(async () => {
  const { userId, code } = readFragment()

  // Clear FIRST, before any await — a failed activation must not leave the code in the address bar.
  if (window.location.hash) {
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* a browser that refuses replaceState still gets the activation below */
    }
  }

  if (!userId && !code) return // the plain "send me a new link" form
  if (!userId || !code) {
    state.value = 'invalid'
    return
  }

  state.value = 'activating'
  try {
    await appStore.activate(userId, code)
    state.value = 'activated'
  } catch {
    // The server answers one message for every refusal (unknown, expired, used, deactivated),
    // so there is nothing to tell apart here — offer a new link instead.
    state.value = 'invalid'
  }
})

async function resend() {
  busy.value = true
  resent.value = false
  resendError.value = ''
  try {
    await appStore.resendActivation(email.value.trim())
    resent.value = true
  } catch (err: any) {
    resendError.value = err.response?.data?.message || err.message || 'Could not send a new link'
  } finally {
    busy.value = false
  }
}
</script>
