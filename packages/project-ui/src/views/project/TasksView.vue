<template>
  <v-container :fluid="embedded" :class="{ 'pa-0': embedded }">
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 v-if="!embedded" class="text-h5">{{ t('project.tasks') }}</h1>
      <div class="d-flex ga-2">
        <v-btn-toggle v-model="viewMode" mandatory density="compact">
          <v-btn value="list" icon="mdi-table" />
          <v-btn value="board" icon="mdi-view-column" />
        </v-btn-toggle>
        <responsive-btn icon="mdi-plus" color="primary" @click="openCreate">{{ t('common.create') }}</responsive-btn>
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="stateFilter" :label="t('common.state')" :items="taskStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="priorityFilter" :label="t('project.priority')" :items="priorities" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="stageFilter" :label="t('project.stage')" :items="stageNames" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- List View -->
    <v-card v-if="viewMode === 'list'">
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
            <entity-link :label="item.name" :to="{ name: 'project.tasks.edit', params: { projectId: currentProjectId, id: item._id || item.id } }" />
          </template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.priority="{ item }">
            <v-chip size="small" :color="priorityColor(item.priority)">{{ item.priority }}</v-chip>
          </template>
          <template #item.assigneeIds="{ item }">
            <v-chip v-for="id in (item.assigneeIds || []).slice(0, 3)" :key="id" size="x-small" class="mr-1">
              {{ userNameById(id) }}
            </v-chip>
            <span v-if="(item.assigneeIds || []).length > 3" class="text-caption">+{{ item.assigneeIds.length - 3 }}</span>
          </template>
          <template #item.dateDeadline="{ item }">{{ item.dateDeadline?.split('T')[0] || '-' }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'project.tasks.edit', params: { projectId: currentProjectId, id: item._id || item.id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Board View (Kanban) -->
    <div v-else class="d-flex overflow-x-auto" style="gap: 16px;">
      <div v-for="stage in sortedStages" :key="stage.name" style="min-width: 280px; max-width: 320px; flex: 1;">
        <v-card class="h-100">
          <v-card-title class="text-subtitle-1 d-flex justify-space-between align-center">
            <span>{{ stage.name }}</span>
            <v-chip size="small">{{ tasksForStage(stage.name).length }}</v-chip>
          </v-card-title>
          <v-card-text style="max-height: 60vh; overflow-y: auto;">
            <v-card
              v-for="task in tasksForStage(stage.name)"
              :key="task._id || task.id"
              class="mb-2 pa-3"
              variant="outlined"
              @click="$router.push({ name: 'project.tasks.edit', params: { projectId: currentProjectId, id: task._id || task.id } })"
            >
              <div class="text-subtitle-2">{{ task.name }}</div>
              <div class="d-flex align-center justify-space-between mt-1">
                <v-chip size="x-small" :color="priorityColor(task.priority)">{{ task.priority }}</v-chip>
                <v-chip size="x-small" :color="stateColor(task.state)">{{ task.state }}</v-chip>
              </div>
              <div class="d-flex align-center mt-2 ga-1">
                <v-avatar v-for="id in (task.assigneeIds || []).slice(0, 3)" :key="id" size="20" color="primary">
                  <span class="text-caption text-white">{{ userInitials(id) }}</span>
                </v-avatar>
                <span v-if="task.dateDeadline" class="text-caption text-medium-emphasis ml-auto">
                  <v-icon size="12">mdi-calendar</v-icon> {{ task.dateDeadline.split('T')[0] }}
                </span>
              </div>
            </v-card>
            <div v-if="tasksForStage(stage.name).length === 0" class="text-center text-caption text-disabled pa-4">
              {{ t('common.noData') }}
            </div>
          </v-card-text>
        </v-card>
      </div>
    </div>

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
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useProjectStore } from '../../store/project.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

interface Props {
  projectId?: string
  stages?: Array<{ name: string; sequence: number; fold?: boolean }>
  embedded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  embedded: false,
  stages: () => [],
})

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref<'list' | 'board'>('board')
const stateFilter = ref<string | null>(null)
const priorityFilter = ref<string | null>(null)
const stageFilter = ref<string | null>(null)
const deleteDialog = ref(false)
const selectedId = ref('')
const users = ref<any[]>([])

const currentProjectId = computed(() => props.projectId || route.params.projectId as string)
const taskStates = ['open', 'in_progress', 'done', 'cancelled']
const priorities = ['low', 'normal', 'high', 'urgent']

const resolvedStages = computed(() => {
  if (props.stages && props.stages.length > 0) return props.stages
  return [
    { name: 'New', sequence: 1, fold: false },
    { name: 'In Progress', sequence: 2, fold: false },
    { name: 'Done', sequence: 3, fold: true },
  ]
})

const sortedStages = computed(() => [...resolvedStages.value].sort((a, b) => a.sequence - b.sequence))
const stageNames = computed(() => sortedStages.value.map(s => s.name))

const filters = computed(() => {
  const f: Record<string, any> = { projectId: currentProjectId.value }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (stateFilter.value) f.state = stateFilter.value
  if (priorityFilter.value) f.priority = priorityFilter.value
  if (stageFilter.value) f.stageName = stageFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/project/tasks`),
  entityKey: 'tasks',
  filters,
  defaultSize: 50,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('project.stage'), key: 'stageName' },
  { title: t('common.state'), key: 'state' },
  { title: t('project.priority'), key: 'priority' },
  { title: t('project.assignees'), key: 'assigneeIds' },
  { title: t('project.deadline'), key: 'dateDeadline' },
  { title: t('project.plannedHours'), key: 'plannedHours', align: 'end' as const },
  { title: t('project.effectiveHours'), key: 'effectiveHours', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function tasksForStage(stageName: string) {
  return items.value.filter((t: any) => t.stageName === stageName)
}

function stateColor(state: string) {
  return ({ open: 'info', in_progress: 'primary', done: 'success', cancelled: 'error' }[state] || 'grey')
}

function priorityColor(priority: string) {
  return ({ low: 'grey', normal: 'info', high: 'warning', urgent: 'error' }[priority] || 'grey')
}

function userNameById(id: string) {
  const u = users.value.find((u: any) => u._id === id || u.id === id)
  return u ? `${u.firstName?.[0] || ''}${u.lastName?.[0] || ''}` : '?'
}

function userInitials(id: string) {
  return userNameById(id)
}

function openCreate() {
  router.push({ name: 'project.tasks.new', params: { projectId: currentProjectId.value } })
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }

async function doDelete() {
  try {
    await store.deleteTask(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchUsers() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const { data } = await httpClient.get(`/org/${appStore.currentOrg?.id}/user`)
    users.value = data.users || data || []
  } catch { /* */ }
}

onMounted(async () => {
  await fetchUsers()
  fetchItems()
})
</script>
