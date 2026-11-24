<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.reset.title') }}</v-card-title>
    <v-card-text class="px-6">
      <v-alert v-if="!token" type="error" variant="tonal">{{ $t('auth.reset.invalidLink') }}</v-alert>
      <v-form v-else ref="formRef" @submit.prevent="submit">
        <v-text-field
          v-model="password"
          :label="$t('account.newPassword')"
          :type="show ? 'text' : 'password'"
          :append-inner-icon="show ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="new-password"
          :hint="$t('account.passwordRule')"
          persistent-hint
          :rules="[required, minLength]"
          prepend-inner-icon="mdi-lock"
          class="mb-2"
          @click:append-inner="show = !show"
        />
        <v-text-field
          v-model="confirm"
          :label="$t('account.confirmPassword')"
          :type="show ? 'text' : 'password'"
          autocomplete="new-password"
          :rules="[required, matches]"
          prepend-inner-icon="mdi-lock-check"
          class="mb-2"
        />
        <v-alert v-if="error" type="error" density="compact" class="mb-4">
          {{ error }}
          <div v-if="expired" class="mt-1">
            <router-link :to="{ name: 'auth.forgot-password' }">{{ $t('auth.reset.askAgain') }}</router-link>
          </div>
        </v-alert>
        <v-btn type="submit" color="primary" block size="large" :loading="loading">{{ $t('auth.reset.submit') }}</v-btn>
      </v-form>
    </v-card-text>
    <v-card-actions class="justify-center pb-6">
      <router-link to="/auth/login">{{ $t('auth.activation.backToLogin') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'

/**
 * Where a password-reset email lands (multi-org sign-in, Phase 4).
 *
 * ⚠ The token arrives in the URL **fragment** (`#token=…`), never the query: a fragment is not
 * sent to any server and appears in no access log. It is cleared from the address bar before
 * anything else happens, so it does not survive in history or in a copied link. The link works
 * once and for an hour; a password set here is the person's own and also verifies their address.
 */

const router = useRouter()
const { t } = useI18n()
const formRef = ref()
const token = ref('')
const password = ref('')
const confirm = ref('')
const show = ref(false)
const loading = ref(false)
const error = ref('')
const expired = ref(false)

const required = (v: string) => !!v || t('validation.required')
const minLength = (v: string) => (v ?? '').length >= 12 || t('account.passwordRule')
const matches = (v: string) => v === password.value || t('account.mismatch')

onMounted(() => {
  // `location.hash` includes the leading `#`.
  token.value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? ''
  if (window.location.hash) {
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* a browser that refuses replaceState still gets the form */
    }
  }
})

async function submit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  error.value = ''
  expired.value = false
  try {
    await httpClient.post('/auth/password/reset', { token: token.value, newPassword: password.value })
    router.push({ name: 'auth.login', query: { reset: 'done' } })
  } catch (err: any) {
    const code = err?.response?.data?.code
    expired.value = code === 'reset_invalid' || err?.response?.status === 422
    error.value = expired.value ? t('identity.errors.reset_invalid') : err?.response?.data?.message || t('auth.errors.failed')
  } finally {
    loading.value = false
  }
}
</script>
