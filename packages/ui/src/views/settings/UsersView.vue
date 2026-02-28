<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('settings.users') }}</h1>
      <v-spacer />
      <v-btn variant="outlined" prepend-icon="mdi-email-plus" class="mr-2" @click="inviteDialog = true">
        {{ $t('settings.inviteUser') }}
      </v-btn>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.create') }}
      </v-btn>
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
          item-value="_id"
          @update:options="onUpdateOptions"
        >
          <template #item.active="{ item }">
            <v-chip :color="item.active ? 'success' : 'grey'" size="small">
              {{ item.active ? $t('common.active') : $t('common.inactive') }}
            </v-chip>
          </template>
          <template #item.role="{ item }">
            <v-chip :color="roleColor(item.role)" size="small" variant="outlined">{{ item.role }}</v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit User Dialog -->
    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('settings.user') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" /></v-col>
            <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" /></v-col>
          </v-row>
          <v-text-field v-model="form.email" :label="$t('common.email')" type="email" class="mb-2" />
          <v-text-field v-model="form.username" :label="$t('auth.username')" class="mb-2" />
          <v-text-field v-if="!editing" v-model="form.password" :label="$t('auth.password')" type="password" class="mb-2" />
          <v-select v-model="form.role" :label="$t('settings.role')" :items="roles" class="mb-2" />
          <div class="text-subtitle-2 mb-2">{{ $t('settings.permissions') }}</div>
          <v-row>
            <v-col v-for="perm in availablePermissions" :key="perm" cols="12" sm="6" md="4">
              <v-checkbox v-model="form.permissions" :value="perm" :label="perm" density="compact" hide-details />
            </v-col>
          </v-row>
          <v-switch v-model="form.active" :label="$t('common.active')" color="primary" class="mt-4" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Invite User Dialog -->
    <v-dialog v-model="inviteDialog" max-width="400" persistent>
      <v-card>
        <v-card-title>{{ $t('settings.inviteUser') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="inviteEmail" :label="$t('common.email')" type="email" class="mb-2" />
          <v-select v-model="inviteRole" :label="$t('settings.role')" :items="roles" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="inviteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="inviting" @click="sendInvite">{{ $t('settings.sendInvite') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

const { t } = useI18n()
const store = useSettingsStore()
const appStore = useAppStore()

const dialog = ref(false)
const inviteDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const inviting = ref(false)
const inviteEmail = ref('')
const inviteRole = ref('Viewer')

const roles = ['Admin', 'Manager', 'Accountant', 'HR', 'Sales', 'Viewer']
const availablePermissions = [
  'accounting.read', 'accounting.write', 'invoicing.read', 'invoicing.write',
  'warehouse.read', 'warehouse.write', 'payroll.read', 'payroll.write',
  'hr.read', 'hr.write', 'crm.read', 'crm.write',
  'erp.read', 'erp.write', 'settings.read', 'settings.write',
  'admin.read', 'admin.write',
]

const headers = [
  { title: t('common.name'), key: 'fullName' },
  { title: t('common.email'), key: 'email' },
  { title: t('auth.username'), key: 'username' },
  { title: t('settings.role'), key: 'role' },
  { title: t('common.active'), key: 'active' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const emptyForm = () => ({
  _id: '', firstName: '', lastName: '', email: '', username: '',
  password: '', role: 'Viewer', permissions: [] as string[], active: true,
})

const form = reactive(emptyForm())

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${orgUrl()}/user`),
  entityKey: 'users',
})

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, { ...item, permissions: [...(item.permissions || [])] })
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    await store.saveUser({ ...form })
    dialog.value = false
    await fetchItems()
  } finally {
    saving.value = false
  }
}

async function sendInvite() {
  inviting.value = true
  try {
    await store.inviteUser(inviteEmail.value)
    inviteDialog.value = false
    inviteEmail.value = ''
  } finally {
    inviting.value = false
  }
}

function roleColor(role: string) {
  const colors: Record<string, string> = { Admin: 'error', Manager: 'warning', Accountant: 'info', HR: 'purple', Sales: 'success', Viewer: 'grey' }
  return colors[role] || 'grey'
}

onMounted(() => fetchItems())
</script>
