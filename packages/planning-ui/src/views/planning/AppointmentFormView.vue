<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" :to="{ name: 'planning.appointments' }" />
      <h1 class="text-h5 ml-2">{{ isNew ? $t('planning.createAppointment') : $t('planning.editAppointment') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12" md="6">
              <v-select v-model="form.typeId" :label="$t('planning.appointmentType')" :items="typeOptions" item-title="name" item-value="_id" :rules="[v => !!v || $t('required')]" />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete v-model="form.partnerId" :label="$t('planning.partner')" :items="partners" item-title="name" item-value="_id" clearable />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="6">
              <v-autocomplete v-model="form.assigneeId" :label="$t('planning.assignee')" :items="assignees" item-title="name" item-value="_id" :rules="[v => !!v || $t('required')]" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.dateStart" :label="$t('planning.dateStart')" type="datetime-local" :rules="[v => !!v || $t('required')]" />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.dateEnd" :label="$t('planning.dateEnd')" type="datetime-local" :rules="[v => !!v || $t('required')]" />
            </v-col>
          </v-row>
          <v-text-field v-model="form.meetingUrl" :label="$t('planning.meetingUrl')" />
          <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="3" />
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :to="{ name: 'planning.appointments' }">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="store.loading" @click="save">{{ $t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePlanningStore } from '../../store/planning.store'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = usePlanningStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const isNew = computed(() => !route.params.id)
const formRef = ref()
const typeOptions = ref<{ _id: string; name: string }[]>([])
const partners = ref<{ _id: string; name: string }[]>([])
const assignees = ref<{ _id: string; name: string }[]>([])

const form = ref({
  typeId: '',
  partnerId: '',
  assigneeId: '',
  dateStart: '',
  dateEnd: '',
  meetingUrl: '',
  notes: '',
})

async function fetchTypes() {
  await store.fetchAppointmentTypes({ size: 100, isActive: 'true' })
  typeOptions.value = store.appointmentTypes.map(t => ({ _id: t._id, name: t.name }))
}

async function fetchPartners() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { size: 200 } })
    partners.value = (data.contacts || []).map((c: any) => ({ _id: c._id, name: c.name }))
  } catch { /* */ }
}

async function fetchAssignees() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const { data } = await httpClient.get(`${portalBase}/org/${appStore.currentOrg?.id}/users`, { params: { size: 200 } })
    assignees.value = (data.users || []).map((u: any) => ({ _id: u._id || u.id, name: `${u.firstName} ${u.lastName}`.trim() }))
  } catch { /* */ }
}

async function loadAppointment() {
  if (!route.params.id) return
  try {
    const data = await store.fetchAppointment(route.params.id as string)
    form.value = {
      typeId: data.typeId,
      partnerId: data.partnerId || '',
      assigneeId: data.assigneeId,
      dateStart: data.dateStart ? new Date(data.dateStart).toISOString().slice(0, 16) : '',
      dateEnd: data.dateEnd ? new Date(data.dateEnd).toISOString().slice(0, 16) : '',
      meetingUrl: data.meetingUrl || '',
      notes: data.notes || '',
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload: any = { ...form.value }
    if (!payload.partnerId) delete payload.partnerId
    if (!payload.meetingUrl) delete payload.meetingUrl
    if (!payload.notes) delete payload.notes

    if (isNew.value) {
      const created = await store.createAppointment(payload)
      showSuccess(t('common.createdSuccessfully'))
      router.push({ name: 'planning.appointments.edit', params: { id: created._id } })
    } else {
      await store.updateAppointment(route.params.id as string, payload)
      showSuccess(t('common.savedSuccessfully'))
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchTypes()
  fetchPartners()
  fetchAssignees()
  loadAppointment()
})
</script>
