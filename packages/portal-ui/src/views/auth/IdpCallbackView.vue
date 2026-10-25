<template>
  <v-card elevation="8">
    <v-card-title class="text-h6 pt-6 text-center">{{ $t('idp.signingIn') }}</v-card-title>
    <v-card-text class="px-6 pb-6">
      <v-progress-linear v-if="!error" indeterminate />
      <template v-else>
        <v-alert type="error" variant="tonal" class="mb-4" data-test="idp-callback-error">{{ error }}</v-alert>
        <v-btn block color="primary" :to="{ name: 'auth.login' }">{{ $t('idp.backToSignIn') }}</v-btn>
      </template>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { takeLgrSignIn } from './idp'

/**
 * A master's page that lgrai.app sends the person back to (FR-20.39, plan step P2-4): it takes the
 * verifier this tab kept under the state, has the server redeem the code with it, and the answer
 * becomes this tab's session, as a password sign-in's does.
 */

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const error = ref('')

onMounted(async () => {
  const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
  const flow = q('state') ? takeLgrSignIn(q('state')) : null
  if (q('error')) {
    error.value = t('idp.cancelled')
    return
  }
  if (!flow || !q('code')) {
    error.value = t('idp.notStartedHere')
    return
  }
  try {
    const answer = await appStore.completeLgrSignIn(q('code'), flow.verifier, flow.redirectUri)
    router.replace(answer.needsOrgChoice ? { name: 'orgs' } : '/dashboard')
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  }
})
</script>
