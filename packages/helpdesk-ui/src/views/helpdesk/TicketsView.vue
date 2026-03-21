<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('helpdesk.tickets') }}</h1>
      <div class="d-flex ga-2">
        <v-btn-toggle v-model="viewMode" mandatory density="compact">
          <v-btn value="list" icon="mdi-table" />
          <v-btn value="board" icon="mdi-view-column" />
        </v-btn-toggle>
        <responsive-btn icon="mdi-plus" color="primary" :to="{ name: 'helpdesk.tickets.new' }">{{ t('common.create') }}</responsive-btn>
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="2">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="stateFilter" :label="t('common.state')" :items="ticketStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="priorityFilter" :label="t('helpdesk.priority')" :items="priorities" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="teamFilter" :label="t('helpdesk.team')" :items="teamOptions" item-title="name" :item-value="(t: any) => t._id || t.id" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="slaStatusFilter" :label="t('helpdesk.slaStatus')" :items="slaStatuses" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <TagInput v-model="tagFilter" type="ticket" :org-url="appStore.orgUrl()" :label="t('common.filterByTags')" />
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
            <entity-link :label="item.name" :to="{ name: 'helpdesk.tickets.detail', params: { id: item._id || item.id } }" />
          </template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.priority="{ item }">
            <v-chip size="small" :color="priorityColor(item.priority)">{{ item.priority }}</v-chip>
          </template>
          <template #item.slaStatus="{ item }">
            <v-chip size="small" :color="slaColor(item.slaStatus)">{{ item.slaStatus }}</v-chip>
          </template>
          <template #item.assignee="{ item }">
            {{ item.assignee ? `${item.assignee.firstName} ${item.assignee.lastName}` : '-' }}
          </template>
          <template #item.partner="{ item }">
            {{ item.partner?.companyName || (item.partner ? `${item.partner.firstName} ${item.partner.lastName}` : '-') }}
          </template>
          <template #item.createdAt="{ item }">{{ item.createdAt?.split('T')[0] }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'helpdesk.tickets.detail', params: { id: item._id || item.id } }" />
            <v-btn v-if="['new', 'closed'].includes(item.state)" icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Board View (Kanban by state) -->
    <div v-else class="d-flex overflow-x-auto" style="gap: 16px;">
      <div v-for="state in boardStates" :key="state" style="min-width: 280px; max-width: 320px; flex: 1;">
        <v-card class="h-100">
          <v-card-title class="text-subtitle-1 d-flex justify-space-between align-center">
            <div class="d-flex align-center ga-1">
              <v-chip size="x-small" :color="stateColor(state)">{{ state }}</v-chip>
            </div>
            <v-chip size="small">{{ ticketsForState(state).length }}</v-chip>
          </v-card-title>
          <v-card-text style="max-height: 60vh; overflow-y: auto;">
            <v-card
              v-for="ticket in ticketsForState(state)"
              :key="ticket._id || ticket.id"
              class="mb-2 pa-3"
              variant="outlined"
              @click="$router.push({ name: 'helpdesk.tickets.detail', params: { id: ticket._id || ticket.id } })"
            >
              <div class="text-subtitle-2">{{ ticket.name }}</div>
              <div class="text-caption text-medium-emphasis text-truncate">{{ ticket.description?.substring(0, 80) }}</div>
              <div class="d-flex align-center justify-space-between mt-2">
                <v-chip size="x-small" :color="priorityColor(ticket.priority)">{{ ticket.priority }}</v-chip>
                <v-chip size="x-small" :color="slaColor(ticket.slaStatus)">{{ ticket.slaStatus }}</v-chip>
              </div>
              <div class="d-flex align-center justify-space-between mt-1">
                <span class="text-caption text-medium-emphasis">
                  {{ ticket.assignee ? `${ticket.assignee.firstName} ${ticket.assignee.lastName}` : '' }}
                </span>
                <span class="text-caption text-medium-emphasis">
                  {{ ticket.partner?.companyName || '' }}
                </span>
              </div>
            </v-card>
            <div v-if="ticketsForState(state).length === 0" class="text-center text-caption text-disabled pa-4">
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
import { useAppStore } from '../../store/app.store'
import { useHelpdeskStore } from '../../store/helpdesk.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import TagInput from 'ui-shared/components/TagInput.vue'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref<'list' | 'board'>('board')
const stateFilter = ref<string | null>(null)
const priorityFilter = ref<string | null>(null)
const teamFilter = ref<string | null>(null)
const slaStatusFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const deleteDialog = ref(false)
const selectedId = ref('')
const teamOptions = ref<any[]>([])

const ticketStates = ['new', 'in_progress', 'on_hold', 'resolved', 'closed']
const boardStates = ['new', 'in_progress', 'on_hold', 'resolved', 'closed']
const priorities = ['low', 'normal', 'high', 'urgent']
const slaStatuses = ['none', 'on_track', 'at_risk', 'breached', 'met']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (stateFilter.value) f.state = stateFilter.value
  if (priorityFilter.value) f.priority = priorityFilter.value
  if (teamFilter.value) f.teamId = teamFilter.value
  if (slaStatusFilter.value) f.slaStatus = slaStatusFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/helpdesk/tickets`),
  entityKey: 'tickets',
  filters,
  defaultSize: 50,
})

const headers = computed(() => [
  { title: t('helpdesk.ticketNumber'), key: 'name', sortable: true },
  { title: t('common.state'), key: 'state' },
  { title: t('helpdesk.priority'), key: 'priority' },
  { title: t('helpdesk.slaStatus'), key: 'slaStatus' },
  { title: t('helpdesk.assignee'), key: 'assignee' },
  { title: t('helpdesk.partner'), key: 'partner' },
  { title: t('common.createdAt'), key: 'createdAt', sortable: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function ticketsForState(state: string) {
  return items.value.filter((t: any) => t.state === state)
}

function stateColor(state: string) {
  return ({ new: 'info', in_progress: 'primary', on_hold: 'warning', resolved: 'success', closed: 'grey' }[state] || 'grey')
}

function priorityColor(priority: string) {
  return ({ low: 'grey', normal: 'info', high: 'warning', urgent: 'error' }[priority] || 'grey')
}

function slaColor(status: string) {
  return ({ none: 'grey', on_track: 'success', at_risk: 'warning', breached: 'error', met: 'success' }[status] || 'grey')
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }

async function doDelete() {
  try {
    await store.deleteTicket(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  await store.fetchTeams()
  teamOptions.value = store.teams
  fetchItems()
})
</script>
