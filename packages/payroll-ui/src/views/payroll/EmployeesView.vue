<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.employees') }}</h1>
      <v-spacer />
      <ExportMenu class="mr-2" @export="handleExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.create') }}
      </v-btn>
    </div>

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
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.salary.baseSalary="{ item }">
        {{ formatCurrency(item.salary?.baseSalary) }}
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
        <v-btn icon="mdi-eye" size="small" variant="text" :to="`/employees/${item._id}`" />
      </template>
    </v-data-table-server>

    <v-dialog v-model="dialog" max-width="800" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('payroll.employee') }}</v-card-title>
        <v-card-text>
          <v-tabs v-model="tab">
            <v-tab value="personal">{{ $t('payroll.personalInfo') }}</v-tab>
            <v-tab value="employment">{{ $t('payroll.employmentDetails') }}</v-tab>
            <v-tab value="salary">{{ $t('payroll.salary') }}</v-tab>
            <v-tab value="deductions">{{ $t('payroll.deductions') }}</v-tab>
            <v-tab value="benefits">{{ $t('payroll.benefits') }}</v-tab>
          </v-tabs>
          <v-tabs-window v-model="tab" class="mt-6 pt-4">
            <v-tabs-window-item value="personal">
              <v-row>
                <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.email" :label="$t('common.email')" type="email" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.phone" :label="$t('common.phone')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.dateOfBirth" :label="$t('payroll.dateOfBirth')" type="date" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.nationalId" :label="$t('payroll.nationalId')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.address.street" :label="$t('payroll.street')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.address.city" :label="$t('payroll.city')" /></v-col>
                <v-col cols="4"><v-text-field v-model="form.address.state" :label="$t('payroll.state')" /></v-col>
                <v-col cols="4"><v-text-field v-model="form.address.postalCode" :label="$t('payroll.postalCode')" /></v-col>
                <v-col cols="4"><v-text-field v-model="form.address.country" :label="$t('payroll.country')" /></v-col>
              </v-row>
            </v-tabs-window-item>

            <v-tabs-window-item value="employment">
              <v-row>
                <v-col cols="6"><v-text-field v-model="form.employeeNumber" :label="$t('payroll.employeeNumber')" /></v-col>
                <v-col cols="6">
                  <v-select v-model="form.department" :label="$t('payroll.department')" :items="departments" item-title="name" item-value="_id" />
                </v-col>
                <v-col cols="6"><v-text-field v-model="form.position" :label="$t('payroll.position')" /></v-col>
                <v-col cols="6">
                  <v-select v-model="form.employmentType" :label="$t('payroll.employmentType')" :items="employmentTypes" />
                </v-col>
                <v-col cols="6"><v-text-field v-model="form.contractStartDate" :label="$t('payroll.contractStartDate')" type="date" /></v-col>
                <v-col cols="6">
                  <v-select v-model="form.status" :label="$t('common.status')" :items="statuses" />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <v-tabs-window-item value="salary">
              <v-row>
                <v-col cols="6">
                  <CurrencyInput v-model="form.salary.baseSalary" :label="$t('payroll.baseSalary')" />
                </v-col>
                <v-col cols="3">
                  <v-text-field v-model="form.salary.currency" :label="$t('payroll.currency')" />
                </v-col>
                <v-col cols="3">
                  <v-select v-model="form.salary.frequency" :label="$t('payroll.frequency')" :items="salaryFrequencies" />
                </v-col>
                <v-col cols="6"><v-text-field v-model="form.salary.bankAccountNumber" :label="$t('payroll.bankAccountNumber')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.salary.bankName" :label="$t('payroll.bankName')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.salary.iban" :label="$t('payroll.iban')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.taxId" :label="$t('payroll.taxId')" /></v-col>
              </v-row>
            </v-tabs-window-item>

            <v-tabs-window-item value="deductions">
              <v-row v-for="(ded, i) in form.deductions" :key="i" class="align-center">
                <v-col cols="3"><v-text-field v-model="ded.type" :label="$t('common.type')" /></v-col>
                <v-col cols="3"><v-text-field v-model="ded.name" :label="$t('common.name')" /></v-col>
                <v-col cols="2"><v-text-field v-model.number="ded.amount" :label="$t('common.amount')" type="number" /></v-col>
                <v-col cols="2"><v-text-field v-model.number="ded.percentage" :label="$t('common.percentage')" type="number" /></v-col>
                <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.deductions.splice(i, 1)" /></v-col>
              </v-row>
              <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.deductions.push({ type: '', name: '', amount: 0, percentage: 0 })">
                {{ $t('payroll.addDeduction') }}
              </v-btn>
            </v-tabs-window-item>

            <v-tabs-window-item value="benefits">
              <v-row v-for="(ben, i) in form.benefits" :key="i" class="align-center">
                <v-col cols="4"><v-text-field v-model="ben.name" :label="$t('common.name')" /></v-col>
                <v-col cols="3"><v-text-field v-model="ben.type" :label="$t('common.type')" /></v-col>
                <v-col cols="3"><v-text-field v-model.number="ben.value" :label="$t('common.value')" type="number" /></v-col>
                <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.benefits.splice(i, 1)" /></v-col>
              </v-row>
              <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.benefits.push({ name: '', type: '', value: 0 })">
                {{ $t('payroll.addBenefit') }}
              </v-btn>
            </v-tabs-window-item>
          </v-tabs-window>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'
