<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.back()" />
      <h1 class="text-h5 ml-2">{{ isEdit ? t('project.editTask') : t('project.newTask') }}</h1>
      <v-spacer />
      <!-- Transition Buttons -->
      <div v-if="isEdit && task" class="d-flex ga-2">
        <v-btn v-if="task.state === 'open'" color="primary" variant="tonal" @click="transition('in_progress')">
          <v-icon start>mdi-play</v-icon>{{ t('project.start') }}
        </v-btn>
        <v-btn v-if="task.state === 'in_progress'" color="success" variant="tonal" @click="transition('done')">
          <v-icon start>mdi-check</v-icon>{{ t('project.complete') }}
        </v-btn>
        <v-btn v-if="task.state === 'in_progress' || task.state === 'open'" color="error" variant="tonal" @click="transition('cancelled')">
          <v-icon start>mdi-close</v-icon>{{ t('common.cancel') }}
        </v-btn>
        <v-btn v-if="task.state === 'done' || task.state === 'cancelled'" color="info" variant="tonal" @click="transition('open')">
          <v-icon start>mdi-refresh</v-icon>{{ t('project.reopen') }}
        </v-btn>
      </div>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12" md="8">
              <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.stageName" :label="t('project.stage')" :items="stageNames" />
            </v-col>
            <v-col cols="12">
              <v-textarea v-model="form.description" :label="t('common.description')" rows="3" auto-grow />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.priority" :label="t('project.priority')" :items="priorities" />
            </v-col>
            <v-col cols="12" md="8">
              <v-autocomplete
                v-model="form.assigneeIds"
                :label="t('project.assignees')"
                :items="users"
                :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
                item-value="_id"
                multiple
                chips
                closable-chips
                clearable
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.dateDeadline" :label="t('project.deadline')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.dateStart" :label="t('project.startDate')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.dateEnd" :label="t('project.endDate')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model.number="form.plannedHours" :label="t('project.plannedHours')" type="number" />
            </v-col>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="form.milestoneId"
                :label="t('project.milestone')"
                :items="milestones"
                item-title="name"
                :item-value="(m: any) => m._id || m.id"
                clearable
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="form.parentTaskId"
                :label="t('project.parentTask')"
                :items="otherTasks"
                item-title="name"
                :item-value="(t: any) => t._id || t.id"
                clearable
              />
            </v-col>
            <v-col cols="12">
              <TagInput v-model="form.tags" type="task" :org-url="appStore.orgUrl()" />
            </v-col>
          </v-row>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="$router.back()">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useProjectStore } from '../../store/project.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const isEdit = computed(() => !!route.params.id)
const projectId = computed(() => route.params.projectId as string)
const task = ref<any>(null)
const users = ref<any[]>([])
const milestones = ref<any[]>([])
const otherTasks = ref<any[]>([])
const project = ref<any>(null)

const priorities = ['low', 'normal', 'high', 'urgent']
const stageNames = computed(() => {
  if (project.value?.stages) return project.value.stages.map((s: any) => s.name)
  return ['New', 'In Progress', 'Done']
})

const emptyForm = () => ({
  name: '',
  description: '',
  stageName: '',
  priority: 'normal',
  assigneeIds: [] as string[],
  parentTaskId: '',
  dependencyIds: [] as string[],
  dateDeadline: '',
  dateStart: '',
  dateEnd: '',
  plannedHours: 0,
  milestoneId: '',
  tags: [] as string[],
})
const form = ref(emptyForm())

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

async function fetchLookups() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const [usersRes, projectRes, milestonesRes, tasksRes] = await Promise.all([
      httpClient.get(`${portalBase}/org/${appStore.currentOrg?.id}/users`),
      store.fetchProject(projectId.value),
      httpClient.get(`${appStore.orgUrl()}/project/milestones`, { params: { projectId: projectId.value } }),
      httpClient.get(`${appStore.orgUrl()}/project/tasks`, { params: { projectId: projectId.value, size: 100 } }),
    ])
    users.value = usersRes.data.users || usersRes.data || []
    project.value = projectRes
    milestones.value = milestonesRes.data.milestones || []
    otherTasks.value = (tasksRes.data.tasks || []).filter((t: any) => (t._id || t.id) !== route.params.id)
  } catch { /* lookups unavailable */ }
}

async function loadTask() {
  if (!isEdit.value) return
  try {
    task.value = await store.fetchTask(route.params.id as string)
    form.value = {
      name: task.value.name || '',
      description: task.value.description || '',
      stageName: task.value.stageName || '',
      priority: task.value.priority || 'normal',
      assigneeIds: task.value.assigneeIds || [],
      parentTaskId: task.value.parentTaskId || '',
      dependencyIds: task.value.dependencyIds || [],
      dateDeadline: task.value.dateDeadline?.split('T')[0] || '',
      dateStart: task.value.dateStart?.split('T')[0] || '',
      dateEnd: task.value.dateEnd?.split('T')[0] || '',
      plannedHours: task.value.plannedHours || 0,
      milestoneId: task.value.milestoneId || '',
      tags: task.value.tags || [],
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload = { ...form.value, projectId: projectId.value }
    if (isEdit.value) {
      await store.updateTask(route.params.id as string, payload)
    } else {
      await store.createTask(payload)
    }
    showSuccess(t('common.savedSuccessfully'))
    router.back()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function transition(state: string) {
  try {
    task.value = await store.transitionTask(route.params.id as string, state)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  await fetchLookups()
  await loadTask()
  // Set default stage for new task
  if (!isEdit.value && stageNames.value.length > 0 && !form.value.stageName) {
    form.value.stageName = stageNames.value[0]
  }
})
</script>
