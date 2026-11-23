<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card max-width="480" width="100%" elevation="8">
      <v-card-title class="text-h6 pt-6 text-center">{{ $t('idp.title') }}</v-card-title>
      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate class="mb-4" />
        <v-alert v-else-if="error" type="error" variant="tonal" data-test="idp-error">{{ error }}</v-alert>
        <template v-else-if="client">
          <p class="text-body-1 mb-4" data-test="idp-server">{{ $t('idp.intro', { server: client.node.name }) }}</p>
          <v-alert v-if="!client.orgs.length" type="warning" variant="tonal">{{ $t('idp.noOrg') }}</v-alert>
          <v-radio-group v-else-if="client.orgs.length > 1" v-model="orgId" :label="$t('idp.whichOrg')">
            <v-radio v-for="o in client.orgs" :key="o.id" :label="o.name" :value="o.id" />
          </v-radio-group>
          <p v-else class="text-body-2 mb-2">{{ $t('idp.asOrg', { org: client.orgs[0].name }) }}</p>
          <p class="text-caption text-medium-emphasis">{{ $t('idp.noPassword') }}</p>
        </template>
      </v-card-text>
      <v-card-actions v-if="client && !loading" class="px-6 pb-6">
        <v-btn variant="text" @click="cancel">{{ $t('common.cancel') }}</v-btn>
        <v-spacer />
        <v-btn color="primary" :disabled="!orgId" :loading="busy" data-test="idp-continue" @click="allow">{{ $t('idp.continue') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { getToken } from 'ui-shared/session/session'
import { IDP_RESUME_KEY } from '../auth/idp'

/**
 * lgrai.app's authorize page for "Sign in with LGR" (FR-20.39, plan step P2-4): a server of the
 * person's org asks to sign them in. With the person's lgrai.app session from THIS TAB (never a
 * cookie: an org's address is same-site with lgrai.app, FR-20.72), it shows which server and which
 * org, and on Continue sends the browser back with a one-time code.
 *
 * Signed out, it keeps its own address and goes to the sign-in page, which comes back here.
 */

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const client = ref<{ node: { id: string; name: string }; orgs: Array<{ id: string; slug: string; name: string }> } | null>(null)
const orgId = ref('')

const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')

onMounted(async () => {
  if (!getToken()) {
    sessionStorage.setItem(IDP_RESUME_KEY, route.fullPath)
    router.replace({ name: 'auth.login' })
    return
  }
  if (q('code_challenge_method') !== 'S256' || !q('code_challenge') || !q('state') || !q('client_id') || !q('redirect_uri')) {
    error.value = t('idp.badRequest')
    loading.value = false
    return
  }
  try {
    const { data } = await httpClient.get('/idp/client', { params: { client_id: q('client_id'), redirect_uri: q('redirect_uri') } })
    client.value = data
    if (data.orgs.length === 1) orgId.value = data.orgs[0].id
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    loading.value = false
  }
})

async function allow() {
  busy.value = true
  try {
    const { data } = await httpClient.post('/idp/authorize', {
      clientId: q('client_id'), orgId: orgId.value, redirectUri: q('redirect_uri'), state: q('state'),
      codeChallenge: q('code_challenge'), codeChallengeMethod: q('code_challenge_method'),
    })
    window.location.assign(data.redirect)
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
    busy.value = false
  }
}

/** Back to the server, empty-handed: it shows its own sign-in page again. */
function cancel() {
  try {
    const back = new URL(q('redirect_uri'))
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('state', q('state'))
    window.location.assign(back.toString())
  } catch {
    router.replace({ name: 'apps' })
  }
}
</script>
