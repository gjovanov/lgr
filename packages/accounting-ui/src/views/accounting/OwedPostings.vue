<template>
  <!--
    FR-29.17 (D-5): the journal entries this organization's documents still owe. A banner with the counts, shown only
    when there are any; "Show" lists them with the document each is for and "Try again".
  -->
  <div v-if="owed || failed" class="mb-4" data-testid="owed-postings">
    <v-alert
      :type="failed ? 'error' : 'warning'"
      variant="tonal"
      density="compact"
    >
      <div class="d-flex align-center flex-wrap ga-2">
        <div>
          <div v-if="failed">{{ $t('accounting.journalEntry.postings.failed', { count: failed }) }}</div>
          <div v-if="owed">{{ $t('accounting.journalEntry.postings.owed', { count: owed }) }}</div>
        </div>
        <v-spacer />
        <v-btn size="small" variant="text" data-testid="owed-postings-toggle" @click="open = !open">
          {{ open ? $t('accounting.journalEntry.postings.hide') : $t('accounting.journalEntry.postings.show') }}
        </v-btn>
      </div>
    </v-alert>
    <v-table v-if="open" density="compact" class="mt-2">
      <thead>
        <tr>
          <th>{{ $t('accounting.journalEntry.postings.columns.document') }}</th>
          <th>{{ $t('accounting.journalEntry.postings.columns.event') }}</th>
          <th>{{ $t('accounting.journalEntry.postings.columns.state') }}</th>
          <th class="text-end">{{ $t('accounting.journalEntry.postings.columns.attempts') }}</th>
          <th>{{ $t('accounting.journalEntry.postings.columns.lastError') }}</th>
          <th>{{ $t('accounting.journalEntry.postings.columns.createdAt') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in postings" :key="p.id">
          <td>{{ p.document?.number || '—' }}</td>
          <td>{{ eventLabel(p.event) }}</td>
          <td>
            <v-chip size="x-small" :color="p.state === 'failed' ? 'error' : 'warning'">
              {{ $t(`accounting.journalEntry.postings.states.${p.state}`) }}
            </v-chip>
          </td>
          <td class="text-end">{{ p.attempts }}</td>
          <td class="text-medium-emphasis">{{ p.lastError || '' }}</td>
          <td>{{ p.createdAt?.split('T')[0] }}</td>
          <td class="text-end">
            <v-btn
              v-cap="'journal.create'"
              size="x-small"
              variant="text"
              :loading="retrying === p.id"
              @click="retry(p)"
            >
              {{ $t('accounting.journalEntry.postings.retry') }}
            </v-btn>
          </td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../../store/app.store'

interface OwedPosting {
  id: string
  event: string
  state: 'queued' | 'failed'
  attempts: number
  lastError?: string
  createdAt?: string
  document?: { kind: string; id: string; number?: string }
}

const emit = defineEmits<{ posted: [] }>()
const { t, te } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const owed = ref(0)
const failed = ref(0)
const postings = ref<OwedPosting[]>([])
const open = ref(false)
const retrying = ref<string | null>(null)

const url = () => `/org/${appStore.currentOrg?.id}/accounting/journal/postings`

function eventLabel(event: string): string {
  // The keys spell the event with underscores: a dot in a key is a level of the catalogue.
  const key = `accounting.journalEntry.postings.events.${event.replace(/\./g, '_')}`
  return te(key) ? t(key) : event
}

async function load() {
  try {
    const { data } = await httpClient.get(url())
    owed.value = data.owed ?? 0
    failed.value = data.failed ?? 0
    postings.value = data.postings ?? []
  } catch {
    // The banner is a hint beside the journal: a list that did not load leaves the page as it was.
    owed.value = 0
    failed.value = 0
    postings.value = []
  }
}

async function retry(p: OwedPosting) {
  retrying.value = p.id
  try {
    const { data } = await httpClient.post(`${url()}/${p.id}/retry`)
    const key = `accounting.journalEntry.postings.outcomes.${data.outcome}`
    if (data.outcome === 'done') {
      showSuccess(t(key))
      emit('posted')
    } else {
      showError(te(key) ? t(key) : String(data.outcome))
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    retrying.value = null
    await load()
  }
}

onMounted(load)
defineExpose({ load })
</script>
