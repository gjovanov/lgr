<template>
  <v-app>
    <v-main class="d-flex align-center justify-center" style="min-height: 100vh">
      <v-card width="360" class="pa-4" variant="flat" border data-testid="pin-pad">
        <v-card-title class="text-h6 text-center">{{ $t('pos.pin.title') }}</v-card-title>
        <v-card-text>
          <v-text-field
            ref="codeRef"
            v-model="operatorCode"
            :label="$t('pos.pin.operatorCode')"
            inputmode="numeric"
            autocomplete="off"
            maxlength="8"
            density="comfortable"
            data-testid="pin-operator"
            @focus="field = 'code'"
            @keydown.enter="pinRef?.focus()"
          />
          <v-text-field
            ref="pinRef"
            v-model="pin"
            :label="$t('pos.pin.pin')"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            maxlength="12"
            density="comfortable"
            data-testid="pin-pin"
            @focus="field = 'pin'"
            @keydown.enter="submit"
          />

          <div class="pin-keys mb-3">
            <v-btn v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']" :key="d" size="x-large" variant="tonal" @click="press(d)">{{ d }}</v-btn>
            <v-btn size="x-large" variant="text" :aria-label="$t('pos.pin.clear')" @click="clearField"><v-icon icon="mdi-close" /></v-btn>
            <v-btn size="x-large" variant="tonal" @click="press('0')">0</v-btn>
            <v-btn size="x-large" variant="text" :aria-label="$t('pos.pin.back')" @click="back"><v-icon icon="mdi-backspace-outline" /></v-btn>
          </div>

          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="pin-error">{{ error }}</v-alert>

          <v-btn
            block
            size="large"
            color="primary"
            :loading="busy"
            :disabled="!operatorCode || !pin || waitSeconds > 0"
            data-testid="pin-submit"
            @click="submit"
          >
            {{ waitSeconds > 0 ? $t('pos.pin.wait', { seconds: waitSeconds }) : $t('pos.pin.signIn') }}
          </v-btn>
          <div class="text-center mt-3">
            <a :href="passwordHref" class="text-body-2">{{ $t('pos.pin.withPassword') }}</a>
          </div>
        </v-card-text>
      </v-card>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { portalHref } from 'ui-shared/nav/navigate'
import { pinOffered, signInWithPin } from '../composables/useTillPin'

/**
 * The till's PIN pad (FR-20.40, plan step P1-5b): the operator's code, then their PIN. A screen or
 * a keyboard both work. On success this tab holds the operator's session and reloads into the
 * terminal, so the app starts again from that session.
 */

const { t } = useI18n()
const route = useRoute()

const codeRef = ref()
const pinRef = ref()
const operatorCode = ref('')
const pin = ref('')
const field = ref<'code' | 'pin'>('code')
const busy = ref(false)
const error = ref('')
const waitSeconds = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

const passwordHref = portalHref('/auth/login')

function press(d: string) {
  if (field.value === 'code') {
    if (operatorCode.value.length < 8) operatorCode.value += d
  } else if (pin.value.length < 12) {
    pin.value += d
  }
}

function back() {
  if (field.value === 'code') operatorCode.value = operatorCode.value.slice(0, -1)
  else pin.value = pin.value.slice(0, -1)
}

function clearField() {
  if (field.value === 'code') operatorCode.value = ''
  else pin.value = ''
}

function wait(seconds: number) {
  waitSeconds.value = seconds
  clearInterval(timer)
  timer = setInterval(() => {
    waitSeconds.value = Math.max(0, waitSeconds.value - 1)
    if (!waitSeconds.value) clearInterval(timer)
  }, 1000)
}

async function submit() {
  if (!operatorCode.value || !pin.value || waitSeconds.value > 0 || busy.value) return
  busy.value = true
  error.value = ''
  const failure = await signInWithPin(operatorCode.value, pin.value)
  busy.value = false
  if (!failure) {
    const to = typeof route.query.to === 'string' && route.query.to.startsWith('/') && !route.query.to.startsWith('//') ? route.query.to : '/pos/terminal'
    window.location.replace(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${to}`)
    return
  }
  pin.value = ''
  if (failure.retryAfterSeconds) wait(failure.retryAfterSeconds)
  error.value =
    failure.code === 'pin_not_set' ? t('pos.pin.notSet')
    : failure.code === 'pin_backoff' ? t('pos.pin.backoff', { seconds: failure.retryAfterSeconds ?? 1 })
    : failure.code === 'not_found' ? t('pos.pin.unavailable')
    : failure.code === 'invalid_pin' ? t('pos.pin.invalid')
    : t('pos.pin.failed')
  pinRef.value?.focus()
}

onMounted(async () => {
  if (!(await pinOffered())) {
    error.value = t('pos.pin.unavailable')
    return
  }
  codeRef.value?.focus()
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.pin-keys {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
</style>
