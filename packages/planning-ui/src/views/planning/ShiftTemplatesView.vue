<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('planning.templates') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="total"
          :loading="store.loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.entries="{ item }">{{ (item.entries || []).length }}</template>
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

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[v => !!v || $t('required')]" />
            <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />

            <div class="d-flex align-center mt-2 mb-2">
              <span class="text-subtitle-1 font-weight-medium">{{ $t('planning.entries') }}</span>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addEntry">{{ $t('common.add') }}</v-btn>
            </div>
            <v-card v-for="(entry, idx) in form.entries" :key="idx" variant="outlined" class="mb-2 pa-3">
              <v-row dense>
                <v-col cols="3">
                  <v-select v-model="entry.dayOfWeek" :label="$t('planning.dayOfWeek')" :items="dayOptions" density="compact" :rules="[v => v !== null && v !== undefined || $t('required')]" />
                </v-col>
                <v-col cols="3">
                  <v-text-field v-model="entry.startTime" :label="$t('planning.startTime')" type="time" density="compact" :rules="[v => !!v || $t('required')]" />
                </v-col>
                <v-col cols="3">
                  <v-text-field v-model="entry.endTime" :label="$t('planning.endTime')" type="time" density="compact" :rules="[v => !!v || $t('required')]" />
                </v-col>
                <v-col cols="3" class="d-flex align-center justify-center">
                  <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="form.entries.splice(idx, 1)" />
                </v-col>
              </v-row>
            </v-card>
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
        <v-card-text>{{ $t('planning.deleteTemplateConfirm') }}</v-card-text>
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
import { useI18n } from 'vue-i18n'
import { usePlanningStore, type ShiftTemplate, type ShiftTemplateEntry } from '../../store/planning.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = usePlanningStore()
const { showSuccess, showError } = useSnackbar()

const items = ref<ShiftTemplate[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const editId = ref('')
const formRef = ref()

const dayOptions = [
  { title: 'Sunday', value: 0 },
  { title: 'Monday', value: 1 },
  { title: 'Tuesday', value: 2 },
  { title: 'Wednesday', value: 3 },
  { title: 'Thursday', value: 4 },
  { title: 'Friday', value: 5 },
  { title: 'Saturday', value: 6 },
]

const form = ref({
  name: '',
  isActive: true,
  entries: [] as { dayOfWeek: number; startTime: string; endTime: string }[],
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('planning.entryCount'), key: 'entries', align: 'center' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  const data = await store.fetchShiftTemplates(params)
  items.value = store.shiftTemplates
  total.value = data?.total || 0
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchData()
}

function openCreate() {
  editing.value = false
  editId.value = ''
  form.value = { name: '', isActive: true, entries: [] }
  dialog.value = true
}

function openEdit(item: ShiftTemplate) {
  editing.value = true
  editId.value = item._id
  form.value = {
    name: item.name,
    isActive: item.isActive,
    entries: (item.entries || []).map((e: ShiftTemplateEntry) => ({
      dayOfWeek: e.dayOfWeek,
      startTime: e.startTime,
      endTime: e.endTime,
    })),
  }
  dialog.value = true
}

function addEntry() {
  form.value.entries.push({ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' })
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (editing.value) {
      await store.updateShiftTemplate(editId.value, form.value as any)
      showSuccess(t('common.savedSuccessfully'))
    } else {
      await store.createShiftTemplate(form.value as any)
      showSuccess(t('common.createdSuccessfully'))
    }
    dialog.value = false
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: ShiftTemplate) {
  editId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteShiftTemplate(editId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
