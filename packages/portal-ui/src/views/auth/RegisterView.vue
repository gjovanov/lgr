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
const inviteCode = ref('')
const inviteOrgName = ref('')
const inviteOrgSlug = ref('')

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

onMounted(async () => {
  // ⚠ A sign-up identity is never taken from the URL. The OAuth callback used to send
  // `?oauth_token=<JWT>` and this view posted back whatever token it found, so a planted link
  // chose whose provider identity the new account carried (security review S-19). A link of that
  // shape can still be sitting in a history or an inbox: take it out of the address bar, before
  // any request is made from this page, and use nothing from it.
  if (route.query.oauth_token !== undefined) {
    const query = { ...route.query }
    delete query.oauth_token
    await router.replace({ query })
  }

  // Check for invite code
  const invite = (route.query.invite as string) || sessionStorage.getItem('lgr_invite_code')
  if (invite) {
    inviteCode.value = invite
    sessionStorage.setItem('lgr_invite_code', invite)
    try {
      const { data } = await (await import('ui-shared/composables/useHttpClient')).httpClient.get(`/invite/${invite}`)
      if (data.isValid) {
        inviteOrgName.value = data.orgName
        inviteOrgSlug.value = data.orgSlug
      }
    } catch {
      // ignore
    }
  }

  // `?oauth=1` says only that a sign-up MAY be in progress. Who is signing up comes from the
  // server, through the httpOnly cookie the callback set; without that cookie this is the
  // ordinary register form.
  if (route.query.oauth === '1') {
    try {
      const signup = await appStore.fetchOAuthSignup()
      isOAuth.value = true
      form.email = signup.email || ''
      const nameParts = (signup.name || '').split(' ')
      form.firstName = nameParts[0] || ''
      form.lastName = nameParts.slice(1).join(' ') || ''
      form.username = (signup.name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    } catch (err: any) {
      error.value = err.response?.data?.message || err.message || 'Sign-up failed'
    }
  }
})

function autoSlug() {
  form.orgSlug = form.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function oauthRegister(provider: string) {
  // With an invite, this is not a registration at all — it is joining an existing org, and
  // the backend needs the invite to authorise it (#49 S-17: it used to let anyone in on the
  // org slug alone). Without one, `mode=register` still creates a brand-new org as before.
  if (inviteCode.value && inviteOrgSlug.value) {
    const q = new URLSearchParams({
      mode: 'login',
      org_slug: inviteOrgSlug.value,
      invite_code: inviteCode.value,
    })
    window.location.href = `/api/oauth/${provider}?${q}`
    return
  }
  window.location.href = `/api/oauth/${provider}?mode=register`
}

async function handleRegister() {
  loading.value = true
  error.value = ''
  try {
    if (isOAuth.value) {
      await appStore.registerOAuth({
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
