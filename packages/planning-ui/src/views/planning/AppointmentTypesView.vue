<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('planning.appointmentTypes') }}</h1>
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
          <template #item.duration="{ item }">{{ item.duration }} {{ $t('planning.minutes') }}</template>
          <template #item.location="{ item }">
            <v-chip size="small" :color="item.location === 'online' ? 'blue' : item.location === 'phone' ? 'orange' : 'green'">{{ item.location }}</v-chip>
          </template>
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
            <v-row>
              <v-col cols="6">
                <v-text-field v-model.number="form.duration" :label="$t('planning.durationMinutes')" type="number" :rules="[v => v > 0 || $t('required')]" />
              </v-col>
              <v-col cols="6">
                <v-select v-model="form.location" :label="$t('planning.location')" :items="locationOptions" :rules="[v => !!v || $t('required')]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="6">
                <v-switch v-model="form.isPublic" :label="$t('planning.isPublic')" color="primary" />
              </v-col>
              <v-col cols="6">
                <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />
              </v-col>
            </v-row>

            <!-- Custom Questions -->
            <div class="d-flex align-center mt-2 mb-2">
              <span class="text-subtitle-1 font-weight-medium">{{ $t('planning.questions') }}</span>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addQuestion">{{ $t('common.add') }}</v-btn>
            </div>
            <v-card v-for="(q, idx) in form.customQuestions" :key="idx" variant="outlined" class="mb-2 pa-3">
              <v-row dense>
                <v-col cols="5">
                  <v-text-field v-model="q.label" :label="$t('planning.questionLabel')" density="compact" :rules="[v => !!v || $t('required')]" />
                </v-col>
                <v-col cols="3">
                  <v-select v-model="q.type" :label="$t('common.type')" :items="['text', 'select', 'textarea']" density="compact" :rules="[v => !!v || $t('required')]" />
                </v-col>
                <v-col cols="2">
                  <v-checkbox v-model="q.required" :label="$t('planning.questionRequired')" density="compact" />
                </v-col>
                <v-col cols="2" class="d-flex align-center justify-center">
                  <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="form.customQuestions.splice(idx, 1)" />
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
        <v-card-text>{{ $t('planning.deleteTypeConfirm') }}</v-card-text>
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
import { usePlanningStore, type AppointmentType } from '../../store/planning.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = usePlanningStore()
const { showSuccess, showError } = useSnackbar()

const locationOptions = ['online', 'in_person', 'phone']
const items = ref<AppointmentType[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const editId = ref('')
const formRef = ref()

const form = ref({
  name: '',
  duration: 30,
  location: 'online',
  isPublic: false,
  isActive: true,
  customQuestions: [] as { label: string; type: string; required: boolean }[],
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('planning.duration'), key: 'duration', sortable: true },
  { title: t('planning.location'), key: 'location' },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  const data = await store.fetchAppointmentTypes(params)
  items.value = store.appointmentTypes
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
  form.value = { name: '', duration: 30, location: 'online', isPublic: false, isActive: true, customQuestions: [] }
  dialog.value = true
}

function openEdit(item: AppointmentType) {
  editing.value = true
  editId.value = item._id
  form.value = {
    name: item.name,
    duration: item.duration,
    location: item.location,
    isPublic: item.isPublic,
    isActive: item.isActive,
    customQuestions: (item.customQuestions || []).map(q => ({
      label: q.label,
      type: q.type,
      required: q.required || false,
    })),
  }
  dialog.value = true
}

function addQuestion() {
  form.value.customQuestions.push({ label: '', type: 'text', required: false })
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (editing.value) {
      await store.updateAppointmentType(editId.value, form.value as any)
      showSuccess(t('common.savedSuccessfully'))
    } else {
      await store.createAppointmentType(form.value as any)
      showSuccess(t('common.createdSuccessfully'))
    }
    dialog.value = false
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: AppointmentType) {
  editId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteAppointmentType(editId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
