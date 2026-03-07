import type { Database } from 'bun:sqlite'
import { syncWithPeer } from '../transport/ws-client.js'
import { LANDiscovery, type Peer } from '../transport/lan-discovery.js'
import { getDeviceInfo } from '../change-tracker/change-log.js'

export interface SyncSchedulerOptions {
  db: Database
  orgId: string
  syncPort: number
  syncIntervalMs?: number
  discoveryPort?: number
  onSyncStart?: (peer: Peer) => void
  onSyncComplete?: (peer: Peer, stats: { sent: number; received: number; conflicts: number }) => void
  onSyncError?: (peer: Peer, error: Error) => void
  onPeerFound?: (peer: Peer) => void
  onPeerLost?: (peer: Peer) => void
}

/**
 * Manages periodic sync with discovered LAN peers.
 * Runs in the background, discovers peers, and syncs at configurable intervals.
 */
export class SyncScheduler {
  private options: Required<SyncSchedulerOptions>
  private discovery: LANDiscovery | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private syncing = false

  constructor(options: SyncSchedulerOptions) {
    this.options = {
      syncIntervalMs: 30_000, // 30 seconds default
      discoveryPort: 41234,
      onSyncStart: () => {},
      onSyncComplete: () => {},
      onSyncError: () => {},
      onPeerFound: () => {},
      onPeerLost: () => {},
      ...options,
    }
  }

  /**
   * Start the sync scheduler (discovery + periodic sync).
   */
  async start(): Promise<void> {
    const device = getDeviceInfo(this.options.db)
    if (!device) throw new Error('Device not initialized. Call setDeviceInfo() first.')

    this.discovery = new LANDiscovery({
      syncPort: this.options.syncPort,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      orgId: this.options.orgId,
      broadcastPort: this.options.discoveryPort,
    })

    await this.discovery.start({
      onPeerFound: this.options.onPeerFound,
      onPeerLost: this.options.onPeerLost,
    })

    // Start periodic sync
    this.syncTimer = setInterval(() => {
      this.syncAll()
    }, this.options.syncIntervalMs)
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.discovery?.stop()
    this.discovery = null
  }

  /**
   * Manually trigger a sync with all known peers.
   */
  async syncAll(): Promise<void> {
    if (this.syncing || !this.discovery) return
    this.syncing = true

    const peers = this.discovery.getPeers()
    for (const peer of peers) {
      try {
        this.options.onSyncStart(peer)
        const stats = await syncWithPeer({
          db: this.options.db,
          orgId: this.options.orgId,
          peerAddress: peer.address,
        })
        this.options.onSyncComplete(peer, stats)
      } catch (err: any) {
        this.options.onSyncError(peer, err)
      }
    }

    this.syncing = false
  }

  /**
   * Manually trigger a sync with a specific peer address.
   */
  async syncWithAddress(address: string): Promise<{ sent: number; received: number; conflicts: number }> {
    return syncWithPeer({
      db: this.options.db,
      orgId: this.options.orgId,
      peerAddress: address,
    })
  }

  /**
   * Get currently discovered peers.
   */
  getPeers(): Peer[] {
    return this.discovery?.getPeers() ?? []
  }

  /**
   * Check if currently syncing.
   */
  isSyncing(): boolean {
    return this.syncing
  }
}
