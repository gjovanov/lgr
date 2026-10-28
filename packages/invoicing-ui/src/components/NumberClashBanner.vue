<template>
  <!-- FR-20.51, AC 51: a legal number issued twice, and its correction. Nothing while there is none. -->
  <v-alert v-if="open.length" type="warning" variant="tonal" density="compact" class="mb-3" data-test="number-clash-banner">
    <div class="d-flex align-center flex-wrap ga-2">
      <span>{{ $t('invoicing.numberClash.banner', { n: open.length }) }}</span>
      <v-spacer />
      <v-btn size="small" variant="tonal" data-test="number-clash-review" @click="dialog = true">{{ $t('invoicing.numberClash.review') }}</v-btn>
    </div>
  </v-alert>

  <v-dialog v-model="dialog" max-width="980">
    <v-card data-test="number-clash-dialog">
      <v-card-title>{{ $t('invoicing.numberClash.title') }}</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3">{{ $t('invoicing.numberClash.intro') }}</p>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('invoicing.numberClash.number') }}</th>
              <th>{{ $t('invoicing.numberClash.documents') }}</th>
              <th>{{ $t('invoicing.numberClash.correction') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in clashes" :key="c.id">
              <td class="font-weight-medium">{{ c.number }}</td>
              <td>
                <div v-for="d in [c.flagged, c.other].filter(Boolean)" :key="d.id" class="text-caption">
                  <router-link :to="{ name: 'invoicing.sales.edit', params: { id: d.id } }">{{ day(d.issueDate) }}</router-link>
                  · {{ d.contact || '—' }} · {{ fmt(d.total, d.currency) }}
                  <v-chip v-if="isLater(c, d)" size="x-small" color="warning" class="ml-1">{{ $t('invoicing.numberClash.later') }}</v-chip>
                </div>
              </td>
              <td>
                <v-chip v-if="c.resolved" size="small" color="success">{{ $t('invoicing.numberClash.corrected') }}</v-chip>
                <template v-else-if="c.correction">
                  <div class="text-caption">
                    <router-link v-if="c.correction.creditNote" :to="{ name: 'invoicing.sales.edit', params: { id: c.correction.creditNote.id } }">{{ c.correction.creditNote.number }}</router-link>
                    · <router-link v-if="c.correction.reissue" :to="{ name: 'invoicing.sales.edit', params: { id: c.correction.reissue.id } }">{{ c.correction.reissue.number }}</router-link>
                  </div>
                  <div class="text-caption text-medium-emphasis">{{ $t('invoicing.numberClash.prepared') }}</div>
                </template>
                <v-btn v-else-if="c.correctable" size="small" color="primary" variant="tonal" :loading="preparing === c.id" data-test="number-clash-prepare" @click="prepare(c)">{{ $t('invoicing.numberClash.prepare') }}</v-btn>
                <span v-else class="text-caption">{{ $t('invoicing.numberClash.byPerson') }}</span>
              </td>
            </tr>
          </tbody>
        </v-table>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="dialog = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useAppStore } from '../store/app.store'

/**
 * A legal number issued twice (FR-20.51, AC 51): the pairs, and their correction. The later document
 * of a pair is annulled by a credit note and re-issued under a new number (ЗДДС чл. 116); this
 * prepares both as drafts, which a person checks and issues as any other.
 */
const { t } = useI18n()
const { showSnackbar } = useSnackbar()
const { formatCurrency } = useCurrency()
const appStore = useAppStore()
const clashes = ref<any[]>([])
const dialog = ref(false)
const preparing = ref<string | null>(null)
const error = ref('')

const open = computed(() => clashes.value.filter(c => !c.resolved))
const day = (v: string | null) => (v ? String(v).slice(0, 10) : '—')
const fmt = (n: number, currency: string | null) => formatCurrency(n, currency ?? undefined)
const isLater = (c: any, d: any) => (c.later === 'flagged' ? c.flagged?.id : c.other?.id) === d.id

async function load() {
  const orgId = appStore.currentOrg?.id
  if (!orgId) return
  try {
    clashes.value = (await httpClient.get(`/org/${orgId}/invoicing/number-clashes`)).data.clashes ?? []
  } catch {
    clashes.value = []
  }
}

async function prepare(c: any) {
  const orgId = appStore.currentOrg?.id
  if (!orgId) return
  preparing.value = c.id
  error.value = ''
  try {
    await httpClient.post(`/org/${orgId}/invoicing/number-clashes/${c.id}/prepare`)
    showSnackbar(t('invoicing.numberClash.preparedToast'), 'success')
    await load()
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? t('invoicing.numberClash.failed')
  } finally {
    preparing.value = null
  }
}

onMounted(load)
</script>
