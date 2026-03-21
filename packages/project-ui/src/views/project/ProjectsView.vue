<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('project.projects') }}</h1>
      <div class="d-flex ga-2">
        <v-btn-toggle v-model="viewMode" mandatory density="compact">
          <v-btn value="table" icon="mdi-table" />
          <v-btn value="cards" icon="mdi-view-grid" />
        </v-btn-toggle>
        <responsive-btn icon="mdi-plus" color="primary" :to="{ name: 'project.projects.new' }">{{ t('common.create') }}</responsive-btn>
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="stateFilter" :label="t('common.state')" :items="projectStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="project" :org-url="appStore.orgUrl()" :label="t('common.filterByTags')" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Table View -->
    <v-card v-if="viewMode === 'table'">
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.name="{ item }">
            <entity-link :label="item.name" :to="{ name: 'project.projects.detail', params: { id: item._id || item.id } }" />
          </template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.manager="{ item }">
            {{ item.manager ? `${item.manager.firstName} ${item.manager.lastName}` : '-' }}
          </template>
          <template #item.partner="{ item }">
            {{ item.partner?.companyName || item.partner?.firstName ? `${item.partner.firstName} ${item.partner.lastName}` : '-' }}
          </template>
          <template #item.budgetPlanned="{ item }">{{ fmtCurrency(item.budgetPlanned) }}</template>
          <template #item.dateStart="{ item }">{{ item.dateStart?.split('T')[0] || '-' }}</template>
          <template #item.dateEnd="{ item }">{{ item.dateEnd?.split('T')[0] || '-' }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'project.projects.detail', params: { id: item._id || item.id } }" />
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'project.projects.edit', params: { id: item._id || item.id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Card Grid View -->
    <v-row v-else>
      <v-col v-for="project in items" :key="project._id || project.id" cols="12" sm="6" md="4" lg="3">
        <v-card class="h-100" hover @click="$router.push({ name: 'project.projects.detail', params: { id: project._id || project.id } })">
          <v-card-title class="d-flex align-center ga-2">
            <v-avatar v-if="project.color" :color="project.color" size="24" />
            <span class="text-truncate">{{ project.name }}</span>
          </v-card-title>
          <v-card-text>
            <div class="d-flex align-center justify-space-between mb-2">
              <v-chip size="small" :color="stateColor(project.state)">{{ project.state }}</v-chip>
              <span class="text-caption text-medium-emphasis">
                {{ project.manager ? `${project.manager.firstName} ${project.manager.lastName}` : '' }}
              </span>
            </div>
            <div class="text-caption mb-1">{{ t('project.budget') }}</div>
            <v-progress-linear
              :model-value="project.budgetPlanned > 0 ? (project.budgetSpent / project.budgetPlanned) * 100 : 0"
              :color="project.budgetSpent > project.budgetPlanned ? 'error' : 'primary'"
              height="8"
              rounded
            />
            <div class="d-flex justify-space-between text-caption mt-1">
              <span>{{ fmtCurrency(project.budgetSpent) }}</span>
              <span>{{ fmtCurrency(project.budgetPlanned) }}</span>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-if="items.length === 0" cols="12">
        <v-card class="text-center pa-8 text-disabled">{{ t('common.noData') }}</v-card>
      </v-col>
    </v-row>

    <!-- Delete Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useProjectStore } from '../../store/project.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import TagInput from 'ui-shared/components/TagInput.vue'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref<'table' | 'cards'>('cards')
const stateFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const deleteDialog = ref(false)
const selectedId = ref('')

const projectStates = ['in_progress', 'done', 'cancelled', 'on_hold']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (stateFilter.value) f.state = stateFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/project/projects`),
  entityKey: 'projects',
  filters,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('common.state'), key: 'state' },
  { title: t('project.manager'), key: 'manager' },
  { title: t('project.partner'), key: 'partner' },
  { title: t('project.budget'), key: 'budgetPlanned', align: 'end' as const },
  { title: t('project.startDate'), key: 'dateStart' },
  { title: t('project.endDate'), key: 'dateEnd' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

function stateColor(state: string) {
  return ({ in_progress: 'primary', done: 'success', cancelled: 'error', on_hold: 'warning' }[state] || 'grey')
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }

async function doDelete() {
  try {
    await store.deleteProject(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchItems() })
</script>
