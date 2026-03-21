<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h5">{{ t('helpdesk.knowledgeBase') }}</h1>
      <responsive-btn icon="mdi-plus" color="primary" :to="{ name: 'helpdesk.knowledge.new' }">{{ t('common.create') }}</responsive-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="accessLevelFilter" :label="t('helpdesk.accessLevel')" :items="accessLevels" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="publishedFilter" :label="t('helpdesk.published')" :items="publishedOptions" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="knowledge" :org-url="appStore.orgUrl()" :label="t('common.filterByTags')" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Table -->
    <v-card>
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
            <div :style="{ paddingLeft: getDepth(item) * 20 + 'px' }" class="d-flex align-center">
              <v-icon v-if="item.parentId" size="small" class="mr-1">mdi-subdirectory-arrow-right</v-icon>
              <entity-link :label="item.name" :to="{ name: 'helpdesk.knowledge.edit', params: { id: item._id || item.id } }" />
            </div>
          </template>
          <template #item.author="{ item }">
            {{ item.author ? `${item.author.firstName} ${item.author.lastName}` : '-' }}
          </template>
          <template #item.accessLevel="{ item }">
            <v-chip size="small" :color="accessLevelColor(item.accessLevel)">{{ item.accessLevel }}</v-chip>
          </template>
          <template #item.isPublished="{ item }">
            <v-icon :color="item.isPublished ? 'success' : 'grey'">
              {{ item.isPublished ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn v-if="!item.isPublished" icon="mdi-publish" size="small" variant="text" color="success" :title="t('helpdesk.publish')" @click="doPublish(item)" />
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'helpdesk.knowledge.edit', params: { id: item._id || item.id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

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
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const accessLevelFilter = ref<string | null>(null)
const publishedFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const deleteDialog = ref(false)
const selectedId = ref('')

const accessLevels = ['internal', 'public', 'restricted']
const publishedOptions = [
  { title: 'Published', value: 'true' },
  { title: 'Draft', value: 'false' },
]

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (accessLevelFilter.value) f.accessLevel = accessLevelFilter.value
  if (publishedFilter.value !== null && publishedFilter.value !== undefined) f.isPublished = publishedFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/helpdesk/knowledge`),
  entityKey: 'articles',
  filters,
  defaultSize: 50,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('helpdesk.author'), key: 'author' },
  { title: t('helpdesk.accessLevel'), key: 'accessLevel' },
  { title: t('helpdesk.published'), key: 'isPublished', align: 'center' as const },
  { title: t('helpdesk.version'), key: 'version', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

// Build a depth map from parentId relationships
function getDepth(item: any): number {
  if (!item.parentId) return 0
  const parent = items.value.find((a: any) => (a._id || a.id) === item.parentId)
  return parent ? getDepth(parent) + 1 : 1
}

function accessLevelColor(level: string) {
  return ({ internal: 'info', public: 'success', restricted: 'warning' }[level] || 'grey')
}

async function doPublish(item: any) {
  try {
    await store.publishKnowledgeArticle(item._id || item.id)
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }
async function doDelete() {
  try {
    await store.deleteKnowledgeArticle(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchItems() })
</script>
