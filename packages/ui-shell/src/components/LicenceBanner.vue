<template>
  <v-alert
    v-if="shown"
    :type="kind"
    variant="tonal"
    density="compact"
    rounded="0"
    class="licence-banner"
    :closable="status?.state !== 'restricted'"
    data-test="licence-banner"
    @click:close="dismissed = true"
  >
    <div class="text-body-2">{{ text }}</div>
    <div v-if="status?.problem" class="text-caption mt-1">{{ t('licence.problem', { why: t(`licence.problems.${status.problem}`) }) }}</div>
  </v-alert>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'

/**
 * FR-20.55 (plan step P2-3b) — where this server's licence for the org stands, above every page of
 * every app. Only on an on-prem master: lgrai.app answers `{applies: false}` and nothing shows.
 *
 * Shown while the server is on its evaluation, in its grace, or restricted. Only the restricted
 * banner cannot be closed: it is the one that explains why a till will not open.
 */

const props = defineProps<{ orgId?: string | null }>()
const { t, locale } = useI18n()

interface Status {
  applies: true
  state: 'licensed' | 'grace' | 'evaluation' | 'restricted'
  basis: 'licence' | 'evaluation'
  paidThrough?: string
  restrictedFrom: string
  problem?: string
}

const status = ref<Status | null>(null)
const dismissed = ref(false)

async function load(orgId?: string | null) {
  status.value = null
  dismissed.value = false
  if (!orgId) return
  try {
    const { data } = await httpClient.get(`/org/${orgId}/licence`)
    status.value = data?.applies ? data : null
  } catch {
    status.value = null
  }
}
watch(() => props.orgId, id => { void load(id) }, { immediate: true })

const shown = computed(() => !!status.value && status.value.state !== 'licensed' && (status.value.state === 'restricted' || !dismissed.value))
const kind = computed(() => (status.value?.state === 'restricted' ? 'error' : status.value?.state === 'grace' ? 'warning' : 'info'))

/** `YYYY-MM-DD` on the org's calendar, or an ISO instant: shown as a date in the reader's language. */
function day(value?: string): string {
  if (!value) return ''
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale.value) : value
}

const text = computed(() => {
  const s = status.value
  if (!s) return ''
  const date = day(s.restrictedFrom)
  if (s.state === 'restricted') return t(s.basis === 'evaluation' ? 'licence.restrictedEvaluation' : 'licence.restricted', { date })
  if (s.state === 'grace') return t('licence.grace', { paid: day(s.paidThrough), date })
  return t('licence.evaluation', { date })
})
</script>

<style scoped>
.licence-banner {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
