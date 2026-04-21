<template>
  <v-container fluid>
    <h1 class="text-h5 mb-4">{{ $t('reporting.export.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mb-6">{{ $t('reporting.export.hint') }}</p>

    <v-row>
      <v-col v-for="card in cards" :key="card.kind" cols="12" md="4">
        <v-card variant="outlined" class="h-100">
          <v-card-title class="d-flex align-center">
            <v-icon class="mr-2" :color="card.color">{{ card.icon }}</v-icon>
            {{ $t(card.titleKey) }}
          </v-card-title>
          <v-card-text>
            <p class="text-body-2 text-medium-emphasis mb-4">{{ $t(card.descKey) }}</p>
            <v-row dense>
              <v-col cols="6">
                <v-text-field
                  v-model="card.startDate"
                  :label="$t('invoicing.dateFrom')"
                  type="date"
                  density="compact"
                  hide-details
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model="card.endDate"
                  :label="$t('invoicing.dateTo')"
                  type="date"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn color="primary" variant="flat" prepend-icon="mdi-download" :loading="card.loading" @click="openDialog(card)">
              {{ $t('common.export') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <ExportDialog
      v-model="dialogOpen"
      :doc-type="activeDocType"
      :loading="activeCard?.loading || false"
      @confirm="onConfirm"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportDialog from 'ui-shared/components/ExportDialog.vue'
import type { DocType } from 'ui-shared/composables/useExportColumns'

type Kind = 'outgoing' | 'incoming' | 'cash_register'

interface Card {
  kind: Kind
  titleKey: string
  descKey: string
  icon: string
  color: string
  docType: DocType
  startDate: string
  endDate: string
  loading: boolean
}

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const cards = reactive<Card[]>([
  { kind: 'outgoing',      titleKey: 'reporting.export.outgoing.title',     descKey: 'reporting.export.outgoing.desc',     icon: 'mdi-file-export-outline',  color: 'primary', docType: 'invoice',   startDate: '', endDate: '', loading: false },
  { kind: 'incoming',      titleKey: 'reporting.export.incoming.title',     descKey: 'reporting.export.incoming.desc',     icon: 'mdi-file-import-outline',  color: 'info',    docType: 'bill',      startDate: '', endDate: '', loading: false },
  { kind: 'cash_register', titleKey: 'reporting.export.cashRegister.title', descKey: 'reporting.export.cashRegister.desc', icon: 'mdi-cash-register',        color: 'success', docType: 'cash_sale', startDate: '', endDate: '', loading: false },
])

const dialogOpen = ref(false)
const activeCard = ref<Card | null>(null)
const activeDocType = computed<DocType>(() => activeCard.value?.docType || 'invoice')

function openDialog(card: Card) {
  activeCard.value = card
  dialogOpen.value = true
}

async function onConfirm(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns: string[] }) {
  const card = activeCard.value
  if (!card) return
  card.loading = true
  try {
    const url = `${appStore.orgUrl()}/invoicing/export/kind/${card.kind}`
    const res = await httpClient.post(url, {
      format: opts.format,
      mode: opts.mode,
      columns: opts.columns,
      startDate: card.startDate || undefined,
      endDate: card.endDate || undefined,
    }, { responseType: 'blob' })

    const blob = new Blob([res.data], { type: res.headers['content-type'] })
    const dispo = res.headers['content-disposition'] as string | undefined
    const match = dispo?.match(/filename="([^"]+)"/)
    const filename = match?.[1] || `reporting-${card.kind}.${opts.format}`

    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
    showSuccess(t('common.downloadStarted'))
    dialogOpen.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    card.loading = false
  }
}
</script>
