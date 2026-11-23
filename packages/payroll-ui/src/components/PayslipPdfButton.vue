<template>
  <!-- #830: a payslip's PDF. One of the generic run prints on the list's own permission. A sealed one (FR-25 §3.12)
       is a reveal: it shows only to a role with `payroll-people.reveal`, asks why, and the server records that. -->
  <span v-if="sealed" v-cap="'payroll-people.reveal'">
    <v-menu>
      <template #activator="{ props: menuProps }">
        <v-btn
          v-if="wide"
          v-bind="menuProps"
          prepend-icon="mdi-file-pdf-box"
          color="error"
          variant="outlined"
          :loading="loading"
          data-testid="payslip-pdf"
        >
          {{ $t('payroll.downloadPdf') }}
        </v-btn>
        <v-btn
          v-else
          v-bind="menuProps"
          :aria-label="$t('payroll.downloadPdf')"
          :title="$t('payroll.downloadPdf')"
          icon="mdi-file-pdf-box"
          size="small"
          variant="text"
          color="error"
          :loading="loading"
          data-testid="payslip-pdf"
        />
      </template>
      <v-list density="compact" max-width="360">
        <v-list-item class="text-caption text-medium-emphasis" prepend-icon="mdi-lock">{{ $t('payroll.pdfSealedHint') }}</v-list-item>
        <v-list-item data-testid="payslip-pdf-employee_request" @click="download('employee_request')">
          <v-list-item-title>{{ $t('payroll.reasonEmployeeRequest') }}</v-list-item-title>
        </v-list-item>
        <v-list-item data-testid="payslip-pdf-audit" @click="download('audit')">
          <v-list-item-title>{{ $t('payroll.reasonAudit') }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </span>
  <span v-else v-cap="'payroll-people.view'">
    <v-btn
      v-if="wide"
      prepend-icon="mdi-file-pdf-box"
      color="error"
      variant="outlined"
      :loading="loading"
      data-testid="payslip-pdf"
      @click="download()"
    >
      {{ $t('payroll.downloadPdf') }}
    </v-btn>
    <v-btn
      v-else
      :aria-label="$t('payroll.downloadPdf')"
      :title="$t('payroll.downloadPdf')"
      icon="mdi-file-pdf-box"
      size="small"
      variant="text"
      color="error"
      :loading="loading"
      data-testid="payslip-pdf"
      @click="download()"
    />
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { decodeBlobError, triggerBlobDownload } from 'ui-shared/composables/useInvoicingExport'
import { filenameFromDisposition } from 'ui-shared/composables/useSessionDownload'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

type Reason = 'employee_request' | 'audit'

const props = defineProps<{ payslip: { _id?: string; id?: string; hasSealedAmounts?: boolean }; wide?: boolean }>()

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()
const loading = ref(false)
const sealed = computed(() => !!props.payslip.hasSealedAmounts)

/** The sheet's words, in the reader's language (`reporting/pdf/payslip.pdf.ts#PAYSLIP_PDF_LABELS`). */
function labels(): Record<string, string> {
  return {
    title: t('payroll.payslip'),
    organization: t('payroll.organization'),
    period: t('payroll.period'),
    employeeDetails: t('payroll.employee'),
    name: t('common.name'),
    employeeNumber: t('payroll.employeeNumber'),
    department: t('payroll.department'),
    position: t('payroll.position'),
    employmentType: t('payroll.employmentType'),
    earnings: t('payroll.earnings'),
    deductions: t('payroll.deductions'),
    type: t('common.type'),
    description: t('common.description'),
    amount: t('common.amount'),
    grossPay: t('payroll.grossPay'),
    totalDeductions: t('payroll.totalDeductions'),
    netPay: t('payroll.netPay'),
    paymentMethod: t('payroll.paymentMethod'),
    reference: t('payroll.reference'),
    yearToDate: t('payroll.yearToDate'),
    footnote: t('payroll.pdfFootnote'),
  }
}

async function download(reason?: Reason) {
  const id = props.payslip._id ?? props.payslip.id
  if (!id) return
  loading.value = true
  try {
    const res = await httpClient
      .post(`${appStore.orgUrl()}/payroll/payslip/${id}/pdf`, { ...(reason ? { reason } : {}), labels: labels() }, { responseType: 'blob' })
      .catch(decodeBlobError)
    triggerBlobDownload(res.data, filenameFromDisposition(res.headers['content-disposition']) || `payslip-${id}.pdf`)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}
</script>
