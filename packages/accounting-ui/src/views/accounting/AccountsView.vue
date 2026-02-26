<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.accounts') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <data-table
      :headers="headers"
      :items="store.accounts"
      :loading="store.loading"
      @click:row="openDialog($event)"
    >
      <template #item.code="{ item }">
        <span :style="{ paddingLeft: getIndent(item) + 'px' }">{{ item.code }}</span>
      </template>
      <template #item.type="{ item }">
        <v-chip size="small" :color="typeColor(item.type)">{{ item.type }}</v-chip>
      </template>
      <template #item.balance="{ item }">
        {{ formatCurrency(item.balance, currency, localeCode) }}
      </template>
      <template #item.isActive="{ item }">
        <v-icon :color="item.isActive ? 'success' : 'grey'">
          {{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}
        </v-icon>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="openDialog(item)" />
        <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
      </template>
    </data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.add') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field
              v-model="form.code"
              :label="$t('accounting.accountCode')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.name"
              :label="$t('common.name')"
              :rules="[rules.required]"
            />
            <v-select
              v-model="form.type"
              :label="$t('accounting.accountType')"
              :items="accountTypes"
              :rules="[rules.required]"
            />
            <v-select
              v-model="form.subType"
              :label="$t('accounting.subType')"
              :items="subTypeOptions"
              clearable
            />
            <v-select
              v-model="form.parentId"
              :label="$t('accounting.parentAccount')"
              :items="parentOptions"
              item-title="label"
              item-value="_id"
              clearable
            />
            <v-text-field
              v-model="form.currency"
              :label="$t('common.currency')"
            />
            <v-textarea
              v-model="form.description"
              :label="$t('common.description')"
              rows="2"
            />
            <v-switch
              v-model="form.isActive"
              :label="$t('common.active')"
              color="primary"
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">
            {{ $t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ $t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doDelete">
            {{ $t('common.delete') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore, type Account } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import DataTable from 'ui-shared/components/DataTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense']
const subTypeOptions = [
  'current_asset', 'fixed_asset', 'current_liability', 'long_term_liability',
  'retained_earnings', 'share_capital', 'operating_revenue', 'other_revenue',
  'cost_of_goods_sold', 'operating_expense', 'other_expense',
]

const emptyForm = () => ({
  code: '',
  name: '',
  type: '',
  subType: '',
  parentId: '',
  currency: '',
  description: '',
  isActive: true,
})

const form = ref(emptyForm())

const headers = computed(() => [
  { title: t('accounting.accountCode'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('accounting.accountType'), key: 'type' },
  { title: t('accounting.subType'), key: 'subType' },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.balance'), key: 'balance', align: 'end' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const parentOptions = computed(() =>
  store.accounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const rules = {
  required: (v: string) => !!v || 'Required',
}

function typeColor(type: string) {
  const colors: Record<string, string> = {
    asset: 'blue', liability: 'red', equity: 'purple', revenue: 'green', expense: 'orange',
  }
  return colors[type] || 'grey'
}

function getIndent(item: Account) {
  if (!item.parentId) return 0
  let depth = 0
  let current = item
  while (current.parentId) {
    depth++
    const parent = store.accounts.find(a => a._id === current.parentId)
    if (!parent) break
    current = parent
  }
  return depth * 20
}

function openDialog(item?: Account | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    editing.value = true
    selectedId.value = item._id as string
    form.value = {
      code: (item as Account).code,
      name: (item as Account).name,
      type: (item as Account).type,
      subType: (item as any).subType || '',
      parentId: (item as Account).parentId || '',
      currency: (item as Account).currency || '',
      description: (item as any).description || '',
      isActive: (item as Account).isActive,
    }
  } else {
    editing.value = false
    form.value = emptyForm()
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateAccount(selectedId.value, form.value)
  } else {
    await store.createAccount(form.value)
  }
  dialog.value = false
}

function confirmDelete(item: Account) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  await store.deleteAccount(selectedId.value)
  deleteDialog.value = false
}

onMounted(() => {
  store.fetchAccounts()
})
</script>
