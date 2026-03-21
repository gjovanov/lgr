<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.push({ name: 'project.projects' })" />
      <h1 class="text-h5 ml-2">{{ project?.name || '' }}</h1>
      <v-chip v-if="project" class="ml-2" size="small" :color="stateColor(project.state)">{{ project.state }}</v-chip>
      <v-spacer />
      <v-btn icon="mdi-pencil" variant="text" :to="{ name: 'project.projects.edit', params: { id: projectId } }" />
    </div>

    <v-tabs v-model="activeTab" class="mb-4">
      <v-tab value="overview">{{ t('project.overview') }}</v-tab>
      <v-tab value="tasks">{{ t('project.tasks') }}</v-tab>
      <v-tab value="milestones">{{ t('project.milestones') }}</v-tab>
      <v-tab value="timesheets">{{ t('project.timesheets') }}</v-tab>
    </v-tabs>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'">
      <v-row>
        <v-col cols="12" md="3">
          <v-card>
            <v-card-text class="text-center">
              <div class="text-caption text-medium-emphasis">{{ t('project.budgetPlanned') }}</div>
              <div class="text-h6">{{ fmtCurrency(project?.budgetPlanned || 0) }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="3">
          <v-card>
            <v-card-text class="text-center">
              <div class="text-caption text-medium-emphasis">{{ t('project.budgetSpent') }}</div>
              <div class="text-h6">{{ fmtCurrency(project?.budgetSpent || 0) }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="3">
          <v-card>
            <v-card-text class="text-center">
              <div class="text-caption text-medium-emphasis">{{ t('project.revenueExpected') }}</div>
              <div class="text-h6">{{ fmtCurrency(project?.revenueExpected || 0) }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="3">
          <v-card>
            <v-card-text class="text-center">
              <div class="text-caption text-medium-emphasis">{{ t('project.revenueInvoiced') }}</div>
              <div class="text-h6">{{ fmtCurrency(project?.revenueInvoiced || 0) }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row class="mt-4">
        <v-col cols="12" md="6">
          <v-card>
            <v-card-title>{{ t('project.details') }}</v-card-title>
            <v-card-text>
              <v-list density="compact">
                <v-list-item>
                  <template #prepend><v-icon>mdi-account-tie</v-icon></template>
                  <v-list-item-title>{{ t('project.manager') }}</v-list-item-title>
                  <v-list-item-subtitle>{{ project?.manager ? `${project.manager.firstName} ${project.manager.lastName}` : '-' }}</v-list-item-subtitle>
                </v-list-item>
                <v-list-item>
                  <template #prepend><v-icon>mdi-domain</v-icon></template>
                  <v-list-item-title>{{ t('project.partner') }}</v-list-item-title>
                  <v-list-item-subtitle>{{ project?.partner?.companyName || '-' }}</v-list-item-subtitle>
                </v-list-item>
                <v-list-item>
                  <template #prepend><v-icon>mdi-calendar</v-icon></template>
                  <v-list-item-title>{{ t('project.dates') }}</v-list-item-title>
                  <v-list-item-subtitle>{{ project?.dateStart?.split('T')[0] || '-' }} — {{ project?.dateEnd?.split('T')[0] || '-' }}</v-list-item-subtitle>
                </v-list-item>
                <v-list-item v-if="project?.description">
                  <template #prepend><v-icon>mdi-text</v-icon></template>
                  <v-list-item-title>{{ t('common.description') }}</v-list-item-title>
                  <v-list-item-subtitle>{{ project.description }}</v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card>
            <v-card-title>{{ t('project.profitability') }}</v-card-title>
            <v-card-text>
              <div v-if="profitability">
                <v-list density="compact">
                  <v-list-item>
                    <v-list-item-title>{{ t('project.timesheetHours') }}</v-list-item-title>
                    <v-list-item-subtitle>{{ profitability.timesheetHours }}h</v-list-item-subtitle>
                  </v-list-item>
                  <v-list-item>
                    <v-list-item-title>{{ t('project.timesheetCost') }}</v-list-item-title>
                    <v-list-item-subtitle>{{ fmtCurrency(profitability.timesheetCost) }}</v-list-item-subtitle>
                  </v-list-item>
                  <v-list-item>
                    <v-list-item-title>{{ t('project.margin') }}</v-list-item-title>
                    <v-list-item-subtitle>
                      {{ fmtCurrency(profitability.margin) }}
                      <v-chip size="x-small" :color="profitability.margin >= 0 ? 'success' : 'error'" class="ml-1">
                        {{ profitability.marginPercent?.toFixed(1) }}%
                      </v-chip>
                    </v-list-item-subtitle>
                  </v-list-item>
                </v-list>
              </div>
              <div v-else class="text-center text-caption text-disabled pa-4">{{ t('common.noData') }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </div>

    <!-- Tasks Tab -->
    <tasks-view v-if="activeTab === 'tasks'" :project-id="projectId" :stages="project?.stages || []" embedded />

    <!-- Milestones Tab -->
    <div v-if="activeTab === 'milestones'">
      <div class="d-flex justify-end mb-2">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openMilestoneCreate">{{ t('common.create') }}</v-btn>
      </div>
      <v-card>
        <v-card-text>
          <v-list v-if="store.milestones.length > 0">
            <v-list-item v-for="ms in store.milestones" :key="ms._id || ms.id">
              <template #prepend>
                <v-icon :color="ms.isReached ? 'success' : 'grey'">
                  {{ ms.isReached ? 'mdi-flag-checkered' : 'mdi-flag-outline' }}
                </v-icon>
              </template>
              <v-list-item-title>{{ ms.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ t('project.deadline') }}: {{ ms.deadline?.split('T')[0] }}</v-list-item-subtitle>
              <template #append>
                <v-btn v-if="!ms.isReached" size="small" color="success" variant="tonal" @click="doReachMilestone(ms)">
                  {{ t('project.reach') }}
                </v-btn>
                <v-btn icon="mdi-pencil" size="small" variant="text" class="ml-1" @click="openMilestoneEdit(ms)" />
                <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="doDeleteMilestone(ms)" />
              </template>
            </v-list-item>
          </v-list>
          <div v-else class="text-center text-caption text-disabled pa-8">{{ t('common.noData') }}</div>
        </v-card-text>
      </v-card>

      <!-- Milestone Dialog -->
      <v-dialog v-model="msDialog" max-width="500">
        <v-card>
          <v-card-title>{{ msEditing ? t('common.edit') : t('common.create') }}</v-card-title>
          <v-card-text>
            <v-form ref="msFormRef">
              <v-text-field v-model="msForm.name" :label="t('common.name')" :rules="[rules.required]" />
              <v-text-field v-model="msForm.deadline" :label="t('project.deadline')" type="date" :rules="[rules.required]" />
            </v-form>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="msDialog = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="primary" :loading="store.loading" @click="saveMilestone">{{ t('common.save') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </div>

    <!-- Timesheets Tab -->
    <div v-if="activeTab === 'timesheets'">
      <timesheets-view :project-id="projectId" embedded />
    </div>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useProjectStore, type Milestone, type Profitability } from '../../store/project.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TasksView from './TasksView.vue'
import TimesheetsView from './TimesheetsView.vue'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const projectId = computed(() => route.params.id as string)
const project = ref<any>(null)
const profitability = ref<Profitability | null>(null)
const activeTab = ref('overview')

// Milestone dialog
const msDialog = ref(false)
const msEditing = ref(false)
const msFormRef = ref()
const msSelectedId = ref('')
const msForm = ref({ name: '', deadline: '' })

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

function stateColor(state: string) {
  return ({ in_progress: 'primary', done: 'success', cancelled: 'error', on_hold: 'warning' }[state] || 'grey')
}

function openMilestoneCreate() {
  msEditing.value = false
  msForm.value = { name: '', deadline: '' }
  msDialog.value = true
}

function openMilestoneEdit(ms: Milestone) {
  msEditing.value = true
  msSelectedId.value = ms._id || ms.id
  msForm.value = { name: ms.name, deadline: ms.deadline?.split('T')[0] || '' }
  msDialog.value = true
}

async function saveMilestone() {
  const { valid } = await msFormRef.value.validate()
  if (!valid) return
  try {
    if (msEditing.value) {
      await store.updateMilestone(msSelectedId.value, msForm.value)
    } else {
      await store.createMilestone({ projectId: projectId.value, ...msForm.value })
    }
    msDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doReachMilestone(ms: Milestone) {
  try {
    await store.reachMilestone(ms._id || ms.id)
    showSuccess(t('project.milestoneReached'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doDeleteMilestone(ms: Milestone) {
  try {
    await store.deleteMilestone(ms._id || ms.id)
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  try {
    project.value = await store.fetchProject(projectId.value)
    await store.fetchMilestones(projectId.value)
    store.fetchProfitability(projectId.value).then(p => { profitability.value = p }).catch(() => {})
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
})
</script>
