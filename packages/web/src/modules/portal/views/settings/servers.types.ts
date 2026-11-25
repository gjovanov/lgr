/** A shop server (master) of this org as `GET /org/:orgId/nodes` answers it (`node.controller.ts`): the Servers page's row. */
import type { NodeAlarm } from 'ui-shared/composables/useNodeAlarms'

export interface ServerRow {
  id: string
  name: string
  linkLevel: 'control' | 'full'
  status: 'active' | 'revoked'
  ephemeral: boolean
  os?: { platform?: string; version?: string }
  versions?: { app?: string }
  lastSeenAt?: string
  cloneAlarm?: boolean
  /** FR-20.51 (P3-7): what the server says of this org: its database went back, its numbering is locked. */
  orgState?: { at?: string; wentBack?: { at?: string; reason: string; detail?: string }; numbering?: { since?: string; reason: string; detail?: string } } | null
  connected?: { interactive: boolean; bulk: boolean }
  /** FR-20.59: what global relays for this org on the server, and whether its admin chose that (else the link level decides). */
  relays?: { mail: boolean; mailChosen: boolean; documents: boolean; documentsChosen: boolean }
  /** FR-20.101 (P3-8): what the server's health and its mirror say needs a person (a mirror's lag: this org's only). */
  alarms?: NodeAlarm[]
  health?: {
    appVersion?: string
    diskFreeBytes?: number
    apiOk?: boolean
    /** #952: `failing` carries the helper's last `error`, `failedAt` and `nextTryAt` (none from an older server). */
    update?: { state?: string; available?: string; reason?: string; blockedWindows?: number; alarm?: boolean; error?: string; failedAt?: string; nextTryAt?: string }
    nightRestart?: { since?: string; waiting?: string; blockedNights?: number; alarm?: boolean }
  } | null
}
