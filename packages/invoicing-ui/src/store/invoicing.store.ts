import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Contact {
  _id: string
  name: string
  type: 'customer' | 'supplier' | 'both'
  email?: string
  phone?: string
  address?: string
  taxId?: string
  isActive: boolean
}

export interface Invoice {
  _id: string
  number: string
  contactId: string
  contactName?: string
  type: 'sales' | 'purchase'
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled'
  issueDate: string
  dueDate: string
  lines: InvoiceLine[]
  subtotal: number
  tax: number
  total: number
  currency: string
  paidAmount: number
  notes?: string
}

export interface InvoiceLine {
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  amount: number
}

export interface PaymentOrder {
  _id: string
  number: string
  invoiceId: string
  amount: number
  date: string
  method: string
  status: 'pending' | 'completed' | 'failed'
  reference?: string
}

export interface CashOrder {
  _id: string
  number: string
  type: 'receipt' | 'disbursement'
  amount: number
  date: string
  description: string
  contactId?: string
  status: 'draft' | 'confirmed'
}

export const useInvoicingStore = defineStore('invoicing', () => {
  const appStore = useAppStore()

  // State
  const contacts = ref<Contact[]>([])
  const invoices = ref<Invoice[]>([])
  const paymentOrders = ref<PaymentOrder[]>([])
  const cashOrders = ref<CashOrder[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const overdueInvoices = computed(() =>
    invoices.value.filter(i => i.status === 'overdue')
  )

  const totalOutstanding = computed(() =>
    invoices.value
      .filter(i => i.status !== 'paid' && i.status !== 'cancelled')
      .reduce((sum, i) => sum + (i.total - i.paidAmount), 0)
  )

  const activeContacts = computed(() =>
    contacts.value.filter(c => c.isActive)
  )

  const customers = computed(() =>
    contacts.value.filter(c => c.type === 'customer' || c.type === 'both')
  )

  const suppliers = computed(() =>
    contacts.value.filter(c => c.type === 'supplier' || c.type === 'both')
  )

  // --- Contacts ---
  async function fetchContacts(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params: filters })
      contacts.value = data.contacts
    } finally {
      loading.value = false
    }
  }

  async function createContact(payload: Partial<Contact>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/contact`, payload)
      contacts.value.push(data.contact)
      return data.contact
    } finally {
      loading.value = false
    }
  }

  async function updateContact(id: string, payload: Partial<Contact>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/invoicing/contact/${id}`, payload)
      const idx = contacts.value.findIndex(c => c._id === id)
      if (idx !== -1) contacts.value[idx] = data.contact
      return data.contact
    } finally {
      loading.value = false
    }
  }

  async function deleteContact(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/invoicing/contact/${id}`)
      contacts.value = contacts.value.filter(c => c._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Invoices ---
  async function fetchInvoices(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/invoice`, { params: filters })
      invoices.value = data.invoices
    } finally {
      loading.value = false
    }
  }

  async function createInvoice(payload: Partial<Invoice>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/invoice`, payload)
      invoices.value.unshift(data.invoice)
      return data.invoice
    } finally {
      loading.value = false
    }
  }

  async function updateInvoice(id: string, payload: Partial<Invoice>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/invoicing/invoice/${id}`, payload)
      const idx = invoices.value.findIndex(i => i._id === id)
      if (idx !== -1) invoices.value[idx] = data.invoice
      return data.invoice
    } finally {
      loading.value = false
    }
  }

  async function deleteInvoice(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/invoicing/invoice/${id}`)
      invoices.value = invoices.value.filter(i => i._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function sendInvoice(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/invoice/${id}/send`)
      const idx = invoices.value.findIndex(i => i._id === id)
      if (idx !== -1) invoices.value[idx] = data.invoice
      return data.invoice
    } finally {
      loading.value = false
    }
  }

  async function recordPayment(invoiceId: string, payment: { amount: number; method: string; date: string; reference?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/invoice/${invoiceId}/payment`, payment)
      const idx = invoices.value.findIndex(i => i._id === invoiceId)
      if (idx !== -1) invoices.value[idx] = data.invoice
      return data.payment
    } finally {
      loading.value = false
    }
  }

  // --- Payment Orders ---
  async function fetchPaymentOrders(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/payment-order`, { params: filters })
      paymentOrders.value = data.paymentOrders
    } finally {
      loading.value = false
    }
  }

  async function createPaymentOrder(payload: Partial<PaymentOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/payment-order`, payload)
      paymentOrders.value.unshift(data.paymentOrder)
      return data.paymentOrder
    } finally {
      loading.value = false
    }
  }

  async function updatePaymentOrder(id: string, payload: Partial<PaymentOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/invoicing/payment-order/${id}`, payload)
      const idx = paymentOrders.value.findIndex(p => p._id === id)
      if (idx !== -1) paymentOrders.value[idx] = data.paymentOrder
      return data.paymentOrder
    } finally {
      loading.value = false
    }
  }

  async function deletePaymentOrder(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/invoicing/payment-order/${id}`)
      paymentOrders.value = paymentOrders.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Cash Orders ---
  async function fetchCashOrders(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/cash-order`, { params: filters })
      cashOrders.value = data.cashOrders
    } finally {
      loading.value = false
    }
  }

  async function createCashOrder(payload: Partial<CashOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/cash-order`, payload)
      cashOrders.value.unshift(data.cashOrder)
      return data.cashOrder
    } finally {
      loading.value = false
    }
  }

  async function updateCashOrder(id: string, payload: Partial<CashOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/invoicing/cash-order/${id}`, payload)
      const idx = cashOrders.value.findIndex(c => c._id === id)
      if (idx !== -1) cashOrders.value[idx] = data.cashOrder
      return data.cashOrder
    } finally {
      loading.value = false
    }
  }

  async function deleteCashOrder(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/invoicing/cash-order/${id}`)
      cashOrders.value = cashOrders.value.filter(c => c._id !== id)
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    contacts,
    invoices,
    paymentOrders,
    cashOrders,
    loading,
    // Getters
    overdueInvoices,
    totalOutstanding,
    activeContacts,
    customers,
    suppliers,
    // Actions - Contacts
    fetchContacts,
    createContact,
    updateContact,
    deleteContact,
    // Actions - Invoices
    fetchInvoices,
    createInvoice,
    updateInvoice,
    deleteInvoice,
    sendInvoice,
    recordPayment,
    // Actions - Payment Orders
    fetchPaymentOrders,
    createPaymentOrder,
    updatePaymentOrder,
    deletePaymentOrder,
    // Actions - Cash Orders
    fetchCashOrders,
    createCashOrder,
    updateCashOrder,
    deleteCashOrder,
  }
})
