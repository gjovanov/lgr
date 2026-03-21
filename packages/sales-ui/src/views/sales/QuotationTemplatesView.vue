<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('sales.templates') }}</h1>
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
          <template #item.lines="{ item }">{{ (item.lines || []).length }}</template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="800" persistent>
      <v-card>
        <v-card-title>{{ editId ? $t('sales.editTemplate') : $t('sales.newTemplate') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" class="mb-2" />
            <v-text-field v-model.number="form.validityDays" :label="$t('sales.validityDays')" type="number" min="0" class="mb-2" />
            <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" class="mb-2" />
            <v-textarea v-model="form.termsAndConditions" :label="$t('sales.termsAndConditions')" rows="2" class="mb-2" />
            <v-switch v-model="form.isActive" :label="$t('common.active')" color="success" class="mb-2" />

            <!-- Template Lines -->
            <div class="d-flex align-center mb-2">
              <p class="text-subtitle-2 font-weight-bold">{{ $t('sales.lineItems') }}</p>
              <v-spacer />
              <v-btn size="small" variant="outlined" prepend-icon="mdi-plus" @click="addTemplateLine">{{ $t('sales.addLine') }}</v-btn>
            </div>
            <v-table density="compact" v-if="form.lines.length">
              <thead>
                <tr>
                  <th>{{ $t('common.description') }}</th>
                  <th class="text-end" style="width:100px">{{ $t('sales.qty') }}</th>
                  <th class="text-end" style="width:100px">{{ $t('sales.discount') }}</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td>
                    <v-text-field v-model="line.name" density="compact" hide-details variant="underlined" />
                  </td>
                  <td>
                    <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" />
                  </td>
                  <td>
                    <v-text-field v-model.number="line.discount" type="number" min="0" max="100" suffix="%" density="compact" hide-details variant="underlined" />
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
        <v-card-text>{{ $t('sales.deleteTemplateConfirm') }}</v-card-text>
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

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const dialog = ref(false)
const deleteDialog = ref(false)
const saving = ref(false)
const editId = ref<string | null>(null)
const deleteId = ref('')
const formRef = ref()

interface TemplateLine {
  name: string
  quantity: number
  discount: number
  productId?: string
}

const form = reactive({
  name: '',
  validityDays: 30,
  notes: '',
  termsAndConditions: '',
  isActive: true,
  lines: [] as TemplateLine[],
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const url = computed(() => `${appStore.orgUrl()}/sales/templates`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'templates',
  defaultSize: 50,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('sales.lineCount'), key: 'lines', sortable: false },
  { title: t('sales.validityDays'), key: 'validityDays', sortable: false },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function resetForm() {
  form.name = ''
  form.validityDays = 30
  form.notes = ''
  form.termsAndConditions = ''
  form.isActive = true
  form.lines = []
}

function openDialog(item?: any) {
  if (item) {
    editId.value = item._id || item.id
    form.name = item.name || ''
    form.validityDays = item.validityDays || 30
    form.notes = item.notes || ''
    form.termsAndConditions = item.termsAndConditions || ''
    form.isActive = item.isActive !== false
    form.lines = (item.lines || []).map((l: any) => ({
      name: l.name || '',
      quantity: l.quantity || 1,
      discount: l.discount || 0,
      productId: l.productId,
    }))
  } else {
    editId.value = null
    resetForm()
  }
  dialog.value = true
}

function addTemplateLine() {
  form.lines.push({ name: '', quantity: 1, discount: 0 })
}

async function handleSave() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  saving.value = true
  try {
    const payload = {
      name: form.name,
      validityDays: form.validityDays,
      notes: form.notes || undefined,
      termsAndConditions: form.termsAndConditions || undefined,
      isActive: form.isActive,
      lines: form.lines.map(l => ({
        name: l.name,
        quantity: l.quantity,
        discount: l.discount || undefined,
        productId: l.productId || undefined,
      })),
    }

    if (editId.value) {
      await httpClient.put(`${appStore.orgUrl()}/sales/templates/${editId.value}`, payload)
    } else {
      await httpClient.post(`${appStore.orgUrl()}/sales/templates`, payload)
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
    await httpClient.delete(`${appStore.orgUrl()}/sales/templates/${deleteId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    deleteDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchItems() })
</script>
