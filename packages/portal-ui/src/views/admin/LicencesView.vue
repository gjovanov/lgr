<template>
  <v-container>
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('adminLicences.title') }}</h1>
      <v-spacer />
      <v-btn v-if="!forbidden" color="primary" variant="tonal" prepend-icon="mdi-license" data-test="pilot-new" @click="openPilot()">{{ $t('adminLicences.issuePilot') }}</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('adminLicences.intro') }}</p>

    <v-alert v-if="forbidden" type="warning" variant="tonal" data-test="licences-forbidden">{{ $t('adminLicences.forbidden') }}</v-alert>
    <template v-else>
      <v-alert v-if="signing && !signing.ok" type="error" variant="tonal" class="mb-4">{{ $t('adminLicences.signingOff', { reason: signing.reason }) }}</v-alert>

      <v-data-table :headers="headers" :items="items" :loading="loading" item-value="id" density="comfortable" :no-data-text="$t('adminLicences.none')">
        <template #item.name="{ item }">
          <div>{{ item.name }}</div>
          <div class="text-caption text-medium-emphasis"><code>{{ item.slug }}</code></div>
        </template>
        <template #item.subscription="{ item }">{{ item.subscription?.plan ?? '—' }}<span v-if="item.subscription?.status" class="text-medium-emphasis"> · {{ item.subscription.status }}</span></template>
        <template #item.pilot="{ item }">
          <template v-if="item.pilot">
            <span :class="{ 'text-decoration-line-through': item.pilot.revokedAt }">{{ day(item.pilot.until) }}</span>
            <v-chip v-if="item.pilot.revokedAt" size="x-small" color="error" variant="tonal" class="ml-1">{{ $t('adminLicences.revoked') }}</v-chip>
            <div v-if="item.pilot.note" class="text-caption text-medium-emphasis">{{ item.pilot.note }}</div>
          </template>
          <span v-else>—</span>
        </template>
        <template #item.entitlement="{ item }">
          <template v-if="item.entitlement">
            {{ day(item.entitlement.paidThrough) }} <span class="text-caption text-medium-emphasis">({{ $t('adminLicences.graceUntil', { date: day(item.entitlement.graceEndsAt) }) }})</span>
          </template>
          <span v-else class="text-medium-emphasis">{{ $t('adminLicences.notEntitled') }}</span>
        </template>
        <template #item.actions="{ item }">
          <div class="d-flex ga-1 justify-end">
            <v-btn size="small" variant="text" @click="openPilot(item)">{{ item.pilot && !item.pilot.revokedAt ? $t('adminLicences.extendPilot') : $t('adminLicences.issuePilot') }}</v-btn>
            <v-btn v-if="item.pilot && !item.pilot.revokedAt" size="small" variant="text" color="error" @click="revoking = item">{{ $t('adminLicences.revokePilot') }}</v-btn>
            <v-btn v-if="item.entitlement" size="small" variant="text" prepend-icon="mdi-file-certificate-outline" @click="openFile(item)">{{ $t('adminLicences.file') }}</v-btn>
          </div>
        </template>
      </v-data-table>
    </template>

    <v-dialog v-model="pilotOpen" max-width="480">
      <v-card :title="pilotOrg?.name ? `${$t('adminLicences.issuePilot')}: ${pilotOrg.name}` : $t('adminLicences.issuePilot')">
        <v-card-text>
          <v-text-field v-if="!pilotOrg" v-model="pilotSlug" :label="$t('adminLicences.org')" placeholder="acme-corp" density="compact" />
          <v-text-field v-model="pilotUntil" type="date" :label="$t('adminLicences.until')" density="compact" />
          <v-text-field v-model="pilotNote" :label="$t('adminLicences.note')" density="compact" counter="500" maxlength="500" />
          <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="pilotOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!pilotUntil || (!pilotOrg && !pilotSlug)" data-test="pilot-save" @click="savePilot">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="!!revoking" max-width="480" @update:model-value="v => { if (!v) revoking = null }">
      <v-card :title="$t('adminLicences.revokePilot')">
        <v-card-text>{{ $t('adminLicences.revokeConfirm', { org: revoking?.name }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="revoking = null">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="busy" @click="revoke">{{ $t('adminLicences.revokePilot') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="fileOpen" max-width="480">
      <v-card :title="`${$t('adminLicences.fileFor')}: ${fileOrg?.name ?? ''}`">
        <v-card-text>
          <v-text-field v-model="fileNode" :label="$t('adminLicences.nodeId')" placeholder="master-…" density="compact" />
          <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="fileOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!fileNode" prepend-icon="mdi-download" @click="downloadFile">{{ $t('adminLicences.download') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

/**
 * The sys-admins' licences (FR-20.55, plan step P2-3b): which orgs may run on their own server and
 * why, the pilots, and a licence file for an air-gapped server.
 *
 * ⚠ Gated SERVER-SIDE by the backup allow-list (`BACKUP_SYS_ADMINS`); the nav entry secures nothing.
 */

const { t, locale } = useI18n()
const { showSuccess } = useSnackbar()
const items = ref<any[]>([])
const signing = ref<{ ok: boolean; reason?: string } | null>(null)
const loading = ref(false)
const forbidden = ref(false)
const busy = ref(false)
const error = ref('')

const headers = computed(() => [
  { title: t('adminLicences.org'), key: 'name' },
  { title: t('adminLicences.masters'), key: 'masters' },
  { title: t('adminLicences.subscription'), key: 'subscription', sortable: false },
  { title: t('adminLicences.pilot'), key: 'pilot', sortable: false },
  { title: t('adminLicences.entitled'), key: 'entitlement', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

const day = (v?: string | null) => (v ? new Date(v).toLocaleDateString(locale.value) : '—')
const message = (e: any) => e?.response?.data?.message || e?.message || t('common.operationFailed')

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get('/admin/licences')
    items.value = data.orgs ?? []
    signing.value = data.signing ?? null
  } catch (e: any) {
    if (e?.response?.status === 403 || e?.response?.status === 404) forbidden.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

const pilotOpen = ref(false)
const pilotOrg = ref<any>(null)
const pilotSlug = ref('')
const pilotUntil = ref('')
const pilotNote = ref('')

function openPilot(org?: any) {
  error.value = ''
  pilotOrg.value = org ?? null
  pilotSlug.value = ''
  pilotUntil.value = org?.pilot && !org.pilot.revokedAt ? String(org.pilot.until).slice(0, 10) : ''
  pilotNote.value = org?.pilot?.note ?? ''
  pilotOpen.value = true
}

async function savePilot() {
  busy.value = true
  error.value = ''
  try {
    const target = pilotOrg.value?.id ?? pilotSlug.value.trim().toLowerCase()
    await httpClient.put(`/admin/licences/${encodeURIComponent(target)}`, { until: pilotUntil.value, note: pilotNote.value })
    pilotOpen.value = false
    showSuccess(t('adminLicences.saved'))
    await load()
  } catch (e: any) {
    error.value = message(e)
  } finally {
    busy.value = false
  }
}

const revoking = ref<any>(null)
async function revoke() {
  busy.value = true
  try {
    await httpClient.delete(`/admin/licences/${revoking.value.id}`)
    revoking.value = null
    showSuccess(t('adminLicences.saved'))
    await load()
  } finally {
    busy.value = false
  }
}

const fileOpen = ref(false)
const fileOrg = ref<any>(null)
const fileNode = ref('')
function openFile(org: any) {
  error.value = ''
  fileOrg.value = org
  fileNode.value = ''
  fileOpen.value = true
}

/** The licence as a file the operator carries to the server: `lgr-server licence import <file>`. */
async function downloadFile() {
  busy.value = true
  error.value = ''
  try {
    const { data } = await httpClient.post(`/admin/licences/${fileOrg.value.id}/file`, { nodeId: fileNode.value.trim() })
    const url = URL.createObjectURL(new Blob([`${data.jws}\n`], { type: 'application/jose' }))
    const a = document.createElement('a')
    a.href = url
    a.download = data.fileName
    a.click()
    URL.revokeObjectURL(url)
    fileOpen.value = false
  } catch (e: any) {
    error.value = message(e)
  } finally {
    busy.value = false
  }
}
</script>
