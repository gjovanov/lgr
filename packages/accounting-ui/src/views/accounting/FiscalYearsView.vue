<template>
  <v-container>
    <div class="mb-4 d-flex align-center">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('nav.fiscalYears') }}</h1>
        <p class="text-body-2 text-grey mb-0">{{ $t('fiscalYear.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('fiscalYear.new') }}</v-btn>
    </div>

    <v-card variant="outlined">
      <v-data-table
        :headers="headers"
        :items="years"
        :loading="loading"
        density="compact"
        item-value="_id"
        :no-data-text="$t('fiscalYear.none')"
      >
        <template #item.range="{ item }">{{ day(item.startDate) }} → {{ day(item.endDate) }}</template>
        <template #item.status="{ item }">
          <v-chip size="x-small" :color="statusColor(item.status)" label>
            {{ $t(`fiscalYear.status.${item.status}`) }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="item.status !== 'locked'"
            size="x-small" variant="text" @click="openEdit(item)"
          >{{ $t('common.edit') }}</v-btn>
          <!--
            ⚠ Locking is one-way from this screen. It is what `locked` means: the year is
            finished, its documents become archivable, and a Replace restore over it is
            refused (Наредба Н-18 / Приложение 29). A button that undid it would make a
            compliance control a toggle.
          -->
          <v-btn
            v-if="item.status !== 'locked'"
            size="x-small" variant="text" color="warning"
            :loading="busy === item._id"
            @click="askLock(item)"
          >{{ $t('fiscalYear.lock') }}</v-btn>
          <span v-else class="text-caption text-grey">{{ $t('fiscalYear.lockedNote') }}</span>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit -->
    <v-dialog v-model="formOpen" max-width="480">
      <v-card>
        <v-card-title class="text-subtitle-1">
          {{ editing ? $t('fiscalYear.edit') : $t('fiscalYear.new') }}
        </v-card-title>
        <v-card-text class="pt-2">
          <v-text-field v-model="form.name" :label="$t('common.name')" density="compact" variant="outlined" />
          <v-text-field v-model="form.startDate" type="date" :label="$t('fiscalYear.start')" density="compact" variant="outlined" />
          <v-text-field v-model="form.endDate" type="date" :label="$t('fiscalYear.end')" density="compact" variant="outlined" />
          <v-select
            v-model="form.status"
            :items="statusItems"
            :label="$t('common.status')"
            density="compact" variant="outlined" hide-details
          />
          <!--
            `locked` is deliberately absent from this dropdown. It is reachable only through
            the explicit action, which states what it costs.
          -->
          <p class="text-caption text-grey mt-2 mb-0">{{ $t('fiscalYear.statusHint') }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="formOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Lock confirmation -->
    <v-dialog v-model="lockOpen" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-1">
          {{ $t('fiscalYear.lockTitle', { name: target?.name }) }}
        </v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="comfortable" class="mb-3">
            {{ $t('fiscalYear.lockWarning') }}
          </v-alert>
          <ul class="text-body-2 ml-4">
            <li>{{ $t('fiscalYear.lockEffectArchive') }}</li>
            <li>{{ $t('fiscalYear.lockEffectRestore') }}</li>
            <li>{{ $t('fiscalYear.lockEffectOneWay') }}</li>
          </ul>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="lockOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="warning" :loading="!!busy" @click="confirmLock">{{ $t('fiscalYear.lock') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAccountingStore } from '../../store/accounting.store'

/**
 * FR-13.38 (#24) — the screen that makes a fiscal year archivable.
 *
 * ⚠ This existed nowhere. `FiscalYear` rows were created by seeds and migrations, the API
 * accepted a `status`, and no screen in the suite rendered it — so `locked`, which FR-13
 * requires before a year's documents can be archived and which blocks a Replace restore, was
 * reachable only through the API or Mongo directly. A compliance state nobody can set is not
 * a compliance state.
 */

const { t } = useI18n()
const store = useAccountingStore()
const { showError, showSuccess } = useSnackbar()

const years = ref<any[]>([])
const loading = ref(false)
const saving = ref(false)
const busy = ref<string | null>(null)
const formOpen = ref(false)
const lockOpen = ref(false)
const editing = ref<any>(null)
const target = ref<any>(null)

const form = reactive({ name: '', startDate: '', endDate: '', status: 'open' })

/** ⚠ `locked` is absent on purpose — see the explicit action. */
const statusItems = computed(() => [
  { title: t('fiscalYear.status.open'), value: 'open' },
  { title: t('fiscalYear.status.closed'), value: 'closed' },
])

const headers = computed(() => [
  { title: t('common.name'), key: 'name' },
  { title: t('fiscalYear.range'), key: 'range', sortable: false },
  { title: t('common.status'), key: 'status' },
  { title: '', key: 'actions', sortable: false },
])

const day = (d: string) => (d ? new Date(d).toISOString().slice(0, 10) : '')
function statusColor(s: string) {
  return ({ open: 'success', closed: 'info', locked: 'warning' } as any)[s] || 'grey'
}

async function reload() {
  loading.value = true
  try {
    await store.fetchFiscalYears()
    years.value = [...store.fiscalYears].sort((a: any, b: any) => +new Date(b.startDate) - +new Date(a.startDate))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function openCreate() {
  editing.value = null
  const y = new Date().getFullYear()
  Object.assign(form, { name: `FY ${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31`, status: 'open' })
  formOpen.value = true
}

function openEdit(item: any) {
  editing.value = item
  Object.assign(form, {
    name: item.name, startDate: day(item.startDate), endDate: day(item.endDate), status: item.status,
  })
  formOpen.value = true
}

async function save() {
  saving.value = true
  try {
    const payload = {
      name: form.name,
      startDate: new Date(form.startDate).toISOString(),
      endDate: new Date(form.endDate).toISOString(),
      status: form.status,
    }
    if (editing.value) await store.updateFiscalYear(editing.value._id, payload as any)
    else await store.createFiscalYear(payload as any)
    formOpen.value = false
    await reload()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { saving.value = false }
}

function askLock(item: any) {
  target.value = item
  lockOpen.value = true
}

async function confirmLock() {
  busy.value = target.value._id
  try {
    await store.updateFiscalYear(target.value._id, { status: 'locked' } as any)
    lockOpen.value = false
    showSuccess(t('fiscalYear.locked', { name: target.value.name }))
    await reload()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { busy.value = null }
}

onMounted(reload)
</script>
