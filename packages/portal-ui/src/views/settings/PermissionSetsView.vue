<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('permissionSets.title') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <responsive-btn icon="mdi-swap-horizontal" variant="outlined" @click="migrateConfirmDialog = true">
          {{ $t('permissionSets.migrate') }}
        </responsive-btn>
        <responsive-btn icon="mdi-plus" color="primary" @click="openDialog()">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
    </div>

    <v-data-table
      :headers="headers"
      :items="items"
      :loading="loading"
      item-value="_id"
      hover
    >
      <template #item.name="{ item }">
        <span class="font-weight-medium">{{ item.name }}</span>
      </template>
      <template #item.badges="{ item }">
        <v-chip v-if="item.isAdmin" color="error" size="small" class="mr-1">{{ $t('permissionSets.isAdmin') }}</v-chip>
        <v-chip v-if="item.isDefault" color="info" size="small" class="mr-1">{{ $t('permissionSets.isDefault') }}</v-chip>
        <v-chip v-if="item.isSystem" color="grey" size="small" variant="outlined">{{ $t('permissionSets.isSystem') }}</v-chip>
      </template>
      <template #item.userCount="{ item }">
        <v-chip size="small" variant="text">{{ item.userCount }}</v-chip>
      </template>
      <template #item.permissions="{ item }">
        <span class="text-body-2 text-grey">{{ item.permissions?.length || 0 }} {{ $t('permissionSets.permissions').toLowerCase() }}</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
        <v-btn
          v-if="!item.isSystem"
          icon="mdi-delete"
          size="small"
          variant="text"
          color="error"
          @click="confirmDelete(item)"
        />
      </template>
    </v-data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="800" persistent scrollable>
      <v-card>
        <v-card-title>{{ editing ? $t('permissionSets.edit') : $t('permissionSets.create') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="form.name" :label="$t('permissionSets.name')" class="mb-2" />
          <v-text-field v-model="form.description" :label="$t('permissionSets.description')" class="mb-2" />

          <v-row class="mb-2">
            <v-col cols="6">
              <v-switch v-model="form.isAdmin" :label="$t('permissionSets.isAdmin')" color="error" density="compact" hide-details />
            </v-col>
            <v-col cols="6">
              <v-switch v-model="form.isDefault" :label="$t('permissionSets.isDefault')" color="info" density="compact" hide-details />
            </v-col>
          </v-row>

          <div class="text-subtitle-1 font-weight-bold mb-2">{{ $t('permissionSets.permissions') }}</div>
          <v-row>
            <v-col v-for="group in permissionGroups" :key="group.module" cols="12" sm="6" md="4">
              <v-card variant="outlined" class="pa-3 mb-2">
                <div class="text-subtitle-2 font-weight-bold text-capitalize mb-1">{{ group.module }}</div>
                <v-checkbox
                  v-for="perm in group.permissions"
                  :key="perm"
                  v-model="form.permissions"
                  :value="perm"
                  :label="perm.split('.')[1]"
                  density="compact"
                  hide-details
                />
              </v-card>
            </v-col>
          </v-row>

          <div class="text-subtitle-1 font-weight-bold mt-4 mb-2">{{ $t('permissionSets.recordScoping') }}</div>
          <v-row>
            <v-col v-for="mod in ownRecordsModules" :key="mod" cols="6" sm="4" md="3">
              <v-checkbox
                v-model="ownRecordsSelected"
                :value="mod"
                :label="mod"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>
          <div class="text-caption text-grey mt-1">{{ $t('permissionSets.ownOnly') }}: {{ ownRecordsSelected.length > 0 ? ownRecordsSelected.join(', ') : $t('permissionSets.allRecords') }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('permissionSets.delete') }}</v-card-title>
        <v-card-text>{{ $t('permissionSets.deleteConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="deleting" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Migrate Confirmation -->
    <v-dialog v-model="migrateConfirmDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('permissionSets.migrate') }}</v-card-title>
        <v-card-text>{{ $t('permissionSets.migrateConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="migrateConfirmDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="migrating" @click="doMigrate">{{ $t('common.confirm') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { useDialogPendingChanges } from 'ui-shared/composables/useDialogPendingChanges'
import { PERMISSIONS } from 'config/constants'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const items = ref<any[]>([])
const loading = ref(false)
const dialog = ref(false)
const deleteDialog = ref(false)
const migrateConfirmDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const deleting = ref(false)
const migrating = ref(false)
const deleteTarget = ref<any>(null)

const ownRecordsModules = ['sales', 'purchase', 'project', 'helpdesk', 'crm', 'payroll', 'hr', 'documents', 'subscriptions', 'planning', 'fleet', 'erp']
const ownRecordsSelected = ref<string[]>([])

const headers = [
  { title: t('permissionSets.name'), key: 'name' },
  { title: t('permissionSets.description'), key: 'description' },
  { title: '', key: 'badges', sortable: false },
  { title: t('permissionSets.userCount'), key: 'userCount', align: 'center' as const },
  { title: t('permissionSets.permissions'), key: 'permissions', sortable: false },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

// Group permissions by module
const permissionGroups = computed(() => {
  const groups: Record<string, string[]> = {}
  for (const p of PERMISSIONS) {
    const mod = p.split('.')[0]
    if (!groups[mod]) groups[mod] = []
    groups[mod].push(p)
  }
  return Object.entries(groups).map(([module, permissions]) => ({ module, permissions }))
})

const emptyForm = () => ({
  _id: '',
  name: '',
  description: '',
  permissions: [] as string[],
  isDefault: false,
  isAdmin: false,
})

const form = reactive(emptyForm())

const { markSaved } = useDialogPendingChanges({
  appId: 'portal',
  entityType: 'permissionSet',
  dialogId: 'portal-permission-sets',
  icon: 'mdi-shield-key',
  dialogVisible: dialog,
  getFormData: () => ({ ...form }),
  getPreviewFields: () => [
    { label: 'Name', value: form.name || '' },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => editing.value,
  entityId: () => form._id,
})

async function fetchItems() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/permission-sets`)
    items.value = data.permissionSets || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, {
      _id: item._id,
      name: item.name,
      description: item.description || '',
      permissions: [...(item.permissions || [])],
      isDefault: item.isDefault || false,
      isAdmin: item.isAdmin || false,
    })
    // Parse ownRecordsOnly
    ownRecordsSelected.value = Object.entries(item.ownRecordsOnly || {})
      .filter(([, v]) => v === true)
      .map(([k]) => k)
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
    ownRecordsSelected.value = []
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    const ownRecordsOnly: Record<string, boolean> = {}
    for (const mod of ownRecordsModules) {
      ownRecordsOnly[mod] = ownRecordsSelected.value.includes(mod)
    }
    const payload = {
      name: form.name,
      description: form.description,
      permissions: form.permissions,
      ownRecordsOnly,
      isDefault: form.isDefault,
      isAdmin: form.isAdmin,
    }

    if (editing.value) {
      await httpClient.put(`${appStore.orgUrl()}/permission-sets/${form._id}`, payload)
    } else {
      await httpClient.post(`${appStore.orgUrl()}/permission-sets`, payload)
    }
    showSuccess(t('common.savedSuccessfully'))
    markSaved()
    dialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function confirmDelete(item: any) {
  if (item.isSystem) {
    showError(t('permissionSets.cannotDeleteSystem'))
    return
  }
  deleteTarget.value = item
  deleteDialog.value = true
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await httpClient.delete(`${appStore.orgUrl()}/permission-sets/${deleteTarget.value._id}`)
    showSuccess(t('common.deletedSuccessfully'))
    deleteDialog.value = false
    deleteTarget.value = null
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    deleting.value = false
  }
}

async function doMigrate() {
  migrating.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/permission-sets/migrate`)
    showSuccess(t('permissionSets.migrated'))
    migrateConfirmDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    migrating.value = false
  }
}

onMounted(fetchItems)
</script>
