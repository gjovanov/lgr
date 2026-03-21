<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('purchase.agreements') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.vendor="{ item }">
            {{ item.vendor?.companyName || item.vendor?.name || '-' }}
          </template>
          <template #item.state="{ item }">
            <v-chip :color="item.state === 'draft' ? 'grey' : item.state === 'confirmed' ? 'success' : 'error'" size="small" variant="tonal">
              {{ $t(`purchase.state.${item.state}`) }}
            </v-chip>
          </template>
          <template #item.dateStart="{ item }">
            {{ item.dateStart ? new Date(item.dateStart).toLocaleDateString() : '-' }}
          </template>
          <template #item.dateEnd="{ item }">
            {{ item.dateEnd ? new Date(item.dateEnd).toLocaleDateString() : '-' }}
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" :disabled="item.state !== 'draft'" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900" persistent>
      <v-card>
        <v-card-title>{{ editId ? $t('purchase.editAgreement') : $t('purchase.newAgreement') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-autocomplete
                  v-model="form.vendorId"
                  :items="contacts"
                  item-title="companyName"
                  item-value="_id"
                  :label="$t('purchase.vendor')"
                  :rules="[rules.required]"
                  clearable
                />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.dateStart" :label="$t('purchase.dateStart')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.dateEnd" :label="$t('purchase.dateEnd')" type="date" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="4">
                <v-select
                  v-model="form.currency"
                  :label="$t('common.currency')"
                  :items="['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']"
                />
              </v-col>
              <v-col cols="12" md="8">
                <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="1" auto-grow />
              </v-col>
            </v-row>

            <!-- Lines -->
            <div class="d-flex align-center mb-2 mt-4">
              <p class="text-subtitle-2 font-weight-bold">{{ $t('purchase.lineItems') }}</p>
              <v-spacer />
              <v-btn size="small" variant="outlined" prepend-icon="mdi-plus" @click="addAgreementLine">{{ $t('purchase.addLine') }}</v-btn>
            </div>
            <v-table density="compact" v-if="form.lines.length">
              <thead>
                <tr>
                  <th>{{ $t('common.product') }}</th>
                  <th>{{ $t('common.description') }}</th>
                  <th class="text-end" style="width:100px">{{ $t('purchase.qty') }}</th>
                  <th class="text-end" style="width:110px">{{ $t('purchase.priceUnit') }}</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td style="min-width:180px">
                    <v-autocomplete
                      v-model="line.productId"
                      :items="products"
                      item-title="name"
                      item-value="_id"
                      density="compact"
                      hide-details
                      variant="underlined"
                      clearable
                    />
                  </td>
                  <td>
                    <v-text-field v-model="line.name" density="compact" hide-details variant="underlined" />
                  </td>
                  <td>
                    <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" />
                  </td>
                  <td>
                    <v-text-field v-model.number="line.priceUnit" type="number" min="0" step="0.01" density="compact" hide-details variant="underlined" />
                  </td>
                  <td>
                    <v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" />
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="handleSave">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirm -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('purchase.deleteAgreementConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

interface AgreementLine {
  productId?: string
  name: string
  quantity: number
  priceUnit: number
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const dialog = ref(false)
const deleteDialog = ref(false)
const saving = ref(false)
const editId = ref<string | null>(null)
const deleteId = ref('')
const formRef = ref()
const contacts = ref<any[]>([])
const products = ref<any[]>([])

const form = reactive({
  vendorId: '',
  dateStart: '',
  dateEnd: '',
  currency: 'EUR',
  notes: '',
  lines: [] as AgreementLine[],
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const url = computed(() => `${appStore.orgUrl()}/purchase/agreements`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'blanketOrders',
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('purchase.vendor'), key: 'vendor', sortable: false },
  { title: t('common.state'), key: 'state', sortable: false },
  { title: t('purchase.dateStart'), key: 'dateStart', sortable: false },
  { title: t('purchase.dateEnd'), key: 'dateEnd', sortable: false },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function resetForm() {
  form.vendorId = ''
  form.dateStart = ''
  form.dateEnd = ''
  form.currency = 'EUR'
  form.notes = ''
  form.lines = []
}

function openDialog(item?: any) {
  if (item) {
    editId.value = item._id || item.id
    form.vendorId = item.vendorId || ''
    form.dateStart = item.dateStart?.split('T')[0] || ''
    form.dateEnd = item.dateEnd?.split('T')[0] || ''
    form.currency = item.currency || 'EUR'
    form.notes = item.notes || ''
    form.lines = (item.lines || []).map((l: any) => ({
      productId: l.productId || undefined,
      name: l.name || '',
      quantity: l.quantity || 1,
      priceUnit: l.priceUnit || 0,
    }))
  } else {
    editId.value = null
    resetForm()
  }
  dialog.value = true
}

function addAgreementLine() {
  form.lines.push({ name: '', quantity: 1, priceUnit: 0 })
}

async function handleSave() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  saving.value = true
  try {
    const payload = {
      vendorId: form.vendorId,
      dateStart: form.dateStart,
      dateEnd: form.dateEnd,
      currency: form.currency,
      notes: form.notes || undefined,
      lines: form.lines.map(l => ({
        productId: l.productId || undefined,
        name: l.name,
        quantity: l.quantity,
        priceUnit: l.priceUnit,
      })),
    }

    if (editId.value) {
      await httpClient.put(`${appStore.orgUrl()}/purchase/agreements/${editId.value}`, payload)
    } else {
      await httpClient.post(`${appStore.orgUrl()}/purchase/agreements`, payload)
    }
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function confirmDelete(item: any) {
  deleteId.value = item._id || item.id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/purchase/agreements/${deleteId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    deleteDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = data.contacts || []
  } catch { /* */ }
}

async function fetchProducts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { size: 100 } })
    products.value = data.products || []
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchContacts(); fetchProducts() })
</script>
