import { defineStore } from 'pinia'
import { httpClient } from '../composables/useHttpClient'
import { useAppStore } from './app.store'

interface InviteInfo {
  code: string
  orgName: string
  orgSlug: string
  inviterName: string
  isValid: boolean
  status: string
  targetEmail: string | null
  assignRole: string
}

interface Invite {
  _id: string
  code: string
  orgId: string
  inviterId: string
  targetEmail?: string
  maxUses?: number
  useCount: number
  status: string
  assignRole: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export const useInviteStore = defineStore('invite', {
  state: () => ({
    inviteInfo: null as InviteInfo | null,
    invites: [] as Invite[],
    total: 0,
    loading: false,
    error: null as string | null,
  }),
  actions: {
    async fetchInviteInfo(code: string) {
      this.loading = true
      this.error = null
      try {
        const { data } = await httpClient.get(`/invite/${code}`)
        this.inviteInfo = data
        return data
      } catch (err: any) {
        this.error = err.response?.data?.message || 'Failed to load invite'
        throw err
      } finally {
        this.loading = false
      }
    },
    async listInvites(page = 1, pageSize = 50) {
      const appStore = useAppStore()
      const orgId = appStore.currentOrg?.id
      if (!orgId) return

      this.loading = true
      try {
        const { data } = await httpClient.get(`/org/${orgId}/invite`, {
          params: { page, pageSize },
        })
        this.invites = data.invites
        this.total = data.total
      } catch (err: any) {
        this.error = err.response?.data?.message || 'Failed to load invites'
      } finally {
        this.loading = false
      }
    },
    async createInvite(params: {
      targetEmail?: string
      maxUses?: number
      assignRole?: string
      expiresInHours?: number
    }) {
      const appStore = useAppStore()
      const orgId = appStore.currentOrg?.id
      if (!orgId) return

      const { data } = await httpClient.post(`/org/${orgId}/invite`, params)
      this.invites.unshift(data)
      this.total++
      return data
    },
    async revokeInvite(inviteId: string) {
      const appStore = useAppStore()
      const orgId = appStore.currentOrg?.id
      if (!orgId) return

      const { data } = await httpClient.delete(`/org/${orgId}/invite/${inviteId}`)
      const idx = this.invites.findIndex((i: any) => i._id === inviteId)
      if (idx !== -1) this.invites[idx] = data
      return data
    },
  },
})
