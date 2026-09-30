import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

/**
 * The Desktops page's data layer (FR-14.23).
 *
 * ⚠ Everything here is a thin call onto the endpoints from FR-14.18–14.22. The page is gated
 * **server-side** — portal routes have no client-side guard at all (FR-13 trap 20), so hiding the
 * menu item is cosmetics and the endpoint's `admin.settings` check is the whole control.
 */

export type DesktopPresence = 'online' | 'stale' | 'offline'

export interface Desktop {
  id: string
  name: string
  nameAdminSet: boolean
  machineId: string
  installationId: string
  os?: { platform?: string; version?: string; arch?: string }
  hostname?: string
  status: 'active' | 'revoked'
  ephemeral: boolean
  appVersion?: string
  capabilities?: { fiscalBridge?: boolean; serialPorts?: string[] }
  fiscalDeviceIds: string[]
  startPath?: string
  lastSeenAt?: string
  clockSkewMs?: number
  keyEpoch: number
  enrolledAt?: string
  revokedAt?: string
  revokeReason?: string
  presence: DesktopPresence
}

export interface MintedCode {
  id: string
  code: string
  expiresAt: string
  deepLink: string
}

export interface EnrollmentKey {
  id: string
  name: string
  keyPrefix: string
  maxUses: number
  uses: number
  expiresAt?: string
  revokedAt?: string
  ephemeralTtlSec: number
  createdAt: string
}

export const useDesktopStore = defineStore('desktop', () => {
  const appStore = useAppStore()
  const base = () => `${appStore.orgUrl()}/desktops`

  const minting = ref(false)

  async function update(id: string, payload: { name?: string; fiscalDeviceIds?: string[]; startPath?: string }) {
    const { data } = await httpClient.put(`${base()}/${id}`, payload)
    return data.desktop as Desktop
  }

  async function revoke(id: string, reason?: string) {
    await httpClient.post(`${base()}/${id}/revoke`, { reason })
  }

  async function rotateKey(id: string) {
    const { data } = await httpClient.post(`${base()}/${id}/rotate-key`, {})
    return data.keyEpoch as number
  }

  /** `delivered: false` means the desktop has no live socket — not an error (FR-14.22). */
  async function requestUpdate(id: string) {
    const { data } = await httpClient.post(`${base()}/${id}/update`, {})
    return data.delivered as boolean
  }

  async function requestUpdateAll() {
    const { data } = await httpClient.post(`${base()}/update-all`, {})
    return data as { requested: number; delivered: number }
  }

  async function mintCode() {
    minting.value = true
    try {
      const { data } = await httpClient.post(`${base()}/enrollment-codes`, {})
      return data as MintedCode
    } finally {
      minting.value = false
    }
  }

  /** Polled by the Register dialog so it can close itself when the desktop appears. */
  async function codeState(id: string) {
    const { data } = await httpClient.get(`${base()}/enrollment-codes/${id}`)
    return data as { id: string; state: 'unused' | 'used' | 'expired'; expiresAt: string; usedBy?: string }
  }

  async function listKeys() {
    const { data } = await httpClient.get(`${base()}/enrollment-keys`)
    return data.enrollmentKeys as EnrollmentKey[]
  }

  async function createKey(payload: { name: string; maxUses?: number; ephemeralTtlSec?: number }) {
    const { data } = await httpClient.post(`${base()}/enrollment-keys`, payload)
    return data as { id: string; secret: string }
  }

  async function revokeKey(id: string) {
    await httpClient.delete(`${base()}/enrollment-keys/${id}`)
  }

  return { minting, update, revoke, rotateKey, requestUpdate, requestUpdateAll, mintCode, codeState, listKeys, createKey, revokeKey }
})
