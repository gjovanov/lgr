import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Invite {
  _id: string
  code: string
  status: string
  targetEmail?: string
  assignRole: string
  maxUses: number
  useCount: number
  expiresAt?: string
  createdAt: string
}

export interface InviteInfo {
  code: string
  orgName: string
  orgSlug: string
  inviterName: string
  isValid: boolean
  status: string
  targetEmail?: string | null
  assignRole: string
}

export const useInviteStore = defineStore('invite', () => {
  const appStore = useAppStore()
  const invites = ref<Invite[]>([])
  const inviteInfo = ref<InviteInfo | null>(null)
  const loading = ref(false)
  const total = ref(0)

  async function fetchInviteInfo(code: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`/invite/${code}`)
      inviteInfo.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function listInvites(page = 1, pageSize = 50) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/invite`, {
        params: { page, pageSize },
      })
      invites.value = data.invites
      total.value = data.total
    } finally {
      loading.value = false
    }
  }

  async function createInvite(payload: {
    targetEmail?: string
    maxUses?: number
    assignRole?: string
    expiresInHours?: number
  }) {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invite`, payload)
    invites.value.unshift(data)
    return data
  }

  async function revokeInvite(inviteId: string) {
    await httpClient.delete(`${appStore.orgUrl()}/invite/${inviteId}`)
    const idx = invites.value.findIndex(i => i._id === inviteId)
    if (idx !== -1) invites.value[idx].status = 'revoked'
  }

  return {
    invites,
    inviteInfo,
    loading,
    total,
    fetchInviteInfo,
    listInvites,
    createInvite,
    revokeInvite,
  }
})
