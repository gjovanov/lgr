<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h5">{{ t('helpdesk.teams') }}</h1>
      <responsive-btn icon="mdi-plus" color="primary" @click="openCreate">{{ t('common.create') }}</responsive-btn>
    </div>

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
          <template #item.leaderId="{ item }">{{ userNameById(item.leaderId) }}</template>
          <template #item.memberIds="{ item }">{{ (item.memberIds || []).length }}</template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive ? 'success' : 'grey'">
              {{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            <v-autocomplete
              v-model="form.leaderId"
              :label="t('helpdesk.leader')"
              :items="users"
              :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
              item-value="_id"
              :rules="[rules.required]"
            />
            <v-autocomplete
              v-model="form.memberIds"
              :label="t('helpdesk.members')"
              :items="users"
              :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
              item-value="_id"
              multiple
              chips
              closable-chips
            />
            <v-select
              v-model="form.assignmentMethod"
              :label="t('helpdesk.assignmentMethod')"
              :items="['round_robin', 'manual', 'load_balanced']"
            />
            <v-text-field v-model="form.emailAlias" :label="t('helpdesk.emailAlias')" />
            <v-textarea v-model="form.description" :label="t('common.description')" rows="2" auto-grow />
            <v-checkbox v-if="editing" v-model="form.isActive" :label="t('common.active')" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

const { t } = useI18n()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const users = ref<any[]>([])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/helpdesk/teams`),
  entityKey: 'teams',
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('helpdesk.leader'), key: 'leaderId' },
  { title: t('helpdesk.memberCount'), key: 'memberIds' },
  { title: t('helpdesk.assignmentMethod'), key: 'assignmentMethod' },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function userNameById(id: string) {
  const u = users.value.find((u: any) => u._id === id || u.id === id)
  return u ? `${u.firstName} ${u.lastName}` : id
}

const emptyForm = () => ({
  name: '',
  leaderId: '',
  memberIds: [] as string[],
  assignmentMethod: 'round_robin',
  emailAlias: '',
  description: '',
  isActive: true,
})
const form = ref(emptyForm())

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: any) {
  editing.value = true
  selectedId.value = item._id || item.id
  form.value = {
    name: item.name || '',
    leaderId: item.leaderId || '',
    memberIds: item.memberIds || [],
    assignmentMethod: item.assignmentMethod || 'round_robin',
    emailAlias: item.emailAlias || '',
    description: item.description || '',
    isActive: item.isActive !== false,
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (editing.value) {
      await store.updateTeam(selectedId.value, form.value)
    } else {
      await store.createTeam(form.value)
    }
    dialog.value = false
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }
async function doDelete() {
  try {
    await store.deleteTeam(selectedId.value)
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
    const { data } = await httpClient.get(`${portalBase}/org/${appStore.currentOrg?.id}/users`)
    users.value = data.users || data || []
  } catch { /* */ }
}

onMounted(async () => {
  await fetchUsers()
  fetchItems()
})
</script>
