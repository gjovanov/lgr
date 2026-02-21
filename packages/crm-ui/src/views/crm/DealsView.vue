<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('crm.deals') }}</h1>
      <div>
        <v-btn-toggle v-model="viewMode" mandatory density="compact" class="mr-4">
          <v-btn value="table" icon="mdi-table" />
          <v-btn value="board" icon="mdi-view-column" />
        </v-btn-toggle>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
      </div>
    </div>

    <!-- Pipeline Selector -->
    <v-card class="mb-4" v-if="store.pipelines.length > 0">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="4">
            <v-select v-model="selectedPipeline" :label="t('crm.pipeline')" :items="store.pipelines" item-title="name" item-value="_id" hide-details />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="dealStatuses" clearable hide-details />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Table View -->
    <v-card v-if="viewMode === 'table'">
      <v-card-text>
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable class="mb-4" />
        <v-data-table :headers="headers" :items="filteredDeals" :search="search" :loading="store.loading" item-value="_id">
          <template #item.value="{ item }">{{ formatCurrency(item.value, item.currency || currency, localeCode) }}</template>
          <template #item.probability="{ item }">{{ item.probability }}%</template>
          <template #item.status="{ item }">
            <v-chip size="small" :color="dealStatusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.expectedCloseDate="{ item }">{{ item.expectedCloseDate?.split('T')[0] }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Kanban Board View -->
    <div v-else class="d-flex overflow-x-auto" style="gap: 16px;">
      <div v-for="stage in currentStages" :key="stage._id" style="min-width: 280px; max-width: 320px; flex: 1;">
        <v-card class="h-100">
          <v-card-title class="text-subtitle-1 d-flex justify-space-between align-center">
            <span>{{ stage.name }}</span>
            <v-chip size="small">{{ dealsForStage(stage._id).length }}</v-chip>
          </v-card-title>
          <v-card-text style="max-height: 60vh; overflow-y: auto;">
            <v-card
              v-for="deal in dealsForStage(stage._id)"
              :key="deal._id"
              class="mb-2 pa-3"
              variant="outlined"
              @click="openEdit(deal)"
            >
              <div class="text-subtitle-2">{{ deal.name }}</div>
              <div class="text-caption text-medium-emphasis">{{ deal.contactName }}</div>
              <div class="d-flex justify-space-between align-center mt-1">
                <span class="text-body-2 font-weight-bold">{{ formatCurrency(deal.value, deal.currency || currency, localeCode) }}</span>
                <v-chip size="x-small" :color="deal.probability >= 50 ? 'success' : 'warning'">{{ deal.probability }}%</v-chip>
              </div>
            </v-card>
            <div v-if="dealsForStage(stage._id).length === 0" class="text-center text-caption text-disabled pa-4">
              {{ t('common.noData') }}
            </div>
          </v-card-text>
        </v-card>
      </div>
    </div>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            <v-text-field v-model="form.contactName" :label="t('crm.contact')" />
            <v-select v-model="form.stageId" :label="t('crm.stage')" :items="currentStages" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-text-field v-model.number="form.value" :label="t('crm.dealValue')" type="number" :rules="[rules.required]" />
            <v-text-field v-model.number="form.probability" :label="t('crm.probability')" type="number" suffix="%" />
            <v-text-field v-model="form.expectedCloseDate" :label="t('crm.expectedClose')" type="date" />
            <v-select v-model="form.status" :label="t('common.status')" :items="dealStatuses" :rules="[rules.required]" />
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useCRMStore, type Deal } from '../../store/crm.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'

const { t } = useI18n()
const appStore = useAppStore()
const store = useCRMStore()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const viewMode = ref<'table' | 'board'>('board')
const search = ref('')
const selectedPipeline = ref('')
const statusFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const dealStatuses = ['open', 'won', 'lost']

const emptyForm = () => ({ name: '', contactName: '', stageId: '', value: 0, probability: 50, expectedCloseDate: '', status: 'open' })
const form = ref(emptyForm())

const headers = [
  { title: t('common.name'), key: 'name' },
  { title: t('crm.contact'), key: 'contactName' },
  { title: t('crm.stage'), key: 'stageName' },
  { title: t('crm.dealValue'), key: 'value', align: 'end' as const },
  { title: t('crm.probability'), key: 'probability', align: 'end' as const },
  { title: t('crm.expectedClose'), key: 'expectedCloseDate' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const currentStages = computed(() => {
  const pipeline = store.pipelines.find(p => p._id === selectedPipeline.value)
  return pipeline?.stages?.sort((a, b) => a.order - b.order) || []
})

const filteredDeals = computed(() => {
  let r = store.deals
  if (selectedPipeline.value) r = r.filter(d => d.pipelineId === selectedPipeline.value)
  if (statusFilter.value) r = r.filter(d => d.status === statusFilter.value)
  return r
})

function dealsForStage(stageId: string) {
  return filteredDeals.value.filter(d => d.stageId === stageId)
}

function dealStatusColor(s: string) {
  return ({ open: 'primary', won: 'success', lost: 'error' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: Deal) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    name: item.name, contactName: item.contactName || '', stageId: item.stageId,
    value: item.value, probability: item.probability,
    expectedCloseDate: item.expectedCloseDate?.split('T')[0] || '', status: item.status,
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  const payload = { ...form.value, pipelineId: selectedPipeline.value }
  if (editing.value) {
    await store.updateDeal(selectedId.value, payload)
  } else {
    await store.createDeal(payload)
  }
  dialog.value = false
}

function confirmDelete(item: Deal) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteDeal(selectedId.value); deleteDialog.value = false }

onMounted(async () => {
  await store.fetchPipelines()
  if (store.pipelines.length > 0) {
    const defaultPipeline = store.pipelines.find(p => p.isDefault) || store.pipelines[0]
    selectedPipeline.value = defaultPipeline._id
  }
  await store.fetchDeals()
})
</script>
