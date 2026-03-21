import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Workspace {
  _id: string
  name: string
  description?: string
  parentId?: string
  color?: string
  ownerId: string
  memberIds: string[]
  isActive: boolean
  createdAt: string
}

export interface Document {
  _id: string
  name: string
  workspaceId: string
  folderId?: string
  fileId: string
  mimeType: string
  size: number
  tags: string[]
  ownerId: string
  ownerName?: string
  accessLevel: string
  sharedWith: { userId: string; permission: string }[]
  version: number
  versions: DocumentVersion[]
  relatedEntityType?: string
  relatedEntityId?: string
  isArchived: boolean
  createdAt: string
}

export interface DocumentVersion {
  version: number
  fileId: string
  uploadedBy: string
  uploadedAt: string
  size: number
  notes?: string
}

export interface SignatureRequest {
  _id: string
  documentId: string
  documentName?: string
  state: 'draft' | 'sent' | 'completed' | 'cancelled' | 'expired'
  signers: Signer[]
  sequentialSigning: boolean
  expiryDate?: string
  reminderIntervalDays?: number
  createdBy: string
  createdAt: string
}

export interface Signer {
  email: string
  name: string
  role: string
  order: number
  state: 'waiting' | 'sent' | 'signed' | 'declined'
  signedAt?: string
}

export const useDocumentsStore = defineStore('documents', () => {
  const appStore = useAppStore()

  // State
  const workspaces = ref<Workspace[]>([])
  const documents = ref<Document[]>([])
  const signatureRequests = ref<SignatureRequest[]>([])
  const loading = ref(false)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // --- Workspaces ---
  async function fetchWorkspaces(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/documents/workspaces`, { params: filters })
      workspaces.value = data.workspaces || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createWorkspace(payload: Partial<Workspace>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/workspaces`, payload)
      workspaces.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateWorkspace(id: string, payload: Partial<Workspace>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/documents/workspaces/${id}`, payload)
      const idx = workspaces.value.findIndex(w => w._id === id)
      if (idx !== -1) workspaces.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteWorkspace(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/documents/workspaces/${id}`)
      workspaces.value = workspaces.value.filter(w => w._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Documents (Files) ---
  async function fetchDocuments(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/documents/files`, { params: filters })
      documents.value = data.documents || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createDocument(payload: Partial<Document>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/files`, payload)
      documents.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateDocument(id: string, payload: Partial<Document>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/documents/files/${id}`, payload)
      const idx = documents.value.findIndex(d => d._id === id)
      if (idx !== -1) documents.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function shareDocument(id: string, userId: string, permission: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/files/${id}/share`, { userId, permission })
      const idx = documents.value.findIndex(d => d._id === id)
      if (idx !== -1) documents.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function archiveDocument(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/files/${id}/archive`)
      const idx = documents.value.findIndex(d => d._id === id)
      if (idx !== -1) documents.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  // --- Signature Requests ---
  async function fetchSignatureRequests(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/documents/signatures`, { params: filters })
      signatureRequests.value = data.signatureRequests || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createSignatureRequest(payload: { documentId: string; signers: { email: string; name: string; role?: string; smsVerification?: boolean }[]; sequentialSigning?: boolean; expiryDate?: string; reminderIntervalDays?: number }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/signatures`, payload)
      signatureRequests.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function sendSignatureRequest(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/signatures/${id}/send`)
      const idx = signatureRequests.value.findIndex(s => s._id === id)
      if (idx !== -1) signatureRequests.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancelSignatureRequest(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/documents/signatures/${id}/cancel`)
      const idx = signatureRequests.value.findIndex(s => s._id === id)
      if (idx !== -1) signatureRequests.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    workspaces,
    documents,
    signatureRequests,
    loading,
    // Workspaces
    fetchWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    // Documents
    fetchDocuments,
    createDocument,
    updateDocument,
    shareDocument,
    archiveDocument,
    // Signatures
    fetchSignatureRequests,
    createSignatureRequest,
    sendSignatureRequest,
    cancelSignatureRequest,
  }
})
