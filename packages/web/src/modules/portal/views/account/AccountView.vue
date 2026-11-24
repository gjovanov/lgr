<template>
  <v-container style="max-width: 760px">
    <h1 class="text-h5 mb-1">{{ $t('account.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mb-6">{{ $t('account.subtitle') }}</p>

    <div v-if="loading" class="d-flex justify-center py-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <!-- A session from before this account was linked to a person: nothing here applies yet. -->
    <v-alert v-else-if="!person" type="info" variant="tonal">{{ $t('account.notLinked') }}</v-alert>

    <template v-else>
      <v-card class="mb-4" variant="flat" border>
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ $t('account.profile') }}</v-card-title>
        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('common.name') }}</div>
              <div class="text-body-1">{{ person.firstName }} {{ person.lastName }}</div>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('auth.email') }}</div>
              <div class="text-body-1" data-testid="account-email">{{ person.email }}</div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <v-card class="mb-4" variant="flat" border>
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ $t('account.password') }}</v-card-title>
        <v-card-text>
          <!-- FR-20.42: on a linked master the person is lgrai.app's: changed there, never here. -->
          <template v-if="person.manageOn">
            <v-alert type="info" variant="tonal" density="compact" class="mb-3" data-testid="account-manage-on">{{ $t('account.manageOn') }}</v-alert>
            <v-btn color="primary" variant="tonal" :href="`${person.manageOn}/account`" target="_blank" rel="noopener">{{ $t('account.openLgrai') }}</v-btn>
          </template>

          <template v-else-if="person.hasPassword">
            <v-alert v-if="person.passwordSetBy !== 'self'" type="warning" variant="tonal" density="compact" class="mb-4">
              {{ $t('account.notOwnPassword') }}
            </v-alert>
            <v-form ref="formRef" @submit.prevent="changePassword">
              <v-text-field
                v-model="current"
                :label="$t('account.currentPassword')"
                type="password"
                autocomplete="current-password"
                :rules="[required]"
                class="mb-2"
              />
              <v-text-field
                v-model="next"
                :label="$t('account.newPassword')"
                :type="showNew ? 'text' : 'password'"
                :append-inner-icon="showNew ? 'mdi-eye-off' : 'mdi-eye'"
                autocomplete="new-password"
                :hint="$t('account.passwordRule')"
                persistent-hint
                :rules="[required, minLength]"
                class="mb-2"
                @click:append-inner="showNew = !showNew"
              />
              <v-text-field
                v-model="confirm"
                :label="$t('account.confirmPassword')"
                :type="showNew ? 'text' : 'password'"
                autocomplete="new-password"
                :rules="[required, matches]"
                class="mb-2"
              />
              <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-3">{{ error }}</v-alert>
              <v-alert v-if="changed" type="success" density="compact" variant="tonal" class="mb-3">
                {{ $t('account.passwordChanged') }}
              </v-alert>
              <v-btn type="submit" color="primary" :loading="busy">{{ $t('account.changePassword') }}</v-btn>
            </v-form>
          </template>

          <template v-else>
            <p class="text-body-2 mb-4">{{ $t('account.noPassword') }}</p>
            <v-alert v-if="linkSent" type="success" density="compact" variant="tonal" class="mb-3">{{ $t('account.linkSent') }}</v-alert>
            <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-3">{{ error }}</v-alert>
            <v-btn color="primary" variant="tonal" :loading="busy" :disabled="linkSent" @click="sendLink">
              {{ $t('account.sendLink') }}
            </v-btn>
          </template>
        </v-card-text>
      </v-card>

      <!-- On an on-prem server only. A password change ends the PIN, so it is read again. -->
      <TillPinCard :key="pinKey" />

      <!-- On lgrai.app, for an org with an on-prem server. A password change ends these too. -->
      <OnpremCredentialsCard :key="`onprem-${pinKey}`" :has-password="!!person.hasPassword" />

      <v-card variant="flat" border>
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ $t('account.signInMethods') }}</v-card-title>
        <v-list density="compact">
          <v-list-item prepend-icon="mdi-form-textbox-password" :title="$t('account.password')">
            <template #append>
              <v-chip size="small" :color="person.hasPassword ? 'success' : undefined" variant="tonal">
                {{ person.hasPassword ? $t('account.methodOn') : $t('account.methodOff') }}
              </v-chip>
            </template>
          </v-list-item>
          <v-list-item
            v-for="p in person.providers ?? []"
            :key="p.provider"
            :prepend-icon="`mdi-${p.provider === 'microsoft' ? 'microsoft' : p.provider}`"
            :title="providerLabel(p.provider)"
          >
            <template #append>
              <v-chip size="small" :color="p.verified ? 'success' : 'warning'" variant="tonal">
                {{ p.verified ? $t('account.methodOn') : $t('account.methodUnconfirmed') }}
              </v-chip>
            </template>
          </v-list-item>
        </v-list>
        <v-card-text v-if="(person.providers ?? []).some(p => !p.verified)" class="pt-0 text-caption text-medium-emphasis">
          {{ $t('account.unconfirmedHint') }}
        </v-card-text>
      </v-card>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { refusalCode } from 'ui-shared/session/useOrgSession'
import { useAppStore } from '../../store/app.store'
import TillPinCard from './TillPinCard.vue'
import OnpremCredentialsCard from './OnpremCredentialsCard.vue'

/**
 * The person's own account (multi-org sign-in, Phase 4): one password and one set of sign-in
 * methods for every org they work in. Changing the password here ends every other session they
 * hold, in every org and browser; this tab gets a fresh token and stays signed in.
 */

const appStore = useAppStore()
const { t, te } = useI18n()

const loading = ref(true)
const person = computed(() => appStore.person)
const formRef = ref()
const current = ref('')
const next = ref('')
const confirm = ref('')
const showNew = ref(false)
const busy = ref(false)
const error = ref('')
const changed = ref(false)
const linkSent = ref(false)
const pinKey = ref(0)

const required = (v: string) => !!v || t('validation.required')
const minLength = (v: string) => (v ?? '').length >= 12 || t('account.passwordRule')
const matches = (v: string) => v === next.value || t('account.mismatch')

const PROVIDERS: Record<string, string> = {
  google: 'Google', microsoft: 'Microsoft', github: 'GitHub', linkedin: 'LinkedIn', facebook: 'Facebook',
}
const providerLabel = (p: string) => PROVIDERS[p] ?? p

onMounted(async () => {
  try {
    await appStore.fetchProfile()
  } finally {
    loading.value = false
  }
})

function message(err: unknown): string {
  const code = refusalCode(err)
  if (code && te(`identity.errors.${code}`)) return t(`identity.errors.${code}`)
  if (code && te(`auth.errors.${code}`)) return t(`auth.errors.${code}`)
  return (err as any)?.response?.data?.message || t('account.failed')
}

async function changePassword() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  busy.value = true
  error.value = ''
  changed.value = false
  try {
    const { data } = await httpClient.post('/auth/password', { currentPassword: current.value, newPassword: next.value })
    appStore.replaceToken(data.token)
    current.value = next.value = confirm.value = ''
    formRef.value.resetValidation()
    changed.value = true
    // FR-20.40: the new password bumped the token version, which ends a till PIN.
    pinKey.value++
    await appStore.fetchProfile()
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}

/** A person who signs in with a provider only sets a first password through the email link. */
async function sendLink() {
  if (!person.value) return
  busy.value = true
  error.value = ''
  try {
    await httpClient.post('/auth/password/forgot', { email: person.value.email })
    linkSent.value = true
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}
</script>
