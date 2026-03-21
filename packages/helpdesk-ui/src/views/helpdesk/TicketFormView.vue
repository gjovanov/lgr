<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.back()" />
      <h1 class="text-h5 ml-2">{{ t('helpdesk.newTicket') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12">
              <v-textarea v-model="form.description" :label="t('common.description')" :rules="[rules.required]" rows="4" auto-grow />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete
                v-model="form.partnerId"
                :label="t('helpdesk.partner')"
                :items="contacts"
                :item-title="(c: any) => c.companyName || `${c.firstName} ${c.lastName}`"
                item-value="_id"
                clearable
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-select
                v-model="form.teamId"
                :label="t('helpdesk.team')"
                :items="teams"
                item-title="name"
                :item-value="(t: any) => t._id || t.id"
                clearable
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.priority" :label="t('helpdesk.priority')" :items="priorities" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.channelSource" :label="t('helpdesk.channel')" :items="channels" />
            </v-col>
            <v-col cols="12" md="4">
              <TagInput v-model="form.tags" type="ticket" :org-url="appStore.orgUrl()" />
            </v-col>
          </v-row>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="$router.back()">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.create') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useHelpdeskStore } from '../../store/helpdesk.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const contacts = ref<any[]>([])
const teams = ref<any[]>([])

const priorities = ['low', 'normal', 'high', 'urgent']
const channels = ['web', 'email', 'phone', 'chat', 'social']

const form = ref({
  description: '',
  partnerId: '',
  teamId: '',
  priority: 'normal',
  channelSource: 'web',
  tags: [] as string[],
})

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

async function fetchLookups() {
  try {
    const [contactsRes] = await Promise.all([
      httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { pageSize: 200 } }),
      store.fetchTeams(),
    ])
    contacts.value = contactsRes.data.contacts || []
    teams.value = store.teams
  } catch { /* lookups unavailable */ }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const ticket = await store.createTicket(form.value)
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'helpdesk.tickets.detail', params: { id: ticket._id || ticket.id } })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchLookups() })
</script>
