<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.signInTitle') }}</v-card-title>
    <v-card-text class="px-6">
      <v-form @submit.prevent="handleLogin">
        <v-text-field v-model="form.orgSlug" :label="$t('auth.organization')" prepend-inner-icon="mdi-domain" required class="mb-2" />
        <v-text-field v-model="form.username" :label="$t('auth.username')" prepend-inner-icon="mdi-account" required class="mb-2" />
        <v-text-field v-model="form.password" :label="$t('auth.password')" prepend-inner-icon="mdi-lock" type="password" required class="mb-4" />
        <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>
        <v-btn type="submit" color="primary" block size="large" :loading="loading">{{ $t('auth.login') }}</v-btn>
      </v-form>
    </v-card-text>
    <v-card-actions class="justify-center pb-6">
      <span class="text-body-2">{{ $t('auth.noAccount') }}</span>
      <router-link to="/auth/register" class="ml-1">{{ $t('auth.register') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'

const appStore = useAppStore()
const router = useRouter()
const loading = ref(false)
const error = ref('')
const form = reactive({ orgSlug: '', username: '', password: '' })

async function handleLogin() {
  loading.value = true
  error.value = ''
  try {
    await appStore.login(form.username, form.password, form.orgSlug)
    router.push('/dashboard')
  } catch (err: any) {
    error.value = err.response?.data?.message || err.message || 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>
