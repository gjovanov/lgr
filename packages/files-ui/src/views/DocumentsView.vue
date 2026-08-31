<template>
  <v-container>
    <div class="mb-4 d-flex align-center">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('files.documents.title') }}</h1>
        <p class="text-body-2 text-grey mb-0">{{ $t('files.documents.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn-toggle v-model="viewMode" density="compact" variant="outlined" mandatory @update:model-value="onViewChange">
        <v-btn value="flat" size="small" prepend-icon="mdi-table">{{ $t('files.batch.viewFlat') }}</v-btn>
        <v-btn value="date" size="small" prepend-icon="mdi-calendar-month">{{ $t('files.batch.viewByDate') }}</v-btn>
      </v-btn-toggle>
    </div>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap ga-3 align-center">
        <v-text-field v-model="search" :label="$t('common.search')" prepend-inner-icon="mdi-magnify" density="compact" variant="outlined" hide-details clearable style="max-width: 220px" @update:model-value="reloadAll" />
        <v-select v-model="docType" :items="typeItems" :label="$t('files.col.type')" density="compact" variant="outlined" hide-details clearable style="max-width: 190px" @update:model-value="reloadAll" />
        <v-select v-model="statusFilter" :items="statusItems" :label="$t('files.col.status')" density="compact" variant="outlined" hide-details clearable style="max-width: 160px" @update:model-value="reloadAll" />
        <v-text-field v-if="viewMode === 'flat'" v-model="docDate" :label="$t('files.col.date')" placeholder="YYYY-MM-DD" density="compact" variant="outlined" hide-details clearable style="max-width: 150px" @update:model-value="reload" />
        <v-spacer />
        <v-btn variant="text" icon="mdi-refresh" @click="reloadAll" />
      </v-card-text>
    </v-card>

    <!-- Batch action bar -->
    <v-slide-y-transition>
      <v-card v-if="selected.size" variant="flat" color="primary" class="mb-3">
        <v-card-text class="d-flex flex-wrap align-center ga-3 py-2">
          <span class="font-weight-medium">{{ $t('files.batch.selected', { n: selected.size }) }}</span>
          <v-btn size="small" color="white" variant="flat" :loading="busy" prepend-icon="mdi-play-circle" @click="processSelected">{{ $t('files.batch.process') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-text-recognition" @click="ocrSelected">{{ $t('files.batch.ocr') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-magnify-scan" @click="analyzeSelected">{{ $t('files.batch.analyze') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-database-check" @click="reviewSelected">{{ $t('files.batch.review') }}</v-btn>
          <v-btn size="small" variant="tonal" color="red-lighten-4" :loading="busy" prepend-icon="mdi-delete-outline" @click="planDelete">{{ $t('files.batch.delete') }}</v-btn>
          <v-checkbox v-model="options.force" :label="$t('files.batch.force')" density="compact" hide-details color="white" />
          <v-spacer />
          <v-btn size="small" variant="text" @click="clearSelection">{{ $t('files.batch.clear') }}</v-btn>
        </v-card-text>
        <v-progress-linear v-if="busy" :model-value="progress" color="white" height="4" />
      </v-card>
    </v-slide-y-transition>

    <!-- FLAT view -->
    <v-data-table-server
      v-if="viewMode === 'flat'"
      :headers="headers"
      :items="items"
      :items-length="total"
      :loading="loading"
      :items-per-page="size"
      :page="page + 1"
      density="compact"
      @update:options="onOptions"
    >
      <template #item.select="{ item }">
        <v-checkbox-btn :model-value="selected.has(item.docFileId)" density="compact" @update:model-value="toggle(item.docFileId)" />
      </template>
      <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
      <template #item.status="{ item }"><v-chip size="x-small" :color="statusColor(item.status)" label>{{ item.status }}</v-chip></template>
      <template #item.version="{ item }">
        <v-btn v-if="item.version > 1" size="x-small" variant="tonal" @click="openVersions(item)">v{{ item.version }} · {{ $t('files.versions') }}</v-btn>
        <span v-else>v1</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(item)" target="_blank" />
      </template>
    </v-data-table-server>

    <!-- BY-DATE view -->
    <div v-else>
      <v-progress-linear v-if="datesLoading" indeterminate color="primary" class="mb-2" />
      <v-expansion-panels v-model="expanded" multiple variant="accordion">
        <v-expansion-panel v-for="d in dates" :key="d.docDate" :value="d.docDate">
          <v-expansion-panel-title>
            <div class="d-flex align-center ga-3 flex-grow-1">
              <!-- VSelectionControl defaults to `flex: 1 0`, which would grow and push the date to
                   the middle of the header — pin it so the date sits right beside the checkbox. -->
              <v-checkbox-btn class="flex-grow-0" style="flex: 0 0 auto" :model-value="dateAllSelected(d.docDate)" :indeterminate="dateSomeSelected(d.docDate)" density="compact" @click.stop="toggleDate(d.docDate)" />
              <span class="font-weight-medium text-left" style="min-width:6.5rem">{{ d.docDate }}</span>
              <v-chip size="x-small" label>{{ d.total }}</v-chip>
              <v-spacer />
              <v-chip v-if="d.uploaded" size="x-small" color="grey" label>{{ d.uploaded }} {{ $t('files.status.uploaded') }}</v-chip>
              <v-chip v-if="d.analyzed" size="x-small" color="warning" label>{{ d.analyzed }} {{ $t('files.status.analyzed') }}</v-chip>
              <v-chip v-if="d.committed" size="x-small" color="success" label>{{ d.committed }} {{ $t('files.status.committed') }}</v-chip>
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-progress-linear v-if="!dateDocs[d.docDate]" indeterminate color="primary" />
            <v-table v-else density="compact">
              <thead><tr>
                <th style="width:40px"></th><th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th>
                <th>{{ $t('files.col.status') }}</th><th>{{ $t('files.col.version') }}</th><th></th>
              </tr></thead>
              <tbody>
                <tr v-for="doc in dateDocs[d.docDate]" :key="doc.docFileId">
                  <td><v-checkbox-btn :model-value="selected.has(doc.docFileId)" density="compact" @update:model-value="toggle(doc.docFileId)" /></td>
                  <td><v-chip size="x-small" label>{{ doc.docType }}</v-chip></td>
                  <td class="text-caption">{{ doc.docNumber }}</td>
                  <td><v-chip size="x-small" :color="statusColor(doc.status)" label>{{ doc.status }}</v-chip></td>
                  <td>v{{ doc.version }}</td>
                  <td><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(doc)" target="_blank" /></td>
                </tr>
              </tbody>
            </v-table>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <p v-if="!datesLoading && !dates.length" class="text-body-2 text-grey text-center py-6">{{ $t('files.batch.noDocs') }}</p>
    </div>

    <!-- Review & Commit dialog -->
    <v-dialog v-model="reviewOpen" max-width="1100" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">{{ $t('files.review.title') }}</span>
          <v-spacer />
          <div class="d-flex ga-2">
            <v-chip size="small" color="success" label>{{ $t('files.review.ok') }}: {{ reviewCounts.ok }}</v-chip>
            <v-chip v-if="reviewCounts.warn" size="small" color="warning" label>{{ $t('files.review.withWarnings') }}: {{ reviewCounts.warn }}</v-chip>
            <v-chip v-if="reviewCounts.dup" size="small" color="orange" label>{{ $t('files.review.duplicate') }}: {{ reviewCounts.dup }}</v-chip>
            <v-chip v-if="reviewCounts.err" size="small" color="error" label>{{ $t('files.review.failed') }}: {{ reviewCounts.err }}</v-chip>
          </div>
        </v-card-title>
        <v-card-text style="max-height:60vh">
          <v-table density="compact">
            <thead><tr>
              <th style="width:40px">
                <v-checkbox-btn :model-value="allReviewSelected" :indeterminate="someReviewSelected" density="compact" @update:model-value="toggleAllReview" />
              </th>
              <th style="width:36px"></th>
              <th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th><th>{{ $t('files.col.kind') }}</th>
              <th class="text-center">{{ $t('files.col.matched') }}</th><th>{{ $t('files.review.warnings') }}</th>
            </tr></thead>
            <tbody>
              <template v-for="r in analyzeResults" :key="r.docFileId">
              <tr :class="r.error ? 'bg-red-lighten-5' : ''">
                <td>
                  <v-checkbox-btn :model-value="commitSel.has(r.docFileId)" :disabled="!r.committable" density="compact" @update:model-value="toggleCommit(r.docFileId)" />
                </td>
                <td>
                  <v-btn v-if="(r.lines || []).length" :icon="expandedDocs.has(r.docFileId) ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="x-small" variant="text" @click="toggleExpand(r.docFileId)" />
                </td>
                <td><v-chip size="x-small" label>{{ r.docType }}</v-chip></td>
                <td class="text-caption">{{ r.docNumber }}<span v-if="r.reused" class="text-grey"> · {{ $t('files.review.reused') }}</span></td>
                <td class="text-caption">{{ r.docKind }}<span v-if="r.direction" class="text-grey"> / {{ r.direction }}</span></td>
                <td class="text-center">
                  <span :class="r.unmatched ? 'text-error font-weight-medium' : 'text-success'">{{ r.matched }}/{{ r.total }}</span>
                </td>
                <td class="text-caption">
                  <div v-if="r.error" class="text-error">{{ r.error }}</div>
                  <v-chip v-if="r.committed" size="x-small" color="success" label class="mr-1 mb-1">{{ $t('files.status.committed') }}</v-chip>
                  <v-chip v-if="r.duplicate" size="x-small" color="orange" label class="mr-1 mb-1">{{ $t('files.review.duplicate') }}</v-chip>
                  <v-chip v-if="r.draftSource === 'parsed'" size="x-small" color="primary" label class="mr-1 mb-1" :title="$t('files.review.parsedHint')">{{ $t('files.review.parsed') }}</v-chip>
                  <div v-for="(w, i) in r.warnings" :key="i" :class="/VERIFY/i.test(w) ? 'text-error font-weight-medium' : 'text-warning'">⚠ {{ w }}</div>
                </td>
              </tr>
              <tr v-if="expandedDocs.has(r.docFileId)">
                <td colspan="6" class="pa-0">
                  <v-table density="compact" class="bg-grey-lighten-5">
                    <thead><tr>
                      <th style="width:44px">#</th>
                      <th>{{ $t('docImport.description') }}</th>
                      <th>{{ $t('docImport.product') }}</th>
                      <th class="text-end">{{ $t('files.col.qty') }}</th>
                      <th class="text-end">{{ $t('files.col.price') }}</th>
                      <th>{{ $t('files.review.warnings') }}</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="l in r.lines" :key="l.index" :class="l.severity === 'error' ? 'bg-red-lighten-5' : l.severity === 'warning' ? 'bg-amber-lighten-5' : ''">
                        <td class="text-caption">{{ l.index + 1 }}</td>
                        <td class="text-caption">{{ l.sourceText }}</td>
                        <td class="text-caption">
                          <span v-if="l.matched">{{ l.productName }}</span>
                          <v-chip v-else-if="l.willCreate" size="x-small" color="info" label>{{ $t('files.review.willCreate') }}</v-chip>
                          <v-chip v-else size="x-small" color="error" label>{{ $t('docImport.unmatchedN', { n: 1 }) }}</v-chip>
                          <v-chip v-if="l.matchedBy" size="x-small" variant="text" class="ml-1">{{ l.matchedBy }}</v-chip>
                        </td>
                        <td class="text-caption text-end">{{ l.quantity ?? '—' }}</td>
                        <td class="text-caption text-end">{{ l.unitPrice ?? '—' }}</td>
                        <td class="text-caption">
                          <div v-for="(m, i) in l.messages" :key="i" :class="l.severity === 'error' ? 'text-error' : 'text-warning'">{{ m }}</div>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                </td>
              </tr>
              </template>
            </tbody>
          </v-table>
        </v-card-text>
        <v-divider />
        <v-card-actions class="flex-wrap ga-2 px-4">
          <v-checkbox v-model="options.adjustStock" :label="$t('files.batch.adjustStock')" density="compact" hide-details />
          <v-checkbox v-model="options.allowDuplicate" :label="$t('files.batch.allowDuplicate')" density="compact" hide-details />
          <v-spacer />
          <v-btn variant="text" @click="reviewOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!commitSel.size" prepend-icon="mdi-database-check" @click="commitReviewed">
            {{ $t('files.review.commitSelected', { n: commitSel.size }) }}
          </v-btn>
        </v-card-actions>
        <v-progress-linear v-if="busy" :model-value="progress" color="primary" height="4" />
      </v-card>
    </v-dialog>

    <!-- Delete + rollback dialog (manifest → confirm) -->
    <v-dialog v-model="deleteOpen" max-width="1000" scrollable>
      <v-card v-if="deletePlan">
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">{{ $t('files.delete.title') }}</span>
          <v-spacer />
          <div class="d-flex ga-2">
            <v-chip size="small" label>{{ $t('files.delete.docs') }}: {{ deletePlan.totals.docs }}</v-chip>
            <v-chip v-if="deletePlan.totals.invoices" size="small" color="warning" label>{{ $t('files.delete.voidInvoices') }}: {{ deletePlan.totals.invoices }}</v-chip>
            <v-chip v-if="deletePlan.totals.movements" size="small" color="warning" label>{{ $t('files.delete.reverseMovements') }}: {{ deletePlan.totals.movements }}</v-chip>
            <v-chip v-if="deletePlan.totals.products" size="small" color="error" label>{{ $t('files.delete.products') }}: {{ deletePlan.totals.products }}</v-chip>
          </div>
        </v-card-title>
        <v-card-text style="max-height:60vh">
          <v-alert v-if="deletePlan.executed" :type="(deletePlan.warnings || []).length ? 'warning' : 'success'" density="compact" variant="tonal" class="mb-3">
            {{ $t('files.delete.done', { n: (deletePlan.deleted || []).length }) }}
            <span v-if="(deletePlan.reversals || []).length"> · {{ $t('files.delete.reversalsBooked') }}: {{ (deletePlan.reversals || []).join(', ') }}</span>
            <div v-for="(w, i) in deletePlan.warnings || []" :key="i" class="text-caption">⚠ {{ w }}</div>
          </v-alert>
          <v-alert v-else type="warning" density="compact" variant="tonal" class="mb-3">{{ $t('files.delete.warning') }}</v-alert>

          <v-alert v-if="hasProvenanceMismatch" type="error" density="compact" variant="tonal" class="mb-3">
            {{ $t('files.delete.provenance') }}
          </v-alert>

          <v-table density="compact">
            <thead><tr>
              <th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th><th>{{ $t('files.col.date') }}</th>
              <th>{{ $t('files.delete.willRollBack') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="p in deletePlan.plans" :key="p.docFileId">
                <td><v-chip size="x-small" label>{{ p.docType }}</v-chip></td>
                <td class="text-caption">{{ p.docNumber }}</td>
                <td class="text-caption">{{ p.docDate }}</td>
                <td class="text-caption">
                  <span v-if="p.blocked" class="text-error">{{ p.blocked }}</span>
                  <template v-else>
                    <v-chip v-for="i in p.invoices" :key="i.id" size="x-small" :color="i.action === 'void' ? 'warning' : 'grey'" label class="mr-1 mb-1">{{ i.number }} · {{ i.action }}</v-chip>
                    <v-chip v-for="m in p.movements" :key="m.id" size="x-small" :color="m.action === 'reverse' ? 'warning' : 'grey'" label class="mr-1 mb-1">{{ m.number }} · {{ m.action }}</v-chip>
                    <v-chip v-for="pr in p.products" :key="pr.id" size="x-small" :color="pr.action === 'deactivate' ? 'error' : 'grey'" label class="mr-1 mb-1">{{ pr.sku }} · {{ pr.action }}</v-chip>
                    <span v-if="!p.invoices.length && !p.movements.length" class="text-grey">{{ $t('files.delete.nothingBooked') }}</span>
                  </template>
                  <div v-for="(w, i) in p.warnings" :key="i" class="text-warning">⚠ {{ w }}</div>
                </td>
              </tr>
            </tbody>
          </v-table>

          <div v-if="(deletePlan.stockImpact || []).length" class="mt-4">
            <div class="text-subtitle-2 mb-1">{{ $t('files.delete.stockImpact') }}</div>
            <v-table density="compact">
              <thead><tr>
                <th>{{ $t('files.col.sku') }}</th><th>{{ $t('files.col.name') }}</th>
                <th class="text-right">{{ $t('files.delete.current') }}</th><th class="text-right">Δ</th><th class="text-right">{{ $t('files.delete.after') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="s in (deletePlan.stockImpact || []).slice(0, 40)" :key="s.productId">
                  <td class="text-caption">{{ s.sku }}</td>
                  <td class="text-caption">{{ s.name }}</td>
                  <td class="text-right">{{ s.current }}</td>
                  <td class="text-right" :class="s.delta > 0 ? 'text-success' : 'text-error'">{{ s.delta > 0 ? '+' : '' }}{{ s.delta }}</td>
                  <td class="text-right" :class="s.negative ? 'text-error font-weight-bold' : ''">{{ s.after }}</td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions class="flex-wrap ga-2 px-4">
          <v-checkbox v-model="delOptions.rollback" :label="$t('files.delete.optRollback')" density="compact" hide-details @update:model-value="planDelete" />
          <v-checkbox v-model="delOptions.removeProducts" :label="$t('files.delete.optProducts')" density="compact" hide-details @update:model-value="planDelete" />
          <v-checkbox v-if="hasProvenanceMismatch" v-model="delOptions.force" :label="$t('files.delete.optForce')" density="compact" hide-details color="error" @update:model-value="planDelete" />
          <v-spacer />
          <v-btn variant="text" @click="deleteOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn v-if="!deletePlan.executed" color="error" :loading="busy" prepend-icon="mdi-delete-forever" @click="confirmDelete">
            {{ $t('files.delete.confirm', { n: deletePlan.totals.docs }) }}
          </v-btn>
        </v-card-actions>
        <v-progress-linear v-if="busy" :model-value="progress" color="error" height="4" />
      </v-card>
    </v-dialog>

    <!-- Versions dialog -->
    <v-dialog v-model="versionsOpen" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('files.versions') }} — {{ activeDoc?.originalName }}</v-card-title>
        <v-list density="compact">
          <v-list-item v-if="versionData?.current" :title="`v${versionData.current.version} · ${versionData.current.name}`" :subtitle="$t('files.currentVersion')">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc)" target="_blank" /></template>
          </v-list-item>
          <v-divider />
          <v-list-item v-for="v in versionData?.versions || []" :key="v.name" :title="v.name" :subtitle="new Date(v.archivedAt).toLocaleString()">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc, v.name)" target="_blank" /></template>
          </v-list-item>
          <v-list-item v-if="!(versionData?.versions || []).length" :title="$t('files.noVersions')" />
        </v-list>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="versionsOpen = false">{{ $t('common.close') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const viewMode = ref<'flat' | 'date'>('flat')
const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(0)
const size = ref(25)
const search = ref('')
const docType = ref<string | null>(null)
const docDate = ref('')
const statusFilter = ref<string | null>(null)

const selected = reactive(new Set<string>())
const expandedDocs = reactive(new Set<string>())
const busy = ref(false)
const progress = ref(0)
const options = reactive({ force: false, adjustStock: true, allowDuplicate: false })

const typeItems = ['invoice', 'cash_register', 'goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations', 'store_availability', 'unknown']
const statusItems = ['uploaded', 'analyzed', 'committed', 'superseded']
const headers = [
  { title: '', key: 'select', sortable: false, width: 40 },
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.status'), key: 'status' },
  { title: t('files.col.version'), key: 'version', sortable: false },
  { title: '', key: 'actions', sortable: false },
]

function statusColor(s: string) {
  return { uploaded: 'grey', extracted: 'info', analyzed: 'warning', committed: 'success', superseded: 'error' }[s] || 'grey'
}
function base() {
  const dev = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : '/api'
  return `${dev}${appStore.orgUrl()}/files`
}
function downloadUrl(item: any, version?: string) {
  const v = version ? `?version=${encodeURIComponent(version)}` : ''
  return `${base()}/${item.docFileId || item._id}/download${v}`
}
const filterParams = () => ({ search: search.value || undefined, docType: docType.value || undefined, status: statusFilter.value || undefined })

function toggle(id: string) { selected.has(id) ? selected.delete(id) : selected.add(id) }
function clearSelection() { selected.clear() }

// ── flat ──
async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, {
      params: { page: page.value, size: size.value, ...filterParams(), docDate: docDate.value || undefined },
    })
    items.value = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
    total.value = data.total || 0
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { loading.value = false }
}
function onOptions(opts: any) { page.value = (opts.page || 1) - 1; size.value = opts.itemsPerPage || 25; reload() }

// ── by date ──
const dates = ref<any[]>([])
const datesLoading = ref(false)
const expanded = ref<string[]>([])
const dateDocs = reactive<Record<string, any[]>>({})
async function loadDates() {
  datesLoading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/dates`, { params: filterParams() })
    dates.value = data.dates || []
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { datesLoading.value = false }
}
async function loadDateDocs(date: string) {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, { params: { docDate: date, size: 500, ...filterParams() } })
    dateDocs[date] = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
  } catch { dateDocs[date] = [] }
}
// Lazy-load a date's documents when its panel opens.
watch(expanded, (open) => { for (const date of open) if (!dateDocs[date]) loadDateDocs(date) })
function dateAllSelected(date: string) { const d = dateDocs[date]; return !!d?.length && d.every((x) => selected.has(x.docFileId)) }
function dateSomeSelected(date: string) { const d = dateDocs[date]; return !!d?.some((x) => selected.has(x.docFileId)) && !dateAllSelected(date) }
async function toggleDate(date: string) {
  if (!dateDocs[date]) await loadDateDocs(date)
  const d = dateDocs[date] || []
  const all = dateAllSelected(date)
  d.forEach((x) => (all ? selected.delete(x.docFileId) : selected.add(x.docFileId)))
}

function onViewChange() { reloadAll() }
function reloadAll() { selectedResetDocsCache(); viewMode.value === 'date' ? loadDates() : reload() }
function selectedResetDocsCache() { for (const k of Object.keys(dateDocs)) delete dateDocs[k] }

// ── background job poller ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function runJob(url: string, body: any): Promise<any> {
  progress.value = 0
  const { data: started } = await httpClient.post(url, body)
  const taskId = started.taskId
  if (!taskId) return started
  for (let i = 0; i < 300; i++) {
    await sleep(2000)
    const { data: task } = await httpClient.get(`${appStore.orgUrl()}/files/task/${taskId}`)
    if (typeof task.progress === 'number') progress.value = task.progress
    if (task.status === 'completed') return task.result
    if (task.status === 'failed') throw new Error(task.error || t('common.operationFailed'))
  }
  throw new Error(t('common.operationFailed'))
}

// ── analyze → review → commit ──
const reviewOpen = ref(false)
const analyzeResults = ref<any[]>([])
const commitSel = reactive(new Set<string>())
const reviewCounts = computed(() => ({
  ok: analyzeResults.value.filter((r) => r.committable && !r.error).length,
  warn: analyzeResults.value.filter((r) => (r.warnings?.length || 0) > 0 || r.unmatched > 0).length,
  dup: analyzeResults.value.filter((r) => r.duplicate).length,
  err: analyzeResults.value.filter((r) => r.error).length,
}))
const allReviewSelected = computed(() => { const c = analyzeResults.value.filter((r) => r.committable); return !!c.length && c.every((r) => commitSel.has(r.docFileId)) })
const someReviewSelected = computed(() => commitSel.size > 0 && !allReviewSelected.value)
function toggleCommit(id: string) { commitSel.has(id) ? commitSel.delete(id) : commitSel.add(id) }
function toggleAllReview() {
  const c = analyzeResults.value.filter((r) => r.committable)
  const all = c.every((r) => commitSel.has(r.docFileId))
  commitSel.clear(); if (!all) c.forEach((r) => commitSel.add(r.docFileId))
}

function toggleExpand(id: string) { expandedDocs.has(id) ? expandedDocs.delete(id) : expandedDocs.add(id) }

/** Open the review gate on the current analyses. The reuse guard makes this instant for anything
 *  already analyzed, so it is also how a day gets committed without re-running a thing. */
async function reviewSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: false })
    openReview(res.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

/** Extract text for the selection without analyzing. Analyze does it on demand anyway, but as a
 *  separate step it can be watched, and it is the slow half for a scanned document. */
async function ocrSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/ocr-batch`, { docFileIds: [...selected], force: options.force })
    const rows = res.results || []
    showSuccess(t('files.batch.ocrDone', { ok: rows.filter((r: any) => r.ok).length, skip: rows.filter((r: any) => r.skipped).length }))
    await reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

/** The one-click run: text, then analysis, both in the canonical order (receipts before the
 *  invoices that sell what they create), stopping at the review gate. Committing stays manual. */
async function processSelected() {
  busy.value = true
  try {
    await runJob(`${appStore.orgUrl()}/files/ocr-batch`, { docFileIds: [...selected], force: false })
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: options.force })
    openReview(res.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

function openReview(results: any[]) {
  analyzeResults.value = results
  // Pre-select only what is genuinely clean. The server withholds its recommendation from any
  // document carrying a blocking warning, however well its lines matched.
  commitSel.clear()
  expandedDocs.clear()
  analyzeResults.value.forEach((r) => { if (r.recommended) commitSel.add(r.docFileId) })
  // Anything needing attention opens already expanded — that is the point of the review step.
  analyzeResults.value.forEach((r) => { if (r.hasBlocking || r.unmatched) expandedDocs.add(r.docFileId) })
  reviewOpen.value = true
}

async function analyzeSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: options.force })
    openReview(res.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

async function commitReviewed() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/commit-batch`, {
      docFileIds: [...commitSel], adjustStock: options.adjustStock, allowDuplicate: options.allowDuplicate,
    })
    const results = res.results || []
    const ok = results.filter((r: any) => r.ok).length
    const failed = results.filter((r: any) => !r.ok)
    if (failed.length) showError(t('files.review.commitPartial', { ok, fail: failed.length }))
    else showSuccess(t('files.review.commitDone', { n: ok }))
    reviewOpen.value = false
    clearSelection()
    reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

// ── delete + rollback (manifest first, then an explicit confirm) ──
const deleteOpen = ref(false)
const deletePlan = ref<any>(null)
const delOptions = reactive({ rollback: true, removeProducts: false, force: false })
const hasProvenanceMismatch = computed(() => (deletePlan.value?.plans || []).some((p: any) => p.provenanceMismatch))

async function runDelete(execute: boolean) {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/delete-batch`, {
      docFileIds: [...selected], rollback: delOptions.rollback, removeProducts: delOptions.removeProducts,
      force: delOptions.force, execute,
    })
    deletePlan.value = res
    deleteOpen.value = true
    return res
  } catch (e: any) {
    showError(e?.response?.data?.message || e?.message || t('common.operationFailed'))
    return null
  } finally { busy.value = false }
}
/** Dry run — books nothing, just shows what removal would undo. */
const planDelete = () => runDelete(false)

async function confirmDelete() {
  const res = await runDelete(true)
  if (!res) return
  if ((res.warnings || []).length) showError(t('files.delete.partial', { n: (res.deleted || []).length, w: res.warnings.length }))
  else showSuccess(t('files.delete.done', { n: (res.deleted || []).length }))
  clearSelection()
  reloadAll()
}

// ── versions ──
const versionsOpen = ref(false)
const activeDoc = ref<any>(null)
const versionData = ref<any>(null)
async function openVersions(item: any) {
  activeDoc.value = item; versionsOpen.value = true; versionData.value = null
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/files/${item._id}/versions`); versionData.value = data } catch { /* ignore */ }
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  // Arriving from the upload page: open that day straight away, which is the batch the user just
  // uploaded and wants to run.
  const day = String(route.query.docDate || '')
  if (day) {
    viewMode.value = 'date'
    await loadDates()
    expanded.value = [day]
    return
  }
  reload()
})
</script>
