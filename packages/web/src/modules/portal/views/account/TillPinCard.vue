<template>
  <v-card v-if="available" class="mb-4" variant="flat" border data-testid="till-pin">
    <v-card-title class="text-subtitle-1 font-weight-medium">{{ $t('account.pin.title') }}</v-card-title>
    <v-card-text>
      <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('account.pin.description') }}</p>
      <v-alert v-if="isSet" type="success" variant="tonal" density="compact" class="mb-4" data-testid="till-pin-set">
        {{ $t('account.pin.isSet') }}
      </v-alert>
      <v-form ref="formRef" @submit.prevent="save">
        <v-text-field
          v-model="password"
          :label="$t('account.currentPassword')"
          type="password"
          autocomplete="current-password"
          :rules="[required]"
          class="mb-2"
        />
        <v-text-field
          v-model="pin"
          :label="$t('account.pin.newPin')"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          :hint="$t('account.pin.rule')"
          persistent-hint
          :rules="[required, digits]"
          class="mb-2"
        />
        <v-text-field
          v-model="confirm"
          :label="$t('account.pin.confirmPin')"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          :rules="[required, matches]"
          class="mb-2"
        />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
        <v-alert v-if="done" type="success" variant="tonal" density="compact" class="mb-4">{{ done }}</v-alert>
        <div class="d-flex ga-2">
          <v-btn type="submit" color="primary" :loading="busy" data-testid="till-pin-save">
            {{ isSet ? $t('account.pin.change') : $t('account.pin.set') }}
          </v-btn>
          <v-btn v-if="isSet" variant="text" color="error" :disabled="busy" data-testid="till-pin-remove" @click="remove">
            {{ $t('account.pin.remove') }}
          </v-btn>
        </div>
      </v-form>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { refusalCode } from 'ui-shared/session/useOrgSession'

/**
 * The person's till PIN for this server (FR-20.40, plan step P1-5b). Shown on an on-prem master
 * only: everywhere else `/auth/local/pin` answers 404 and the card does not appear. Setting it
 * takes the password; a password change ends it (the account view remounts this card).
 */

const { t } = useI18n()
const available = ref(false)
const isSet = ref(false)
const formRef = ref()
const password = ref('')
const pin = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref('')
const done = ref('')

const required = (v: string) => !!v || t('validation.required')
const digits = (v: string) => /^\d{6,12}$/.test(v ?? '') || t('account.pin.rule')
const matches = (v: string) => v === pin.value || t('account.pin.mismatch')

async function load() {
  try {
    const { data } = await httpClient.get('/auth/local/pin')
    available.value = true
    isSet.value = !!data.set
  } catch {
    available.value = false
  }
}

function message(err: unknown): string {
  const code = refusalCode(err)
  if (code === 'wrong_password') return t('account.pin.wrongPassword')
  if (code === 'pin_rule') return t('account.pin.rule')
  if (code === 'password_required') return t('account.pin.passwordRequired')
  return t('account.pin.failed')
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  busy.value = true
  error.value = done.value = ''
  try {
    await httpClient.put('/auth/local/pin', { password: password.value, pin: pin.value })
    password.value = pin.value = confirm.value = ''
    formRef.value.resetValidation()
    isSet.value = true
    done.value = t('account.pin.saved')
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}

async function remove() {
  busy.value = true
  error.value = done.value = ''
  try {
    await httpClient.delete('/auth/local/pin')
    isSet.value = false
    done.value = t('account.pin.removed')
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>
