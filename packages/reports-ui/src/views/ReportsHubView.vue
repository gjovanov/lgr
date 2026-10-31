<template>
  <v-container>
    <v-row class="mb-2">
      <v-col>
        <h1 class="text-h4 mb-1">{{ $t('reports.hub.title') }}</h1>
        <p class="text-body-2 text-grey">{{ $t('reports.hub.subtitle') }}</p>
      </v-col>
      <v-col cols="12" sm="4" md="3">
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          :label="$t('common.search')"
          clearable
          hide-details
          density="compact"
          variant="outlined"
        />
      </v-col>
    </v-row>

    <v-row v-if="loading">
      <v-col cols="12" class="d-flex justify-center">
        <v-progress-circular indeterminate color="primary" />
      </v-col>
    </v-row>

    <template v-else-if="groups.length">
      <div v-for="group in groups" :key="group.category" class="mb-6">
        <h2 class="text-subtitle-1 text-medium-emphasis mb-2">
          {{ $t(`reports.categories.${group.category}`) }}
        </h2>
        <v-row>
          <v-col v-for="report in group.reports" :key="report.id" cols="12" sm="6" md="4" lg="3">
            <v-card class="report-card" height="200" @click="open(report)">
              <v-card-text class="d-flex flex-column align-center justify-center text-center" style="height: 100%">
                <v-avatar :color="CATEGORY_COLOR[report.category] || 'primary'" size="64" class="mb-3">
                  <v-icon size="32" color="white">{{ report.icon }}</v-icon>
                </v-avatar>
                <h3 class="text-h6">{{ $t(report.labelKey) }}</h3>
                <p class="text-caption text-grey mt-1">{{ $t(report.descriptionKey) }}</p>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </div>
    </template>

    <EmptyState
      v-else
      icon="mdi-file-chart-outline"
      :title="search ? $t('list.noMatches') : $t('reports.hub.empty')"
      :description="search ? $t('list.adjustFilters') : $t('reports.hub.emptyHint')"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { inModule } from 'ui-shared/nav/open-page'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import { useAppStore } from '../store/app.store'
import type { ReportMeta, ReportCategory } from '../types/report'

/**
 * FR-6.9 — the card hub, modeled on the portal's AppHubView. Every card comes from
 * `GET /reports/catalog`, which has ALREADY applied the permission + role gate: a report
 * this user may not run is absent from the response, so there is nothing to filter here.
 * Adding a report to the registry makes a card appear with no change to this file.
 */

const CATEGORY_COLOR: Record<string, string> = {
  sales: '#2196f3',
  purchase: '#00897b',
  receivables: '#f4511e',
  inventory: '#ff9800',
  fiscal: '#8e24aa',
}

/** Display order of the category sections; unknown categories sort last, alphabetically. */
const CATEGORY_ORDER: ReportCategory[] = ['sales', 'purchase', 'receivables', 'inventory', 'fiscal']

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const { showError } = useSnackbar()

const reports = ref<ReportMeta[]>([])
const loading = ref(true)
const search = ref('')

const filtered = computed(() => {
  const q = (search.value || '').trim().toLowerCase()
  if (!q) return reports.value
  return reports.value.filter(r =>
    t(r.labelKey).toLowerCase().includes(q) || t(r.descriptionKey).toLowerCase().includes(q),
  )
})

const groups = computed(() => {
  const byCategory = new Map<string, ReportMeta[]>()
  for (const r of filtered.value) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, [])
    byCategory.get(r.category)!.push(r)
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({ category, reports: list }))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category as ReportCategory)
      const bi = CATEGORY_ORDER.indexOf(b.category as ReportCategory)
      if (ai === -1 && bi === -1) return a.category.localeCompare(b.category)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
})

function open(report: ReportMeta) {
  // Both `custom` and `runner` entries live in this module; `route` is module-relative (FR-24.4).
  router.push(inModule(router.currentRoute.value, report.route))
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/reports/catalog`)
    reports.value = data.reports || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.report-card {
  cursor: pointer;
  transition: all 0.2s ease;
  border: 2px solid transparent;
}
.report-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
</style>
