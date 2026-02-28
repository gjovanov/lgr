<template>
  <v-container>
    <v-row>
      <v-col>
        <div class="d-flex align-center mb-4">
          <h1 class="text-h5">Invites</h1>
          <v-spacer />
          <v-btn color="primary" @click="showCreateDialog = true">
            <v-icon start>mdi-plus</v-icon>
            Create Invite
          </v-btn>
        </div>

        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          density="comfortable"
        >
          <template #item.code="{ item }">
            <code>{{ item.code }}</code>
            <v-btn icon size="x-small" variant="text" @click="copyLink(item.code)">
              <v-icon size="small">mdi-content-copy</v-icon>
            </v-btn>
          </template>
          <template #item.status="{ item }">
            <v-chip :color="statusColor(item.status)" size="small" variant="tonal">
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.target="{ item }">
            {{ item.targetEmail || 'Anyone' }}
          </template>
          <template #item.usage="{ item }">
            {{ item.useCount }} / {{ item.maxUses || '∞' }}
          </template>
          <template #item.createdAt="{ item }">
            {{ new Date(item.createdAt).toLocaleDateString() }}
          </template>
          <template #item.actions="{ item }">
            <v-btn
              v-if="item.status === 'active'"
              icon
              size="small"
              variant="text"
              color="error"
              @click="handleRevoke(item._id)"
            >
              <v-icon>mdi-close-circle-outline</v-icon>
            </v-btn>
          </template>
        </v-data-table-server>
      </v-col>
    </v-row>

    <!-- Create Dialog -->
    <v-dialog v-model="showCreateDialog" max-width="480">
      <v-card>
        <v-card-title>Create Invite</v-card-title>
        <v-card-text>
          <v-radio-group v-model="createMode" inline class="mb-4">
            <v-radio label="Shareable Link" value="link" />
            <v-radio label="Email Invite" value="email" />
          </v-radio-group>

          <template v-if="createMode === 'email'">
            <v-text-field
              v-model="createForm.targetEmail"
              label="Target Email"
              type="email"
              variant="outlined"
              density="compact"
            />
          </template>
          <template v-else>
            <v-text-field
              v-model.number="createForm.maxUses"
              label="Max Uses (empty = unlimited)"
              type="number"
              variant="outlined"
              density="compact"
              class="mb-2"
            />
          </template>

          <v-text-field
            v-model.number="createForm.expiresInHours"
            label="Expires In (hours, empty = never)"
            type="number"
            variant="outlined"
            density="compact"
            class="mb-2"
          />
          <v-select
            v-model="createForm.assignRole"
            label="Role"
            :items="['member', 'accountant', 'hr_manager', 'warehouse_manager', 'sales', 'manager', 'admin']"
            variant="outlined"
            density="compact"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showCreateDialog = false">Cancel</v-btn>
          <v-btn color="primary" @click="handleCreate">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="copySnackbar" :timeout="2000" color="success">
      Invite link copied to clipboard!
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useInviteStore } from '../../store/invite.store'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

const inviteStore = useInviteStore()
const appStore = useAppStore()

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invite`),
  entityKey: 'invites',
})
const showCreateDialog = ref(false)
const copySnackbar = ref(false)
const createMode = ref('link')

const createForm = reactive({
  targetEmail: '',
  maxUses: null as number | null,
  expiresInHours: null as number | null,
  assignRole: 'member',
})

const headers = [
  { title: 'Code', key: 'code', sortable: false },
  { title: 'Status', key: 'status' },
  { title: 'Target', key: 'target', sortable: false },
  { title: 'Usage', key: 'usage', sortable: false },
  { title: 'Created', key: 'createdAt' },
  { title: '', key: 'actions', sortable: false, width: 50 },
]

function statusColor(status: string) {
  const map: Record<string, string> = { active: 'success', revoked: 'error', exhausted: 'warning', expired: 'grey' }
  return map[status] || 'grey'
}

function copyLink(code: string) {
  const url = `${window.location.origin}/invite/${code}`
  navigator.clipboard.writeText(url)
  copySnackbar.value = true
}

async function handleCreate() {
  const params: any = { assignRole: createForm.assignRole }
  if (createMode.value === 'email') {
    params.targetEmail = createForm.targetEmail
  } else if (createForm.maxUses) {
    params.maxUses = createForm.maxUses
  }
  if (createForm.expiresInHours) {
    params.expiresInHours = createForm.expiresInHours
  }
  await inviteStore.createInvite(params)
  showCreateDialog.value = false
  createForm.targetEmail = ''
  createForm.maxUses = null
  createForm.expiresInHours = null
  createForm.assignRole = 'member'
  await fetchItems()
}

async function handleRevoke(id: string) {
  await inviteStore.revokeInvite(id)
  await fetchItems()
}
</script>
