<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('documents.signatures') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-select v-model="stateFilter" :label="$t('common.state')" :items="states" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

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
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.signers="{ item }">
            <span v-for="(s, i) in item.signers" :key="i">
              <v-chip size="x-small" :color="signerColor(s.state)" class="mr-1">{{ s.name }} ({{ s.state }})</v-chip>
            </span>
          </template>
          <template #item.expiryDate="{ item }">{{ item.expiryDate?.split('T')[0] || '-' }}</template>
          <template #item.createdAt="{ item }">{{ item.createdAt?.split('T')[0] }}</template>
          <template #item.actions="{ item }">
            <v-btn v-if="item.state === 'draft'" icon="mdi-send" size="small" variant="text" color="primary" :title="$t('documents.send')" @click="doSend(item)" />
            <v-btn v-if="item.state === 'draft' || item.state === 'sent'" icon="mdi-cancel" size="small" variant="text" color="error" :title="$t('common.cancel')" @click="doCancel(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ $t('documents.createSignatureRequest') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.documentId" :label="$t('documents.documentId')" :rules="[v => !!v || $t('required')]" />
            <v-switch v-model="form.sequentialSigning" :label="$t('documents.sequentialSigning')" color="primary" />
            <v-text-field v-model="form.expiryDate" :label="$t('documents.expiryDate')" type="date" />
            <v-text-field v-model.number="form.reminderIntervalDays" :label="$t('documents.reminderDays')" type="number" />

            <div class="d-flex align-center mt-4 mb-2">
              <span class="text-subtitle-1 font-weight-medium">{{ $t('documents.signers') }}</span>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addSigner">{{ $t('common.add') }}</v-btn>
            </div>
            <v-card v-for="(signer, idx) in form.signers" :key="idx" variant="outlined" class="mb-2 pa-3">
              <v-row dense>
                <v-col cols="5">
                  <v-text-field v-model="signer.name" :label="$t('common.name')" :rules="[v => !!v || $t('required')]" density="compact" />
                </v-col>
                <v-col cols="5">
                  <v-text-field v-model="signer.email" :label="$t('common.email')" type="email" :rules="[v => !!v || $t('required')]" density="compact" />
                </v-col>
                <v-col cols="2" class="d-flex align-center justify-center">
                  <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="form.signers.splice(idx, 1)" />
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
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore, type SignatureRequest } from '../../store/documents.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = useDocumentsStore()
const { showSuccess, showError } = useSnackbar()

const states = ['draft', 'sent', 'completed', 'cancelled', 'expired']
const stateFilter = ref<string | null>(null)
const items = ref<SignatureRequest[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)

const dialog = ref(false)
const formRef = ref()
const form = ref({
  documentId: '',
  sequentialSigning: false,
  expiryDate: '',
  reminderIntervalDays: 0,
  signers: [{ name: '', email: '' }] as { name: string; email: string }[],
})

const headers = computed(() => [
  { title: t('documents.document'), key: 'documentId' },
  { title: t('common.state'), key: 'state' },
  { title: t('documents.signers'), key: 'signers', sortable: false },
  { title: t('documents.expiryDate'), key: 'expiryDate' },
  { title: t('common.createdAt'), key: 'createdAt', sortable: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function stateColor(state: string) {
  const map: Record<string, string> = { draft: 'grey', sent: 'warning', completed: 'success', cancelled: 'error', expired: 'error' }
  return map[state] || 'grey'
}

function signerColor(state: string) {
  const map: Record<string, string> = { waiting: 'grey', sent: 'warning', signed: 'success', declined: 'error' }
  return map[state] || 'grey'
}

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  if (stateFilter.value) params.state = stateFilter.value
  const data = await store.fetchSignatureRequests(params)
  items.value = store.signatureRequests
  total.value = data?.total || 0
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchData()
}

watch(stateFilter, () => { page.value = 0; fetchData() })

function openCreate() {
  form.value = { documentId: '', sequentialSigning: false, expiryDate: '', reminderIntervalDays: 0, signers: [{ name: '', email: '' }] }
  dialog.value = true
}

function addSigner() {
  form.value.signers.push({ name: '', email: '' })
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload: any = {
      documentId: form.value.documentId,
      signers: form.value.signers.filter(s => s.name && s.email),
      sequentialSigning: form.value.sequentialSigning,
    }
    if (form.value.expiryDate) payload.expiryDate = form.value.expiryDate
    if (form.value.reminderIntervalDays > 0) payload.reminderIntervalDays = form.value.reminderIntervalDays

    await store.createSignatureRequest(payload)
    dialog.value = false
    showSuccess(t('common.createdSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doSend(item: SignatureRequest) {
  try {
    await store.sendSignatureRequest(item._id)
    showSuccess(t('documents.signatureRequestSent'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doCancel(item: SignatureRequest) {
  try {
    await store.cancelSignatureRequest(item._id)
    showSuccess(t('documents.signatureRequestCancelled'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
