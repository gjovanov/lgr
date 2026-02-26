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

    <DataTable :headers="headers" :items="store.employees" :loading="store.loading">
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.baseSalary="{ item }">
        {{ formatCurrency(item.baseSalary) }}
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
        <v-btn icon="mdi-eye" size="small" variant="text" :to="`/employees/${item._id}`" />
      </template>
    </DataTable>

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
                <v-col cols="12"><v-text-field v-model="form.address" :label="$t('common.address')" /></v-col>
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
                <v-col cols="6"><v-text-field v-model="form.startDate" :label="$t('payroll.startDate')" type="date" /></v-col>
                <v-col cols="6">
                  <v-select v-model="form.status" :label="$t('common.status')" :items="statuses" />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <v-tabs-window-item value="salary">
              <v-row>
                <v-col cols="6">
                  <CurrencyInput v-model="form.baseSalary" :label="$t('payroll.baseSalary')" />
                </v-col>
                <v-col cols="6">
                  <v-select v-model="form.payFrequency" :label="$t('payroll.payFrequency')" :items="['Monthly', 'Bi-weekly', 'Weekly']" />
                </v-col>
                <v-col cols="6"><v-text-field v-model="form.bankAccount" :label="$t('payroll.bankAccount')" /></v-col>
                <v-col cols="6"><v-text-field v-model="form.taxId" :label="$t('payroll.taxId')" /></v-col>
              </v-row>
            </v-tabs-window-item>

            <v-tabs-window-item value="deductions">
              <v-row v-for="(ded, i) in form.deductions" :key="i" class="align-center">
                <v-col cols="4"><v-text-field v-model="ded.name" :label="$t('common.name')" /></v-col>
                <v-col cols="3"><v-select v-model="ded.type" :items="['Fixed', 'Percentage']" :label="$t('common.type')" /></v-col>
                <v-col cols="3"><v-text-field v-model.number="ded.amount" :label="$t('common.amount')" type="number" /></v-col>
                <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.deductions.splice(i, 1)" /></v-col>
              </v-row>
              <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.deductions.push({ name: '', type: 'Fixed', amount: 0 })">
                {{ $t('payroll.addDeduction') }}
              </v-btn>
            </v-tabs-window-item>

            <v-tabs-window-item value="benefits">
              <v-row v-for="(ben, i) in form.benefits" :key="i" class="align-center">
                <v-col cols="4"><v-text-field v-model="ben.name" :label="$t('common.name')" /></v-col>
                <v-col cols="3"><v-select v-model="ben.type" :items="['Fixed', 'Percentage']" :label="$t('common.type')" /></v-col>
                <v-col cols="3"><v-text-field v-model.number="ben.amount" :label="$t('common.amount')" type="number" /></v-col>
                <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.benefits.splice(i, 1)" /></v-col>
              </v-row>
              <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.benefits.push({ name: '', type: 'Fixed', amount: 0 })">
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
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import DataTable from 'ui-shared/components/DataTable'
import ExportMenu from 'ui-shared/components/ExportMenu'
import CurrencyInput from 'ui-shared/components/CurrencyInput'

const { t } = useI18n()
const store = usePayrollStore()
const { formatCurrency } = useCurrency()

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
  { title: t('payroll.baseSalary'), key: 'baseSalary', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const statuses = ['Active', 'On Leave', 'Terminated', 'Suspended']
const employmentTypes = ['Full-time', 'Part-time', 'Contract', 'Intern']
const departments = ref<any[]>([])

const emptyForm = () => ({
  _id: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  nationalId: '',
  address: '',
  employeeNumber: '',
  department: '',
  position: '',
  employmentType: 'Full-time',
  startDate: '',
  status: 'Active',
  baseSalary: 0,
  payFrequency: 'Monthly',
  bankAccount: '',
  taxId: '',
  deductions: [] as any[],
  benefits: [] as any[],
})

const form = reactive(emptyForm())

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, item)
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
  }
  tab.value = 'personal'
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    await store.saveEmployee({ ...form })
    dialog.value = false
    await store.fetchEmployees()
  } finally {
    saving.value = false
  }
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Active: 'success', 'On Leave': 'warning', Terminated: 'error', Suspended: 'grey' }
  return colors[status] || 'grey'
}

function handleExport(format: string) {
  // TODO: export implementation
}

onMounted(() => store.fetchEmployees())
</script>
