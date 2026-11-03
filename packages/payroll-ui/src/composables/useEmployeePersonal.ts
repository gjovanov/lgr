import { computed, reactive, ref } from 'vue'
import { usePayrollStore } from '../store/payroll.store'

/**
 * FR-25 §3.12: an employee's sealed fields on a form.
 *
 * ⚠ These values never join the form's own state: `usePendingChanges` writes that to the browser's
 * storage. A record that exists is read-only until a person asks to see it, which the server records,
 * so that an empty field always means "empty" and never "not loaded".
 */
const STRING_KEYS = ['nationalId', 'dateOfBirth', 'taxId', 'iban', 'bankName', 'bankAccountNumber'] as const
const emptyAddress = () => ({ street: '', city: '', state: '', postalCode: '', country: '' })
const emptyValues = () => ({
  nationalId: '', dateOfBirth: '', taxId: '', iban: '', bankName: '', bankAccountNumber: '',
  address: emptyAddress(),
})

export function useEmployeePersonal() {
  const store = usePayrollStore()
  const values = reactive(emptyValues())
  const mask = ref('')
  const sealed = ref(false)
  const revealed = ref(false)
  const revealing = ref(false)
  let before = JSON.stringify(emptyValues())

  const editable = computed(() => !sealed.value || revealed.value)

  function reset(employee?: { nationalIdMask?: string; hasPersonal?: boolean } | null) {
    Object.assign(values, emptyValues())
    before = JSON.stringify(emptyValues())
    mask.value = employee?.nationalIdMask ?? ''
    sealed.value = !!employee?.hasPersonal
    revealed.value = false
  }

  async function reveal(employeeId: string) {
    revealing.value = true
    try {
      const opened = await store.revealEmployeePersonal(employeeId, [...STRING_KEYS, 'address'], 'edit')
      Object.assign(values, emptyValues(), opened, { address: { ...emptyAddress(), ...opened.address } })
      before = JSON.stringify(values)
      revealed.value = true
    } finally {
      revealing.value = false
    }
  }

  /** Only what changed. Emptying a field clears it, and an untouched record sends nothing at all. */
  function patch(): Record<string, unknown> | undefined {
    const was = JSON.parse(before)
    const out: Record<string, unknown> = {}
    for (const key of STRING_KEYS) {
      if (values[key] !== was[key]) out[key] = values[key] === '' ? null : values[key]
    }
    if (JSON.stringify(values.address) !== JSON.stringify(was.address)) {
      out.address = Object.values(values.address).some(Boolean) ? { ...values.address } : null
    }
    return Object.keys(out).length ? out : undefined
  }

  return { values, mask, sealed, revealed, revealing, editable, reset, reveal, patch }
}
