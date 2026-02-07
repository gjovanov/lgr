<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.registerTitle') }}</v-card-title>
    <v-card-text class="px-6">
      <v-form @submit.prevent="handleRegister">
        <v-text-field v-model="form.orgName" :label="$t('auth.orgName')" prepend-inner-icon="mdi-domain" required class="mb-2" @input="autoSlug" />
        <v-text-field v-model="form.orgSlug" :label="$t('auth.orgSlug')" prepend-inner-icon="mdi-tag" required class="mb-2" />
        <v-row>
          <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('auth.firstName')" required /></v-col>
          <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('auth.lastName')" required /></v-col>
        </v-row>
        <v-text-field v-model="form.email" :label="$t('auth.email')" type="email" prepend-inner-icon="mdi-email" required class="mb-2" />
        <v-text-field v-model="form.username" :label="$t('auth.username')" prepend-inner-icon="mdi-account" required class="mb-2" />
        <v-text-field v-model="form.password" :label="$t('auth.password')" type="password" prepend-inner-icon="mdi-lock" required class="mb-2" />
        <v-row>
          <v-col cols="6">
            <v-select v-model="form.baseCurrency" :label="$t('auth.baseCurrency')" :items="['EUR','USD','GBP','CHF','MKD','BGN']" />
          </v-col>
          <v-col cols="6">
            <v-select v-model="form.locale" :label="$t('auth.locale')" :items="[{title:'English',value:'en'},{title:'Македонски',value:'mk'},{title:'Deutsch',value:'de'}]" />
          </v-col>
        </v-row>
        <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>
        <v-btn type="submit" color="primary" block size="large" :loading="loading" class="mt-2">{{ $t('auth.register') }}</v-btn>
      </v-form>
    </v-card-text>
    <v-card-actions class="justify-center pb-6">
      <span class="text-body-2">{{ $t('auth.hasAccount') }}</span>
      <router-link to="/auth/login" class="ml-1">{{ $t('auth.login') }}</router-link>
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
const form = reactive({
  orgName: '', orgSlug: '', email: '', username: '', password: '',
  firstName: '', lastName: '', baseCurrency: 'EUR', locale: 'en',
})

function autoSlug() {
  form.orgSlug = form.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

async function handleRegister() {
  loading.value = true
  error.value = ''
  try {
    await appStore.register(form)
    router.push('/dashboard')
  } catch (err: any) {
    error.value = err.response?.data?.message || err.message || 'Registration failed'
  } finally {
    loading.value = false
  }
}
</script>