import CurrencyInput from 'ui-shared/components/CurrencyInput'

const { t } = useI18n()
const store = usePayrollStore()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()

const statusFilter = ref<string | null>(null)
const departmentFilter = ref<string | null>(null)
const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  if (departmentFilter.value) f.department = departmentFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/payroll/employee`),
  entityKey: 'employees',
  filters,
})

const dialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const tab = ref('personal')

const headers = [
  { title: t('payroll.employeeNumber'), key: 'employeeNumber' },
  { title: t('common.name'), key: 'fullName' },
  { title: t('payroll.department'), key: 'departmentName' },
  { title: t('payroll.position'), key: 'position' },
  { title: t('payroll.employmentType'), key: 'employmentType' },
  { title: t('common.status'), key: 'status' },
  { title: t('payroll.baseSalary'), key: 'salary.baseSalary', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const statuses = ['active', 'on_leave', 'terminated', 'suspended']
const employmentTypes = ['full_time', 'part_time', 'contract', 'intern']
const salaryFrequencies = ['monthly', 'biweekly', 'weekly', 'hourly']
const departments = ref<any[]>([])

const emptyForm = () => ({
  _id: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  gender: '' as string,
  nationalId: '',
  taxId: '',
  address: { street: '', city: '', state: '', postalCode: '', country: '' },
  employeeNumber: '',
  department: '',
  position: '',
  managerId: '' as string,
  employmentType: 'full_time',
  contractStartDate: '',
  contractEndDate: '',
  probationEndDate: '',
  status: 'active',
  salary: { baseSalary: 0, currency: 'EUR', frequency: 'monthly', bankAccountNumber: '', bankName: '', iban: '' },
  deductions: [] as any[],
  benefits: [] as any[],
  emergencyContact: { name: '', relationship: '', phone: '' },
  notes: '',
})

const form = reactive(emptyForm())

function openDialog(item?: any) {
  const empty = emptyForm()
  if (item) {
    editing.value = true
    Object.assign(form, {
      ...empty,
      ...item,
      address: { ...empty.address, ...item.address },
      salary: { ...empty.salary, ...item.salary },
      emergencyContact: { ...empty.emergencyContact, ...item.emergencyContact },
      deductions: item.deductions?.length ? item.deductions.map((d: any) => ({ ...d })) : [],
      benefits: item.benefits?.length ? item.benefits.map((b: any) => ({ ...b })) : [],
    })
  } else {
    editing.value = false
    Object.assign(form, empty)
  }
  tab.value = 'personal'
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    await store.saveEmployee({ ...form })
    dialog.value = false
    await fetchItems()
  } finally {
    saving.value = false
  }
}

function statusColor(status: string) {
  const colors: Record<string, string> = { active: 'success', on_leave: 'warning', terminated: 'error', suspended: 'grey' }
  return colors[status] || 'grey'
}

function handleExport(format: string) {
  // TODO: export implementation
}

onMounted(() => fetchItems())
</script>
