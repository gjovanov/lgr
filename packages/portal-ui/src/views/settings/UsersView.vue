<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('settings.users') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <responsive-btn icon="mdi-email-plus" variant="outlined" @click="inviteDialog = true">
          {{ $t('settings.inviteUser') }}
        </responsive-btn>
        <responsive-btn icon="mdi-plus" color="primary" @click="openDialog()">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
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
      hover
    >
      <template #item.active="{ item }">
        <v-chip :color="item.active ? 'success' : 'grey'" size="small">
          {{ item.active ? $t('common.active') : $t('common.inactive') }}
        </v-chip>
      </template>
      <template #item.role="{ item }">
        <v-chip :color="roleColor(item.role)" size="small" variant="outlined">{{ item.role }} <span class="text-grey ml-1">(Legacy)</span></v-chip>
      </template>
      <template #item.permissionSets="{ item }">
        <template v-if="item.permissionSetIds?.length">
          <v-chip
            v-for="setId in item.permissionSetIds"
            :key="setId"
            size="small"
            class="mr-1"
            variant="tonal"
          >{{ permissionSetName(setId) }}</v-chip>
        </template>
        <span v-else class="text-grey text-caption">{{ $t('common.none') }}</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
      </template>
    </v-data-table-server>

    <!-- Create/Edit User Dialog -->
    <v-dialog v-model="dialog" max-width="700" persistent scrollable>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('settings.user') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="4"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" /></v-col>
            <v-col cols="4"><v-text-field v-model="form.middleName" :label="$t('common.middleName')" /></v-col>
            <v-col cols="4"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" /></v-col>
          </v-row>
          <v-text-field v-model="form.email" :label="$t('common.email')" type="email" class="mb-2" />
          <v-text-field v-model="form.username" :label="$t('auth.username')" class="mb-2" />
          <v-text-field v-if="!editing" v-model="form.password" :label="$t('auth.password')" type="password" class="mb-2" />

          <v-select v-model="form.role" :label="$t('settings.role') + ' (Legacy)'" :items="roles" class="mb-2" disabled />

          <v-autocomplete
            v-model="form.permissionSetIds"
            :items="permissionSets"
            item-title="name"
            item-value="_id"
            :label="$t('permissionSets.title')"
            multiple
            chips
            closable-chips
            class="mb-2"
          />

          <!-- Effective Permissions (read-only) -->
          <div v-if="editing && form.permissionSetIds?.length" class="mb-4">
            <div class="text-subtitle-2 mb-1">{{ $t('permissionSets.effectivePermissions') }}</div>
            <v-chip
              v-for="perm in effectivePermissions"
              :key="perm"
              size="x-small"
              class="mr-1 mb-1"
              variant="outlined"
            >{{ perm }}</v-chip>
            <div v-if="!effectivePermissions.length" class="text-grey text-caption">{{ $t('common.loading') }}...</div>
          </div>

          <div class="text-subtitle-2 mb-2">{{ $t('settings.permissions') }} (Legacy)</div>
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
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

const { t } = useI18n()
const store = useSettingsStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/user`),
  entityKey: 'users',
})

const dialog = ref(false)
const inviteDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const inviting = ref(false)
const inviteEmail = ref('')
const inviteRole = ref('Viewer')

const permissionSets = ref<any[]>([])
const effectivePermissions = ref<string[]>([])

const roles = ['Admin', 'Manager', 'Accountant', 'HR', 'Sales', 'Viewer']
const availablePermissions = [
  'accounting.read', 'accounting.write',
  'trade.read', 'trade.write', 'trade.adjust', 'trade.send',
  'payroll.read', 'payroll.write',
  'hr.read', 'hr.write',
  'crm.read', 'crm.write',
  'erp.read', 'erp.write',
  'settings.read', 'settings.write',
  'admin.read', 'admin.write',
]

const headers = [
  { title: t('common.name'), key: 'fullName' },
  { title: t('common.email'), key: 'email' },
  { title: t('auth.username'), key: 'username' },
  { title: t('settings.role'), key: 'role' },
  { title: t('permissionSets.title'), key: 'permissionSets', sortable: false },
  { title: t('common.active'), key: 'active' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const emptyForm = () => ({
  _id: '', firstName: '', middleName: '', lastName: '', email: '', username: '',
  password: '', role: 'Viewer', permissions: [] as string[], permissionSetIds: [] as string[], active: true,
})

const form = reactive(emptyForm())

function permissionSetName(id: string): string {
  const found = permissionSets.value.find(s => s._id === id)
  return found?.name || id
}

async function fetchPermissionSets() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/permission-sets`)
    permissionSets.value = data.permissionSets || []
  } catch {
    // non-critical
  }
}

async function fetchEffectivePermissions(userId: string) {
  if (!userId) { effectivePermissions.value = []; return }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/permission-sets/effective/${userId}`)
    effectivePermissions.value = data.permissions || []
  } catch {
    effectivePermissions.value = []
  }
}

// Watch for permissionSetIds changes in the form to refresh effective permissions
watch(() => form.permissionSetIds, () => {
  if (editing.value && form._id) {
    // We re-fetch from server on the saved state; for UI preview we compute locally
    const selected = permissionSets.value.filter(s => form.permissionSetIds.includes(s._id))
    const perms = new Set<string>()
    for (const s of selected) {
      for (const p of (s.permissions || [])) perms.add(p)
    }
    effectivePermissions.value = [...perms].sort()
  }
}, { deep: true })

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, {
      ...item,
      permissions: [...(item.permissions || [])],
      permissionSetIds: [...(item.permissionSetIds || [])],
    })
    if (item._id) fetchEffectivePermissions(item._id)
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
    effectivePermissions.value = []
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    const payload: Record<string, any> = { ...form }
    if (editing.value) {
      delete payload.password
      await store.updateUser(form._id, payload)
    } else {
      await store.createUser(payload)
    }
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function sendInvite() {
  inviting.value = true
  try {
    await store.inviteUser(inviteEmail.value)
    showSuccess(t('common.savedSuccessfully'))
    inviteDialog.value = false
    inviteEmail.value = ''
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    inviting.value = false
  }
}

function roleColor(role: string) {
  const colors: Record<string, string> = { Admin: 'error', Manager: 'warning', Accountant: 'info', HR: 'purple', Sales: 'success', Viewer: 'grey' }
  return colors[role] || 'grey'
}

onMounted(() => {
  fetchPermissionSets()
})
</script>
