<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.back()" />
      <h1 class="text-h5 ml-2">{{ isEdit ? t('project.editProject') : t('project.newProject') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete
                v-model="form.managerId"
                :label="t('project.manager')"
                :items="users"
                :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
                item-value="_id"
                :rules="[rules.required]"
                clearable
              />
            </v-col>
            <v-col cols="12">
              <v-textarea v-model="form.description" :label="t('common.description')" rows="3" auto-grow />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete
                v-model="form.partnerId"
                :label="t('project.partner')"
                :items="contacts"
                :item-title="(c: any) => c.companyName || `${c.firstName} ${c.lastName}`"
                item-value="_id"
                clearable
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete
                v-model="form.memberIds"
                :label="t('project.members')"
                :items="users"
                :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
                item-value="_id"
                multiple
                chips
                closable-chips
                clearable
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.dateStart" :label="t('project.startDate')" type="date" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.dateEnd" :label="t('project.endDate')" type="date" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model.number="form.budgetPlanned" :label="t('project.budgetPlanned')" type="number" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model.number="form.revenueExpected" :label="t('project.revenueExpected')" type="number" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.color" :label="t('project.color')" type="color" />
            </v-col>
            <v-col cols="12" md="9">
              <TagInput v-model="form.tags" type="project" :org-url="appStore.orgUrl()" />
            </v-col>
          </v-row>

          <!-- Stages Editor -->
          <h3 class="text-subtitle-1 mt-4 mb-2">{{ t('project.stages') }}</h3>
          <v-row v-for="(stage, idx) in form.stages" :key="idx" align="center">
            <v-col cols="5">
              <v-text-field v-model="stage.name" :label="`${t('project.stageName')} ${idx + 1}`" density="compact" hide-details />
            </v-col>
            <v-col cols="3">
              <v-text-field v-model.number="stage.sequence" :label="t('project.sequence')" type="number" density="compact" hide-details />
            </v-col>
            <v-col cols="2">
              <v-checkbox v-model="stage.fold" :label="t('project.fold')" density="compact" hide-details />
            </v-col>
            <v-col cols="2">
              <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="form.stages.splice(idx, 1)" />
            </v-col>
          </v-row>
          <v-btn variant="text" color="primary" prepend-icon="mdi-plus" class="mt-2" @click="addStage">{{ t('project.addStage') }}</v-btn>
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
import { ref, onMounted, computed } from 'vue'
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
const users = ref<any[]>([])
const contacts = ref<any[]>([])

const emptyForm = () => ({
  name: '',
  description: '',
  partnerId: '',
  managerId: '',
  memberIds: [] as string[],
  dateStart: '',
  dateEnd: '',
  budgetPlanned: 0,
  revenueExpected: 0,
  color: '#1976D2',
  tags: [] as string[],
  stages: [
    { name: 'New', sequence: 1, fold: false },
    { name: 'In Progress', sequence: 2, fold: false },
    { name: 'Done', sequence: 3, fold: true },
  ],
})
const form = ref(emptyForm())

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function addStage() {
  const seq = form.value.stages.length > 0 ? Math.max(...form.value.stages.map(s => s.sequence)) + 1 : 1
  form.value.stages.push({ name: '', sequence: seq, fold: false })
}

async function fetchLookups() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const [usersRes, contactsRes] = await Promise.all([
      httpClient.get(`/org/${appStore.currentOrg?.id}/user`),
      httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { pageSize: 200 } }),
    ])
    users.value = usersRes.data.users || usersRes.data || []
    contacts.value = contactsRes.data.contacts || []
  } catch { /* lookups unavailable */ }
}

async function loadProject() {
  if (!isEdit.value) return
  try {
    const project = await store.fetchProject(route.params.id as string)
    form.value = {
      name: project.name || '',
      description: project.description || '',
      partnerId: project.partnerId || '',
      managerId: project.managerId || '',
      memberIds: project.memberIds || [],
      dateStart: project.dateStart?.split('T')[0] || '',
      dateEnd: project.dateEnd?.split('T')[0] || '',
      budgetPlanned: project.budgetPlanned || 0,
      revenueExpected: project.revenueExpected || 0,
      color: project.color || '#1976D2',
      tags: project.tags || [],
      stages: project.stages || [],
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (isEdit.value) {
      await store.updateProject(route.params.id as string, form.value)
    } else {
      await store.createProject(form.value)
    }
    showSuccess(t('common.savedSuccessfully'))
    router.back()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  await fetchLookups()
  await loadProject()
})
</script>
