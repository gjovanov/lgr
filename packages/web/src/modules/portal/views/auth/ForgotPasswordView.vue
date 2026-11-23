<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.forgot.title') }}</v-card-title>
    <v-card-text class="px-6">
      <template v-if="!sent">
        <p class="text-body-2 mb-4">{{ $t('auth.forgot.hint') }}</p>
        <v-form @submit.prevent="submit">
          <v-text-field
            v-model="email"
            :label="$t('auth.email')"
            type="email"
            autocomplete="email"
            prepend-inner-icon="mdi-email"
            required
            class="mb-2"
          />
          <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>
          <v-btn type="submit" color="primary" block size="large" :loading="loading" :disabled="!email.trim()">
            {{ $t('auth.forgot.submit') }}
          </v-btn>
        </v-form>
      </template>
      <v-alert v-else type="success" variant="tonal">{{ $t('auth.forgot.sent') }}</v-alert>
    </v-card-text>
    <v-card-actions class="justify-center pb-6">
      <router-link to="/auth/login">{{ $t('auth.activation.backToLogin') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'

/**
 * Forgot password (multi-org sign-in, Phase 4). The server answers the same for every address,
 * so this page says the same thing whatever was typed: "if an account uses it, a link is on its
 * way". It cannot be used to find out who has an account.
 */

const { t } = useI18n()
const email = ref('')
const loading = ref(false)
const sent = ref(false)
const error = ref('')

async function submit() {
  loading.value = true
  error.value = ''
  try {
    await httpClient.post('/auth/password/forgot', { email: email.value.trim() })
    sent.value = true
  } catch (err: any) {
    const status = err?.response?.status
    error.value = status === 429 ? t('auth.errors.too_many_attempts') : status === 422 ? t('auth.forgot.invalidEmail') : t('auth.errors.failed')
  } finally {
    loading.value = false
  }
}
</script>
