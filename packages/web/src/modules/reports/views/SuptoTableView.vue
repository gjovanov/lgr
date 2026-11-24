<template>
  <v-container fluid>
    <ReportPageHeader
      :title="meta ? $t(meta.labelKey) : `СУПТО ${tableId}`"
      :subtitle="meta ? $t(meta.descriptionKey) : undefined"
    />

    <v-row v-if="loading">
      <v-col cols="12" class="d-flex justify-center py-8">
        <v-progress-circular indeterminate color="primary" />
      </v-col>
    </v-row>

    <v-alert v-else-if="!meta" type="warning" variant="tonal">
      {{ $t('reports.runner.notFound') }}
    </v-alert>

    <template v-else>
      <v-alert type="info" variant="tonal" density="compact" class="mb-4">
        {{ $t('reports.supto.notice') }}
      </v-alert>

      <v-card>
        <v-card-text>
          <v-row v-if="needsPeriod" dense align="center">
            <v-col cols="12" sm="6" md="3">
              <v-select
                v-model="preset"
                :items="periodPresetItems"
                :label="$t('reports.params.period')"
                density="compact"
                variant="outlined"
                hide-details
              />
            </v-col>
            <template v-if="preset === 'custom'">
              <v-col cols="12" sm="6" md="3">
                <DateField v-model="from" :label="$t('common.from')" density="compact" variant="outlined" hide-details />
              </v-col>
              <v-col cols="12" sm="6" md="3">
                <DateField v-model="to" :label="$t('common.to')" density="compact" variant="outlined" hide-details />
              </v-col>
            </template>
            <v-col cols="12" md="3" class="text-caption text-medium-emphasis">
              {{ resolvedRange }}
            </v-col>
          </v-row>

          <p v-else class="text-body-2 text-medium-emphasis mb-0">
            {{ $t('reports.supto.snapshotHint') }}
          </p>
        </v-card-text>

        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-download"
            :loading="downloading"
            :disabled="needsPeriod && !range.from"
            @click="download"
          >
            {{ $t('reports.supto.download') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { decodeBlobError } from 'ui-shared/composables/useInvoicingExport'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import DateField from 'ui-shared/components/DateField.vue'
import ReportPageHeader from '../components/ReportPageHeader.vue'
import { useAppStore } from '../store/app.store'
import { PERIOD_PRESETS, resolvePeriod, type ReportMeta, type PeriodPreset } from '../types/report'

/**
 * FR-06 (#14) P2 — the SUPTO (НАП, Наредба Н-18 Приложение 29) tables, 18.1–18.9.
 *
 * Nine registry cards share this one page. It is deliberately NOT the generic runner: those
 * workbooks have a legally prescribed layout produced by `reporting/excel/supto.excel.ts`,
 * and it downloads them from the unchanged `/supto/export/:tableId` endpoint (FR-6.20).
 * There is no table preview for the same reason — showing an approximation of a document a
 * tax inspector is about to receive would be worse than showing nothing.
 *
 * The catalog is still the gate: this page renders only what `/reports/catalog` returned, so
 * a manager (who holds every module permission but is not in `roles`) gets "not found" here
 * exactly as they do in the hub.
 */

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const meta = ref<ReportMeta | null>(null)
const loading = ref(true)
const downloading = ref(false)

/** Route param is the dotted table id the endpoint wants: `18.1`. */
const tableId = computed(() => String(route.params.table || ''))
const reportId = computed(() => `supto-${tableId.value.replace('.', '-')}`)
const needsPeriod = computed(() => (meta.value?.params.length || 0) > 0)

const preset = ref<PeriodPreset>('last_month')
const from = ref<string | null>(null)
const to = ref<string | null>(null)

// Shareable link, same convention as the runner.
useListQueryState([
  { key: 'preset', ref: preset as any, default: 'last_month' },
  { key: 'from', ref: from, codec: 'date' },
  { key: 'to', ref: to, codec: 'date' },
])

const periodPresetItems = computed(() =>
  PERIOD_PRESETS.map(p => ({ value: p, title: t(`reports.periods.${p}`) })),
)

const range = computed(() =>
  resolvePeriod({ preset: preset.value, from: from.value || undefined, to: to.value || undefined }),
)
const resolvedRange = computed(() =>
  range.value.from ? `${range.value.from} — ${range.value.to || range.value.from}` : '',
)

async function load() {
  loading.value = true
  try {
    if (!appStore.currentOrg?.id) await appStore.fetchProfile()
    const { data } = await httpClient.get(`${appStore.orgUrl()}/reports/catalog`)
    meta.value = (data.reports || []).find((r: ReportMeta) => r.id === reportId.value) || null
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
    meta.value = null
  } finally {
    loading.value = false
  }
}

async function download() {
  downloading.value = true
  try {
    const params: Record<string, string> = {}
    if (needsPeriod.value) {
      params.dateFrom = range.value.from!
      params.dateTo = range.value.to || range.value.from!
    }
    const res = await httpClient.get(`${appStore.orgUrl()}/supto/export/${tableId.value}`, {
      params,
      responseType: 'blob',
    })

    const blob = new Blob([res.data], { type: res.headers['content-type'] })
    const dispo = res.headers['content-disposition'] as string | undefined
    const filename = dispo?.match(/filename="([^"]+)"/)?.[1] || `supto-${tableId.value}.xlsx`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
    showSuccess(t('common.downloadStarted'))
  } catch (e: any) {
    // Under responseType:'blob' the server's JSON error arrives as a Blob — decode in place.
    await decodeBlobError(e).catch(() => {})
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    downloading.value = false
  }
}

onMounted(load)
</script>
