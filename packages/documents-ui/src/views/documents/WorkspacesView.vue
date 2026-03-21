<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('documents.workspaces') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-row>
      <v-col v-for="ws in filteredWorkspaces" :key="ws._id" cols="12" sm="6" md="4" lg="3">
        <v-card hover :to="{ name: 'documents.files', params: { workspaceId: ws._id } }">
          <v-card-item>
            <template #prepend>
              <v-avatar :color="ws.color || 'primary'" size="48">
                <v-icon color="white">mdi-folder</v-icon>
              </v-avatar>
            </template>
            <v-card-title>{{ ws.name }}</v-card-title>
            <v-card-subtitle v-if="ws.description">{{ ws.description }}</v-card-subtitle>
          </v-card-item>
          <v-card-actions>
            <v-chip size="small" :color="ws.isActive ? 'success' : 'grey'">
              {{ ws.isActive ? $t('common.active') : $t('common.inactive') }}
            </v-chip>
            <v-spacer />
            <v-btn icon="mdi-pencil" size="small" variant="text" @click.prevent="openEdit(ws)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.prevent="confirmDelete(ws)" />
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-alert v-if="!loading && filteredWorkspaces.length === 0" type="info" class="mt-4">
      {{ $t('documents.noWorkspaces') }}
    </v-alert>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="500">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[v => !!v || $t('required')]" />
            <v-textarea v-model="form.description" :label="$t('common.description')" rows="2" />
            <v-text-field v-model="form.color" :label="$t('documents.color')" placeholder="#1976D2" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('documents.deleteWorkspaceConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useDocumentsStore, type Workspace } from '../../store/documents.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useDocumentsStore()
const { showSuccess, showError } = useSnackbar()

const search = ref('')
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const editId = ref('')
const formRef = ref()
const loading = computed(() => store.loading)

const form = ref({ name: '', description: '', color: '' })

const filteredWorkspaces = computed(() => {
  if (!search.value) return store.workspaces
  const q = search.value.toLowerCase()
  return store.workspaces.filter(w =>
    w.name.toLowerCase().includes(q) || w.description?.toLowerCase().includes(q)
  )
})

function openCreate() {
  editing.value = false
  editId.value = ''
  form.value = { name: '', description: '', color: '' }
  dialog.value = true
}

function openEdit(ws: Workspace) {
  editing.value = true
  editId.value = ws._id
  form.value = { name: ws.name, description: ws.description || '', color: ws.color || '' }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload: any = { name: form.value.name }
    if (form.value.description) payload.description = form.value.description
    if (form.value.color) payload.color = form.value.color

    if (editing.value) {
      await store.updateWorkspace(editId.value, payload)
      showSuccess(t('common.savedSuccessfully'))
    } else {
      await store.createWorkspace(payload)
      showSuccess(t('common.createdSuccessfully'))
    }
    dialog.value = false
    await store.fetchWorkspaces({ size: 100 })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(ws: Workspace) {
  editId.value = ws._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteWorkspace(editId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  store.fetchWorkspaces({ size: 100 })
})
</script>
