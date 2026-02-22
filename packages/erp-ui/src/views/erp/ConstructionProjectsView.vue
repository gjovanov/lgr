<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('erp.constructionProjects') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="5">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="projectStatuses" clearable hide-details />
          </v-col>
        </v-row>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="store.loading" item-value="_id">
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.budget="{ item }">{{ formatCurrency(item.budget, item.currency || currency, localeCode) }}</template>
          <template #item.spent="{ item }">
            <span :class="item.spent > item.budget ? 'text-error' : ''">{{ formatCurrency(item.spent, item.currency || currency, localeCode) }}</span>
          </template>
          <template #item.progress="{ item }">
            <v-progress-linear :model-value="item.progress" :color="item.progress >= 100 ? 'success' : 'primary'" height="20" rounded>
              <template #default>{{ item.progress }}%</template>
            </v-progress-linear>
          </template>
          <template #item.startDate="{ item }">{{ item.startDate?.split('T')[0] }}</template>
          <template #item.endDate="{ item }">{{ item.endDate?.split('T')[0] || '-' }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="8">
                <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.code" :label="t('erp.projectCode')" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.clientName" :label="t('erp.client')" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="form.status" :label="t('common.status')" :items="projectStatuses" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.startDate" :label="t('common.dateFrom')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.endDate" :label="t('common.dateTo')" type="date" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model.number="form.progress" :label="t('erp.progress')" type="number" suffix="%" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model.number="form.budget" :label="t('erp.budget')" type="number" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model.number="form.spent" :label="t('erp.spent')" type="number" />
              </v-col>
            </v-row>
            <v-textarea v-model="form.description" :label="t('common.description')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
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
import { useERPStore, type ConstructionProject } from '../../store/erp.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'

const { t } = useI18n()
const appStore = useAppStore()
const store = useERPStore()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const statusFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const projectStatuses = ['planning', 'active', 'on_hold', 'completed', 'cancelled']

const emptyForm = () => ({ name: '', code: '', clientName: '', status: 'planning', startDate: '', endDate: '', budget: 0, spent: 0, progress: 0, description: '' })
const form = ref(emptyForm())

const headers = [
  { title: t('erp.projectCode'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('erp.client'), key: 'clientName' },
  { title: t('common.status'), key: 'status' },
  { title: t('erp.progress'), key: 'progress', width: '150px' },
  { title: t('erp.budget'), key: 'budget', align: 'end' as const },
  { title: t('erp.spent'), key: 'spent', align: 'end' as const },
  { title: t('common.dateFrom'), key: 'startDate' },
  { title: t('common.dateTo'), key: 'endDate' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filteredItems = computed(() => {
  let r = store.constructionProjects
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function statusColor(s: string) {
  return ({ planning: 'info', active: 'success', on_hold: 'warning', completed: 'primary', cancelled: 'error' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: ConstructionProject) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    name: item.name, code: item.code, clientName: item.clientName || '',
    status: item.status, startDate: item.startDate?.split('T')[0] || '', endDate: item.endDate?.split('T')[0] || '',
    budget: item.budget, spent: item.spent, progress: item.progress, description: item.description || '',
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateConstructionProject(selectedId.value, form.value as unknown as Partial<ConstructionProject>)
  } else {
    await store.createConstructionProject(form.value as unknown as Partial<ConstructionProject>)
  }
  dialog.value = false
}

function confirmDelete(item: ConstructionProject) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteConstructionProject(selectedId.value); deleteDialog.value = false }

onMounted(() => { store.fetchConstructionProjects() })
</script>
