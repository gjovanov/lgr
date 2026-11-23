<template>
  <v-container fluid>
    <ReportPageHeader
      :title="meta ? $t(meta.labelKey) : $t('reports.hub.title')"
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

    <!-- Mounted only once the catalog answered, so ReportRunner's setup already knows the
         report's `params` and can bind them to the URL via useListQueryState. `key` forces a
         fresh instance (and a fresh URL binding) when navigating between two reports. -->
    <ReportRunner v-else :key="meta.id" :meta="meta" />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ReportRunner from '../components/ReportRunner.vue'
import ReportPageHeader from '../components/ReportPageHeader.vue'
import { useAppStore } from '../store/app.store'
import type { ReportMeta } from '../types/report'

/**
 * FR-6.9 — loader shell for the generic runner. Its only job is to resolve `:id` against
 * the catalog (which has already applied the permission + role gate, so an entry this user
 * may not run simply is not there) and hand the entry to `ReportRunner`.
 */

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { showError } = useSnackbar()

const meta = ref<ReportMeta | null>(null)
const loading = ref(true)

const reportId = computed(() => String(route.params.id || ''))

async function load() {
  loading.value = true
  meta.value = null
  try {
    if (!appStore.currentOrg?.id) await appStore.fetchProfile()
    const { data } = await httpClient.get(`${appStore.orgUrl()}/reports/catalog`)
    const entry = (data.reports || []).find((r: ReportMeta) => r.id === reportId.value)
    // `custom` entries have their own view and no generic handler — the runner cannot run them.
    meta.value = entry && entry.view === 'runner' ? entry : null
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
    meta.value = null
  } finally {
    loading.value = false
  }
}

watch(reportId, load)
onMounted(load)
</script>
