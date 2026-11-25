<template>
  <v-container fluid>
    <div class="mb-4 d-flex align-center flex-wrap ga-2">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('accounting.groupCosts.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mb-0">{{ $t('accounting.groupCosts.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn
        v-if="place === 'home'"
        v-cap="'accounts.edit'"
        color="primary"
        prepend-icon="mdi-plus"
        data-testid="group-costs-new"
        @click="openCreate"
      >{{ $t('accounting.groupCosts.new') }}</v-btn>
    </div>

    <template v-if="settingsKnown && place !== 'home'">
      <v-alert type="info" variant="tonal" data-testid="group-costs-not-home">
        {{ place === 'store' ? $t('accounting.groupCosts.notHome') : $t('accounting.groupCosts.notBooks') }}
      </v-alert>
    </template>

    <template v-else-if="settingsKnown">
      <v-alert type="info" variant="tonal" density="compact" class="mb-4">{{ $t('accounting.groupCosts.when') }}</v-alert>
      <v-card variant="outlined">
        <v-data-table
          :headers="headers"
          :items="overrides"
          :loading="loading"
          density="compact"
          item-value="id"
          :items-per-page="50"
          :no-data-text="$t('accounting.groupCosts.none')"
          data-testid="group-costs-table"
        >
          <template #item.group="{ item }">
            <span>{{ item.path ? groupLabel(item.path) : $t('accounting.groupCosts.groupGone') }}</span>
            <v-chip v-if="item.path && !item.active" size="x-small" label class="ml-2">{{ $t('accounting.groupCosts.inactive') }}</v-chip>
          </template>
          <template #item.from="{ item }">{{ formatDate(item.from) }}</template>
          <template #item.unitCost="{ item }">{{ unitText(item.unitCost) }}</template>
          <template #item.changed="{ item }">
            <span class="text-caption">{{ lastChangeOf(item).name }} · {{ formatDateTime(lastChangeOf(item).at) }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn v-cap="'accounts.edit'" size="x-small" variant="text" :disabled="!!busy" @click="openEdit(item)">{{ $t('common.edit') }}</v-btn>
            <v-btn v-cap="'accounts.edit'" size="x-small" variant="text" color="error" :loading="busy === item.id" @click="remove(item)">{{ $t('common.delete') }}</v-btn>
          </template>
        </v-data-table>
      </v-card>
    </template>

    <v-dialog v-model="dialog.open" max-width="560">
      <v-card>
        <v-card-title>{{ dialog.editing ? $t('accounting.groupCosts.edit') : $t('accounting.groupCosts.new') }}</v-card-title>
        <v-card-text class="pt-2">
          <v-autocomplete
            v-model="form.analyticId"
            :items="groupItems"
            :label="$t('accounting.groupCosts.group')"
            :disabled="!!dialog.editing"
            density="compact"
            variant="outlined"
            auto-select-first
            data-testid="group-costs-group"
          />
          <DateField
            v-model="form.from"
            :label="$t('accounting.groupCosts.from')"
            :disabled="!!dialog.editing"
            density="compact"
            variant="outlined"
            data-testid="group-costs-from"
          />
          <DecimalField
            v-model="form.unitCost"
            :decimals="UNIT_DECIMALS"
            :min-decimals="2"
            :label="$t('accounting.groupCosts.unitCost')"
            suffix="EUR"
            density="compact"
            variant="outlined"
            data-testid="group-costs-unit"
          />
          <v-textarea
            v-model="form.reason"
            :label="$t('accounting.groupCosts.reason')"
            :hint="$t('accounting.groupCosts.reasonHint')"
            persistent-hint
            :counter="REASON_MAX"
            rows="2"
            auto-grow
            density="compact"
            variant="outlined"
            data-testid="group-costs-reason"
          />
          <div class="text-body-2 mt-3" data-testid="group-costs-average">
            <v-progress-circular v-if="average.loading" indeterminate size="14" width="2" class="mr-2" />
            <template v-else-if="average.value">
              <span v-if="average.value.unitCost !== undefined">
                {{ $t('accounting.groupCosts.average', {
                  day: formatDate(average.value.day),
                  unit: unitText(average.value.unitCost),
                  quantity: formatNumber(average.value.quantity ?? 0, { maxDecimals: 3 }),
                }) }}
                <span v-if="change !== null" :class="change < 0 ? 'text-error' : 'text-success'">
                  ({{ change > 0 ? '+' : '' }}{{ formatNumber(change * 100, { maxDecimals: 1 }) }}%)
                </span>
              </span>
              <span v-else>{{ $t('accounting.groupCosts.noAverage', { day: formatDate(average.value.day) }) }}</span>
            </template>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog.open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            v-cap="'accounts.edit'"
            color="primary"
            variant="flat"
            :disabled="problems.length > 0"
            :loading="saving"
            data-testid="group-costs-save"
            @click="save"
          >{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { askConfirm } from 'ui-shared/composables/confirm'
import { formatDate, formatDateTime, formatNumber } from 'ui-shared/format'
import DateField from 'ui-shared/components/DateField.vue'
import DecimalField from 'ui-shared/components/DecimalField.vue'
import { groupLabel, type GoodsGroup } from './product-groups-page'
import {
  REASON_MAX, UNIT_DECIMALS, booksPlaceOf, changeOf, createBody, formProblems, lastChangeOf, sortOverrides, updateBody, writeErrorKey,
  type CostOverride, type GroupAverage, type OverrideForm,
} from './group-costs-page'

/**
 * FR-25 R3 (2026-11-25): the accountant's overrides of a goods group's average cost. The accountant: "the daily average
 * price, like until March, with an option to override it, for write-offs or other losses the average does not show".
 * Only the home of a company's books keeps them; a store of a split is sent there. An override takes effect at the next
 * shadow posting run over its day, which reposts the sales it changes.
 */

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

// The org's settings come with `/auth/me`; until they do the page asks for nothing and says nothing.
const sessionOrg = computed(() => appStore.currentOrg as { id?: string; settings?: unknown } | null)
const settingsKnown = computed(() => !!sessionOrg.value?.settings)
const place = computed(() => booksPlaceOf(sessionOrg.value))
const base = () => `${appStore.orgUrl()}/accounting/group-costs`

const overrides = ref<CostOverride[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)
const saving = ref(false)
const groups = ref<GoodsGroup[]>([])

const headers = computed(() => [
  { title: t('accounting.groupCosts.group'), key: 'group', sortable: false },
  { title: t('accounting.groupCosts.from'), key: 'from' },
  { title: t('accounting.groupCosts.unitCost'), key: 'unitCost', align: 'end' as const },
  { title: t('accounting.groupCosts.reason'), key: 'reason', sortable: false },
  { title: t('accounting.groupCosts.changed'), key: 'changed', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

const unitText = (n: number | undefined) => (n === undefined ? '' : `${formatNumber(n, { minDecimals: 2, maxDecimals: UNIT_DECIMALS })} EUR`)
const groupItems = computed(() => groups.value.filter(g => g.active || g.id === form.analyticId).map(g => ({ title: groupLabel(g.path), value: g.id })))

function refusal(e: any) {
  const key = writeErrorKey(e?.response?.data?.code)
  showError(key ? t(key) : e?.response?.data?.message || t('common.operationFailed'))
}

async function reload() {
  if (place.value !== 'home') return
  loading.value = true
  try {
    const { data } = await httpClient.get(base())
    overrides.value = sortOverrides(data.overrides ?? [])
  } catch (e) {
    refusal(e)
  } finally {
    loading.value = false
  }
}

async function loadGroups() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/accounting/product-groups/groups`)
    groups.value = data.groups ?? []
  } catch {
    // The picker then offers nothing and Save stays off.
  }
}

// ── the dialog ──

const form = reactive<OverrideForm>({ analyticId: null, from: null, unitCost: null, reason: '' })
const dialog = reactive<{ open: boolean; editing: CostOverride | null }>({ open: false, editing: null })
const problems = computed(() => formProblems(form))

async function openCreate() {
  if (!groups.value.length) await loadGroups()
  Object.assign(form, { analyticId: null, from: new Date().toISOString().slice(0, 10), unitCost: null, reason: '' })
  dialog.editing = null
  dialog.open = true
}

async function openEdit(o: CostOverride) {
  if (!groups.value.length) await loadGroups()
  Object.assign(form, { analyticId: o.analyticId, from: o.from, unitCost: o.unitCost, reason: o.reason })
  dialog.editing = o
  dialog.open = true
}

async function save() {
  if (problems.value.length) return
  saving.value = true
  try {
    if (dialog.editing) await httpClient.put(`${base()}/${dialog.editing.id}`, updateBody(form, dialog.editing.updatedAt))
    else await httpClient.post(base(), createBody(form))
    dialog.open = false
    showSuccess(t('accounting.groupCosts.saved'))
  } catch (e) {
    refusal(e)
  } finally {
    saving.value = false
    void reload()
  }
}

async function remove(o: CostOverride) {
  const ok = await askConfirm({
    text: t('accounting.groupCosts.removeAsk', { group: o.path ? groupLabel(o.path) : '', day: formatDate(o.from) }),
    confirm: t('common.delete'),
    danger: true,
  })
  if (!ok) return
  busy.value = o.id
  try {
    await httpClient.delete(`${base()}/${o.id}`, { params: { expected: o.updatedAt } })
    showSuccess(t('accounting.groupCosts.removed'))
  } catch (e) {
    refusal(e)
  } finally {
    busy.value = null
    void reload()
  }
}

// ── the replayed average beside the unit asked for ──

const average = reactive<{ loading: boolean; value: GroupAverage | null }>({ loading: false, value: null })
const change = computed(() => changeOf(form.unitCost, average.value?.unitCost))
let asked = 0
let timer: ReturnType<typeof setTimeout> | undefined

watch(() => [dialog.open, form.analyticId, form.from] as const, ([open, analyticId, from]) => {
  clearTimeout(timer)
  const n = ++asked
  average.value = null
  if (!open || !analyticId || !from || formProblems({ ...form, unitCost: 0, reason: 'x' }).length) {
    average.loading = false
    return
  }
  average.loading = true
  timer = setTimeout(async () => {
    try {
      const { data } = await httpClient.get(`${base()}/average`, { params: { analyticId, day: from } })
      if (n === asked) average.value = data
    } catch {
      // No hint then: the override can still be saved.
    } finally {
      if (n === asked) average.loading = false
    }
  }, 300)
})

watch(place, p => { if (p === 'home') void reload() })
onMounted(reload)
</script>
