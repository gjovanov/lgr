<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('auth.registerTitle') }}</v-card-title>
    <v-card-text class="px-6">
      <v-form @submit.prevent="handleRegister">
        <v-alert v-if="inviteOrgName" type="info" variant="tonal" density="compact" class="mb-4">
          Joining <strong>{{ inviteOrgName }}</strong>
        </v-alert>
        <v-text-field v-if="!inviteCode" v-model="form.orgName" :label="$t('auth.orgName')" prepend-inner-icon="mdi-domain" required class="mb-2" @input="autoSlug" />
        <v-text-field v-if="!inviteCode" v-model="form.orgSlug" :label="$t('auth.orgSlug')" prepend-inner-icon="mdi-tag" required class="mb-2" />
        <v-row>
          <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('auth.firstName')" required :readonly="isOAuth" /></v-col>
          <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('auth.lastName')" required :readonly="isOAuth" /></v-col>
        </v-row>
        <v-text-field v-model="form.email" :label="$t('auth.email')" type="email" prepend-inner-icon="mdi-email" required class="mb-2" :readonly="isOAuth" />
        <v-text-field v-model="form.username" :label="$t('auth.username')" prepend-inner-icon="mdi-account" required class="mb-2" />
        <v-text-field v-if="!isOAuth" v-model="form.password" :label="$t('auth.password')" prepend-inner-icon="mdi-lock" type="password" required class="mb-2" />
        <v-row v-if="!inviteCode">
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
    <template v-if="!isOAuth">
      <v-divider class="mx-6" />
      <v-card-text class="text-center pb-2 text-body-2">{{ $t('auth.orRegisterWith') || 'Or register with' }}</v-card-text>
      <div class="d-flex flex-wrap justify-center ga-2 px-6 pb-4">
        <v-btn
          v-for="p in oauthProviders"
          :key="p.name"
          @click="oauthRegister(p.name)"
          :color="p.color"
          variant="outlined"
          size="small"
        >
          <v-icon start>{{ p.icon }}</v-icon>
          {{ p.label }}
        </v-btn>
      </div>
    </template>
    <v-card-actions class="justify-center pb-6">
      <span class="text-body-2">{{ $t('auth.hasAccount') }}</span>
      <router-link to="/auth/login" class="ml-1">{{ $t('auth.login') }}</router-link>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../../store/app.store'

const appStore = useAppStore()
const router = useRouter()
const route = useRoute()
const loading = ref(false)
const error = ref('')
const isOAuth = ref(false)
const oauthToken = ref('')
const inviteCode = ref('')
const inviteOrgName = ref('')

const form = reactive({
  orgName: '', orgSlug: '', email: '', username: '', password: '',
  firstName: '', lastName: '', baseCurrency: 'EUR', locale: 'en',
})

const oauthProviders = [
  { name: 'google', label: 'Google', icon: 'mdi-google', color: '#DB4437' },
  { name: 'facebook', label: 'Facebook', icon: 'mdi-facebook', color: '#4267B2' },
  { name: 'github', label: 'GitHub', icon: 'mdi-github', color: '#333' },
  { name: 'linkedin', label: 'LinkedIn', icon: 'mdi-linkedin', color: '#0077B5' },
  { name: 'microsoft', label: 'Microsoft', icon: 'mdi-microsoft', color: '#00A4EF' },
]

function decodeJwtPayload(token: string) {
  const payload = token.split('.')[1]
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

onMounted(async () => {
  // Check for invite code
  const invite = (route.query.invite as string) || sessionStorage.getItem('lgr_invite_code')
  if (invite) {
    inviteCode.value = invite
    sessionStorage.setItem('lgr_invite_code', invite)
    try {
      const { data } = await (await import('../composables/useHttpClient')).httpClient.get(`/invite/${invite}`)
      if (data.isValid) {
        inviteOrgName.value = data.orgName
      }
    } catch {
      // ignore
    }
  }

  const token = route.query.oauth_token as string
  if (token) {
    oauthToken.value = token
    isOAuth.value = true
    try {
      const payload = decodeJwtPayload(token)
      form.email = payload.email || ''
      const nameParts = (payload.name || '').split(' ')
      form.firstName = nameParts[0] || ''
      form.lastName = nameParts.slice(1).join(' ') || ''
      form.username = (payload.name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    } catch {
      // ignore decode errors
    }
  }
})

function autoSlug() {
  form.orgSlug = form.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function oauthRegister(provider: string) {
  window.location.href = `/api/oauth/${provider}?mode=register`
}

async function handleRegister() {
  loading.value = true
  error.value = ''
  try {
    if (isOAuth.value) {
      await appStore.registerOAuth({
        oauthToken: oauthToken.value,
        orgName: form.orgName,
        orgSlug: form.orgSlug,
        username: form.username,
      })
    } else {
      const payload = { ...form }
      if (inviteCode.value) {
        (payload as any).inviteCode = inviteCode.value
      }
      await appStore.register(payload)
    }
    sessionStorage.removeItem('lgr_invite_code')
    router.push('/dashboard')
  } catch (err: any) {
    error.value = err.response?.data?.message || err.message || 'Registration failed'
  } finally {
    loading.value = false
  }
}
</script>
